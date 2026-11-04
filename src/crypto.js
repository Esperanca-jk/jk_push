import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomKey = () => randomBytes(32).toString('base64url');
export const digest = input => createHash('sha256').update(input).digest('hex');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
export const secureEqual = safeEq;

export function readMasterKey(value) {
  if (!value) throw new Error('MASTER_KEY is required');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new Error('MASTER_KEY must decode to exactly 32 bytes');
  return key;
}

export function encrypt(value, masterKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decrypt(value, masterKey) {
  if (!value) return null;
  const [version, iv, tag, data] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString());
}

function signature(body, key) {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function makeRegistrationToken(projectId, userId, masterKey, lifetimeSeconds = 600, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = b64({ v: 1, projectId, userId, exp: nowSeconds + lifetimeSeconds });
  return payload + '.' + signature(payload, masterKey);
}

export function verifyRegistrationToken(token, projectId, masterKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !safeEq(parts[1], signature(parts[0], masterKey))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (payload.v !== 1 || payload.projectId !== projectId || !Number.isInteger(payload.exp) || payload.exp <= nowSeconds) return null;
    if (typeof payload.userId !== 'string' || payload.userId.length > 128) return null;
    return payload;
  } catch {
    return null;
  }
}
