export function ensure(condition, message, status = 400) {
  if (!condition) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }
}
export const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const USER_ID = /^[a-zA-Z0-9_.:@-]{1,128}$/;
export const TOPIC = /^[a-zA-Z0-9_.-]{1,64}$/;
const LOCALE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/;

export function checkDevice(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Expected a device object');
  ensure(typeof input.installationId === 'string' && ID.test(input.installationId), 'Invalid installationId');
  ensure(input.platform === 'ios' || input.platform === 'android', 'platform must be ios or android');
  ensure(typeof input.token === 'string' && input.token.length >= 16 && input.token.length <= 4096, 'Invalid push token length');
  if (input.platform === 'ios') ensure(/^[a-f\d]{32,400}$/i.test(input.token), 'APNs token must be a hexadecimal device token');
  ensure(input.environment === undefined || ['production', 'sandbox'].includes(input.environment), 'Invalid APNs environment');
  ensure(input.locale === undefined || (typeof input.locale === 'string' && LOCALE.test(input.locale)), 'Invalid locale');
  return { installationId: input.installationId, platform: input.platform, token: input.token,
    environment: input.environment ?? 'production', locale: input.locale ?? null };
}

export function checkMessage(input, now = Date.now()) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Expected a message object');
  ensure(typeof input.title === 'string' && input.title.trim().length >= 1 && input.title.length <= 120, 'title must contain 1–120 characters');
  ensure(typeof input.body === 'string' && input.body.trim().length >= 1 && input.body.length <= 900, 'body must contain 1–900 characters');
  const data = input.data ?? {};
  ensure(data && typeof data === 'object' && !Array.isArray(data), 'data must be an object');
  ensure(Object.keys(data).length <= 20 && Object.entries(data).every(([key, value]) =>
    TOPIC.test(key) && !/^(?:aps$|from$|gcm|google\.|collapse_key$|message_type$)/i.test(key) &&
    typeof value === 'string' && value.length <= 512), 'data must contain up to 20 string pairs without reserved FCM keys');
  const target = input.target;
  ensure(target && typeof target === 'object' && !Array.isArray(target), 'target must be specified');
  const selectors = ['all', 'userIds', 'topic', 'installationIds'].filter(key => target[key] !== undefined);
  ensure(selectors.length === 1, 'target must have exactly one of all, userIds, topic or installationIds');
  if (target.all !== undefined) ensure(target.all === true, 'target.all must be true');
  if (target.topic !== undefined) ensure(typeof target.topic === 'string' && TOPIC.test(target.topic), 'Invalid topic');
  for (const key of ['userIds', 'installationIds']) {
    if (target[key] !== undefined) {
      const matcher = key === 'userIds' ? USER_ID : ID;
      ensure(Array.isArray(target[key]) && target[key].length > 0 && target[key].length <= 1000 &&
        target[key].every(v => typeof v === 'string' && matcher.test(v)), 'Invalid ' + key);
    }
  }
  if (target.locale !== undefined) ensure(typeof target.locale === 'string' && LOCALE.test(target.locale), 'Invalid target.locale');
  if (target.platform !== undefined) ensure(target.platform === 'ios' || target.platform === 'android', 'Invalid target.platform');
  let scheduledAt = now;
  if (input.sendAt !== undefined) {
    ensure(typeof input.sendAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.sendAt), 'sendAt must include timezone');
    scheduledAt = Date.parse(input.sendAt);
    ensure(Number.isFinite(scheduledAt) && scheduledAt >= now - 60_000 && scheduledAt < now + 365 * 86400e3, 'Invalid sendAt');
  }
  const options = input.options ?? {};
  ensure(options && typeof options === 'object' && !Array.isArray(options), 'options must be an object');
  const supported = ['ttlSeconds', 'priority', 'collapseKey', 'badge', 'sound', 'channelId'];
  ensure(Object.keys(options).every(key => supported.includes(key)), 'Unknown notification option');
  if (options.ttlSeconds !== undefined) ensure(Number.isInteger(options.ttlSeconds) && options.ttlSeconds >= 0 && options.ttlSeconds <= 2419200, 'ttlSeconds must be 0–2419200');
  if (options.priority !== undefined) ensure(['high', 'normal'].includes(options.priority), 'priority must be high or normal');
  if (options.collapseKey !== undefined) ensure(typeof options.collapseKey === 'string' && TOPIC.test(options.collapseKey), 'Invalid collapseKey');
  if (options.badge !== undefined) ensure(Number.isInteger(options.badge) && options.badge >= 0 && options.badge <= 99999, 'badge must be a non-negative integer <= 99999');
  if (options.sound !== undefined) ensure(typeof options.sound === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(options.sound), 'Invalid sound');
  if (options.channelId !== undefined) ensure(typeof options.channelId === 'string' && TOPIC.test(options.channelId), 'Invalid channelId');
  const effective = { ttlSeconds: options.ttlSeconds ?? 86400, priority: options.priority ?? 'high',
    ...(options.collapseKey !== undefined ? { collapseKey: options.collapseKey } : {}),
    ...(options.badge !== undefined ? { badge: options.badge } : {}),
    ...(options.sound !== undefined ? { sound: options.sound } : {}),
    ...(options.channelId !== undefined ? { channelId: options.channelId } : {}) };
  ensure(Buffer.byteLength(JSON.stringify({ title: input.title, body: input.body, data, options: effective }), 'utf8') <= 3800,
    'Notification payload exceeds safe size');
  return { title: input.title, body: input.body, data, target, options: effective, scheduledAt };
}
