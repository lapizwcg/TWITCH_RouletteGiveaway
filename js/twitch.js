import { CLIENT_ID, SCOPES } from './config.js?v=14';

const TOKEN_KEY = 'trg.token';
const STATE_KEY = 'trg.oauthState';

export function isConfigured() {
  return CLIENT_ID && !CLIENT_ID.startsWith('PASTE_');
}

export function redirectUri() {
  // Twitch сравнивает Redirect URL побуквенно, поэтому всегда используем адрес папки со слэшем на конце.
  return new URL('./', location.href).href;
}

// ---------- OAuth (implicit grant: токен приходит в #hash, сервер не нужен) ----------

export function login() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    state,
    force_verify: 'true',
  });
  location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
}

/** Забирает токен из адресной строки после редиректа с Twitch. Возвращает текст ошибки или null. */
export function consumeRedirect() {
  if (!location.hash.includes('access_token') && !location.search.includes('error')) return null;
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);

  const error = query.get('error_description') || query.get('error');
  if (error) return error;

  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!expected || hash.get('state') !== expected) return 'Ответ Twitch не прошёл проверку state. Попробуйте войти ещё раз.';

  localStorage.setItem(TOKEN_KEY, hash.get('access_token'));
  return null;
}

/** Проверяет сохранённый токен. Возвращает {token, userId, login, scopes} или null. */
export async function restoreSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!res.ok) {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
  const info = await res.json();
  return { token, userId: info.user_id, login: info.login, scopes: info.scopes || [] };
}

export async function logout(session) {
  localStorage.removeItem(TOKEN_KEY);
  if (!session) return;
  await fetch('https://id.twitch.tv/oauth2/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, token: session.token }),
  }).catch(() => {});
}

// ---------- Helix API ----------

export class Helix {
  constructor(session) {
    this.session = session;
  }

  async request(path, { method = 'GET', body } = {}) {
    const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
      method,
      headers: {
        'Client-Id': CLIENT_ID,
        Authorization: `Bearer ${this.session.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `Twitch API ${res.status}`);
    return json;
  }

  async userByLogin(login) {
    const json = await this.request(`users?login=${encodeURIComponent(login)}`);
    const u = json.data[0];
    return u ? { id: u.id, login: u.login, name: u.display_name } : null;
  }

  /** Дата начала фоллоу или null, если не фолловит. */
  async followedAt(userId) {
    const b = this.session.userId;
    const json = await this.request(`channels/followers?broadcaster_id=${b}&user_id=${userId}`);
    return json.data[0] ? new Date(json.data[0].followed_at) : null;
  }

  /** Уровень саба ('1000' | '2000' | '3000') или null. */
  async subTier(userId) {
    const b = this.session.userId;
    const json = await this.request(`subscriptions?broadcaster_id=${b}&user_id=${userId}`);
    return json.data[0]?.tier ?? null;
  }

  async sendChat(message) {
    const id = this.session.userId;
    const json = await this.request('chat/messages', {
      method: 'POST',
      body: { broadcaster_id: id, sender_id: id, message: message.slice(0, 500) },
    });
    const result = json?.data?.[0];
    if (result && !result.is_sent) throw new Error(result.drop_reason?.message || 'Сообщение не отправлено');
  }
}

// ---------- Чат (IRC через WebSocket, анонимно, только чтение) ----------

export class ChatReader {
  constructor(channel, onMessage, onStatus) {
    this.channel = channel.toLowerCase();
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.closed = false;
    this.retry = 0;
    this.connect();
  }

  connect() {
    this.onStatus('connecting');
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws.send(`JOIN #${this.channel}`);
    };
    ws.onmessage = (e) => {
      for (const line of e.data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) ws.send(line.replace('PING', 'PONG'));
        else if (line.includes(' JOIN #')) {
          this.retry = 0;
          this.onStatus('connected');
        } else if (line.includes(' PRIVMSG #')) {
          const msg = parsePrivmsg(line);
          if (msg) this.onMessage(msg);
        }
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.onStatus('reconnecting');
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.onStatus('disconnected');
  }
}

function parsePrivmsg(line) {
  // @tags :user!user@user.tmi.twitch.tv PRIVMSG #channel :text
  if (!line.startsWith('@')) return null;
  const sp = line.indexOf(' ');
  const tags = Object.fromEntries(
    line.slice(1, sp).split(';').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const rest = line.slice(sp + 1);
  const login = rest.slice(1, rest.indexOf('!'));
  const textStart = rest.indexOf(' :', rest.indexOf('PRIVMSG'));
  const text = textStart >= 0 ? rest.slice(textStart + 2) : '';
  return {
    userId: tags['user-id'],
    login,
    name: tags['display-name'] || login,
    text,
    badges: tags.badges || '',
  };
}
