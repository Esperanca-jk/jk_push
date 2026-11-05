import http2 from 'node:http2';
import { createHash, sign } from 'node:crypto';

const jwtCache = new Map();
const encode = payload => Buffer.from(JSON.stringify(payload)).toString('base64url');

export function makeApnsJwt(config, now = Date.now()) {
  // Include the key fingerprint so credential rotations never reuse an old JWT.
  const cacheKey = `${config.teamId}:${config.keyId}:${createHash('sha256').update(config.privateKey).digest('hex')}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && cached.expires > now) return cached.token;
  const payload = encode({ iss: config.teamId, iat: Math.floor(now / 1000) });
  const header = encode({ alg: 'ES256', kid: config.keyId });
  const signingInput = header + '.' + payload;
  const sig = sign('sha256', Buffer.from(signingInput), { key: config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = signingInput + '.' + sig;
  jwtCache.set(cacheKey, { token, expires: now + 45 * 60_000 });
  if (jwtCache.size > 100) jwtCache.clear();
  return token;
}

export function buildApnsRequest(config, device, message, now = Date.now()) {
  const options = JSON.parse(message.options_json || '{}');
  const aps = { alert: { title: message.title, body: message.body } };
  if (options.sound !== undefined) aps.sound = options.sound;
  else aps.sound = 'default';
  if (options.badge !== undefined) aps.badge = options.badge;
  const expiry = options.ttlSeconds === 0 ? 0 : Math.floor(now / 1000) + (options.ttlSeconds ?? 86400);
  const headers = {
    ':method': 'POST', ':path': '/3/device/' + encodeURIComponent(device.token),
    'content-type': 'application/json', authorization: 'bearer ' + makeApnsJwt(config, now),
    'apns-push-type': 'alert', 'apns-topic': config.bundleId,
    'apns-priority': options.priority === 'normal' ? '5' : '10',
    'apns-expiration': String(expiry)
  };
  if (options.collapseKey) headers['apns-collapse-id'] = options.collapseKey;
  const custom = JSON.parse(message.data_json || '{}');
  // Never allow old or manually inserted data to override the required aps object.
  delete custom.aps;
  return { headers, payload: JSON.stringify({ ...custom, aps }) };
}

// Persistent sessions are preferable to creating one TLS + HTTP/2 connection per device.
const sessions = new Map();
function sessionFor(host) {
  const current = sessions.get(host);
  if (current && !current.closed && !current.destroyed) return current;
  const session = http2.connect(host, { settings: { enablePush: false } });
  sessions.set(host, session);
  const discard = () => { if (sessions.get(host) === session) sessions.delete(host); };
  session.on('error', discard);
  session.on('goaway', () => { discard(); session.close(); });
  session.on('close', discard);
  // Keep unreferenced idle connections from pinning short-lived processes.
  session.unref?.();
  return session;
}

export async function sendApns(config, device, message) {
  if (!config?.teamId || !config?.keyId || !config?.bundleId || !config?.privateKey) {
    return { ok: false, retry: false, error: 'APNs credentials not configured' };
  }
  const host = device.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  let request;
  try { request = buildApnsRequest(config, device, message); }
  catch { return { ok: false, retry: false, error: 'Invalid APNs credentials or payload' }; }
  return new Promise(resolve => {
    let done = false;
    let stream;
    let timer;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      const session = sessionFor(host);
      stream = session.request(request.headers);
      let status = 0;
      let providerId = null;
      const parts = [];
      let size = 0;
      timer = setTimeout(() => {
        try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        finish({ ok: false, retry: true, error: 'APNs request timed out' });
      }, 10_000);
      stream.on('response', headers => { status = Number(headers[':status']); providerId = headers['apns-id'] ?? null; });
      stream.on('data', chunk => { if (size < 2048) { parts.push(chunk.subarray(0, 2048 - size)); size += chunk.length; } });
      stream.on('end', () => {
        let reason = null;
        try { reason = JSON.parse(Buffer.concat(parts).toString()).reason; } catch {}
        if (status === 200) return finish({ ok: true, providerId });
        const invalid = status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
        finish({ ok: false, retry: status === 429 || status >= 500 || status === 0,
          invalid, error: 'APNs ' + status + (reason ? ': ' + reason : '') });
      });
      stream.on('error', error => finish({ ok: false, retry: true, error: 'APNs request failed: ' + (error.code ?? 'network') }));
      stream.on('close', () => { if (!done) finish({ ok: false, retry: true, error: 'APNs stream closed before a response' }); });
      stream.end(request.payload);
    } catch (error) {
      finish({ ok: false, retry: true, error: 'APNs connection failed: ' + (error.code ?? 'network') });
    }
  });
}
