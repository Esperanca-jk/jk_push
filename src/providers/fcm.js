import { createHash, sign } from 'node:crypto';

const tokens = new Map();
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function makeGoogleAssertion(config, nowSeconds = Math.floor(Date.now() / 1000)) {
  const head = encode({ alg: 'RS256', typ: 'JWT' });
  const body = encode({ iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: nowSeconds, exp: nowSeconds + 3600 });
  const input = head + '.' + body;
  return input + '.' + sign('sha256', Buffer.from(input), config.privateKey).toString('base64url');
}

async function accessToken(config) {
  const fingerprint = createHash('sha256').update(config.privateKey).digest('hex');
  const key = `${config.clientEmail}:${config.projectId}:${fingerprint}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  const assertion = makeGoogleAssertion(config);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!response.ok) {
    const error = new Error('Google OAuth returned ' + response.status);
    error.retry = response.status === 429 || response.status >= 500;
    throw error;
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('Google OAuth response had no access token');
  tokens.set(key, { token: data.access_token, expires: Date.now() + Math.max(0, Number(data.expires_in ?? 3600) - 120) * 1000 });
  if (tokens.size > 100) tokens.clear();
  return data.access_token;
}

export function buildFcmMessage(device, message) {
  const options = JSON.parse(message.options_json || '{}');
  const android = {
    priority: options.priority === 'normal' ? 'NORMAL' : 'HIGH',
    ttl: `${options.ttlSeconds ?? 86400}s`
  };
  if (options.collapseKey) android.collapse_key = options.collapseKey;
  if (options.channelId || options.sound) {
    android.notification = {};
    if (options.channelId) android.notification.channel_id = options.channelId;
    if (options.sound) android.notification.sound = options.sound;
  }
  return { message: {
    token: device.token,
    notification: { title: message.title, body: message.body },
    data: JSON.parse(message.data_json || '{}'), android
  } };
}

export async function sendFcm(config, device, message) {
  if (!config?.projectId || !config?.clientEmail || !config?.privateKey) {
    return { ok: false, retry: false, error: 'FCM credentials not configured' };
  }
  try {
    const oauth = await accessToken(config);
    const response = await fetch('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(config.projectId) + '/messages:send', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: 'Bearer ' + oauth, 'content-type': 'application/json' },
      body: JSON.stringify(buildFcmMessage(device, message))
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, providerId: result.name ?? null };
    const codes = (result.error?.details ?? []).map(detail => detail.errorCode).filter(Boolean);
    const reason = codes[0] ?? result.error?.status ?? 'UNKNOWN';
    // FCM INVALID_ARGUMENT may indicate an invalid payload, not an invalid device.
    const invalid = reason === 'UNREGISTERED';
    return { ok: false, retry: response.status === 429 || response.status >= 500,
      invalid, error: 'FCM ' + response.status + ': ' + reason };
  } catch (error) {
    return { ok: false, retry: error.retry !== false,
      error: 'FCM network or authentication failure: ' + (error.code ?? error.message ?? 'unknown').slice(0,120) };
  }
}
