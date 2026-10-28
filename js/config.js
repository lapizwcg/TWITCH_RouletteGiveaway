// Client ID приложения из https://dev.twitch.tv/console/apps (тип Application, не Extension).
// Это публичный идентификатор, его можно хранить в репозитории. Client Secret сюда НЕ кладём.
export const CLIENT_ID = 'kh4vwn5gx8sfqs4m32nedehkdy8ek3';

export const SCOPES = [
  'moderator:read:followers', // проверка фоллоу
  'channel:read:subscriptions', // проверка саба
  'user:write:chat', // объявления в чате
];
