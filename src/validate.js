export function ensure(condition, message, status = 400) {
  if (!condition) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }
}
export const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const TOPIC = /^[a-zA-Z0-9_.-]{1,64}$/;

export function checkDevice(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Expected a device object');
  ensure(typeof input.installationId === 'string' && ID.test(input.installationId), 'Invalid installationId');
  ensure(input.platform === 'ios' || input.platform === 'android', 'platform must be ios or android');
  ensure(typeof input.token === 'string' && input.token.length >= 16 && input.token.length <= 4096, 'Invalid push token length');
  if (input.platform === 'ios') ensure(/^[a-f\d]{32,400}$/i.test(input.token), 'APNs token must be a hexadecimal device token');
  ensure(input.environment === undefined || ['production', 'sandbox'].includes(input.environment), 'Invalid APNs environment');
  ensure(input.locale === undefined || (typeof input.locale === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/.test(input.locale)), 'Invalid locale');
  return { installationId: input.installationId, platform: input.platform, token: input.token,
    environment: input.environment ?? 'production', locale: input.locale ?? null };
}

export function checkMessage(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Expected a message object');
  ensure(typeof input.title === 'string' && input.title.trim().length >= 1 && input.title.length <= 120, 'title must contain 1–120 characters');
  ensure(typeof input.body === 'string' && input.body.trim().length >= 1 && input.body.length <= 900, 'body must contain 1–900 characters');
  const data = input.data ?? {};
  ensure(data && typeof data === 'object' && !Array.isArray(data), 'data must be an object');
  ensure(Object.keys(data).length <= 20 && Object.entries(data).every(([key, value]) => TOPIC.test(key) && typeof value === 'string' && value.length <= 512), 'data must contain up to 20 string pairs');
  const target = input.target;
  ensure(target && typeof target === 'object' && !Array.isArray(target), 'target must be specified');
  const selectors = ['all', 'userIds', 'topic', 'installationIds'].filter(key => target[key] !== undefined);
  ensure(selectors.length === 1, 'target must have exactly one of all, userIds, topic or installationIds');
  if (target.all !== undefined) ensure(target.all === true, 'target.all must be true');
  if (target.topic !== undefined) ensure(typeof target.topic === 'string' && TOPIC.test(target.topic), 'Invalid topic');
  for (const key of ['userIds', 'installationIds']) {
    if (target[key] !== undefined) ensure(Array.isArray(target[key]) && target[key].length > 0 && target[key].length <= 1000 && target[key].every(v => typeof v === 'string' && ID.test(v)), 'Invalid ' + key);
  }
  if (target.locale !== undefined) ensure(typeof target.locale === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/.test(target.locale), 'Invalid target.locale');
  let scheduledAt = Date.now();
  if (input.sendAt !== undefined) {
    ensure(typeof input.sendAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.sendAt), 'sendAt must include timezone');
    scheduledAt = Date.parse(input.sendAt);
    ensure(Number.isFinite(scheduledAt) && scheduledAt < Date.now() + 365 * 86400e3, 'Invalid sendAt');
  }
  ensure(Buffer.byteLength(JSON.stringify({ title: input.title, body: input.body, data }), 'utf8') <= 3000, 'Notification payload exceeds safe size');
  return { title: input.title, body: input.body, data, target, scheduledAt };
}
