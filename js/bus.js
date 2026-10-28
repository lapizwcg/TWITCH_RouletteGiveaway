// Связь пульта и оверлея без сервера: BroadcastChannel + событие storage как запасной канал.
// Работает между вкладками одного браузера, а в OBS — между Custom Browser Dock и Browser Source.

const NAME = 'trg-roulette';
const STORAGE_KEY = 'trg.bus';

export function createBus(onMessage) {
  const seen = new Set();
  const deliver = (msg) => {
    if (!msg || seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    onMessage(msg);
  };

  let channel = null;
  try {
    channel = new BroadcastChannel(NAME);
    channel.onmessage = (e) => deliver(e.data);
  } catch {}

  const onStorage = (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      deliver(JSON.parse(e.newValue));
    } catch {}
  };
  window.addEventListener('storage', onStorage);

  return {
    send(type, payload = {}) {
      const msg = { id: crypto.randomUUID(), type, ...payload };
      seen.add(msg.id);
      channel?.postMessage(msg);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(msg));
      } catch {}
    },
  };
}
