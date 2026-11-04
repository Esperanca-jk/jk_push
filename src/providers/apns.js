import http2 from 'node:http2';
import { sign } from 'node:crypto';

const jwtCache = new Map();
const encode = payload => Buffer.from(JSON.stringify(payload)).toString('base64url');

export function makeApnsJwt(config, now = Date.now()) {
  const cacheKey = config.teamId + ':' + config.keyId;
  const cached = jwtCache.get(cacheKey);
  if (cached && cached.expires > now) return cached.token;
  const payload = encode({ iss: config.teamId, iat: Math.floor(now / 1000) });
  const header = encode({ alg: 'ES256', kid: config.keyId });
  const signingInput = header + '.' + payload;
  const sig = sign('sha256', Buffer.from(signingInput), { key: config.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = signingInput + '.' + sig;
  jwtCache.set(cacheKey, { token, expires: now + 45 * 60_000 });
  return token;
}

export async function sendApns(config, device, message) {
  if (!config?.teamId || !config?.keyId || !config?.bundleId || !config?.privateKey) {
    return { ok: false, retry: false, error: 'APNs credentials not configured' };
  }
  const host = device.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const jwt = makeApnsJwt(config);
  const payload = JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, data: JSON.parse(message.data_json) });
  return new Promise(resolve => {
    const session = http2.connect(host);
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      try { session.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { session.destroy(); } catch {}
      finish({ ok: false, retry: true, error: 'APNs request timed out' });
    }, 10_000);
    session.on('error', error => finish({ ok: false, retry: true, error: 'APNs connection failed: ' + error.code }));
    try {
      const req = session.request({
        ':method': 'POST', ':path': '/3/device/' + encodeURIComponent(device.token),
        'content-type': 'application/json', authorization: 'bearer ' + jwt,
        'apns-push-type': 'alert', 'apns-topic': config.bundleId, 'apns-priority': '10'
      });
      let status = 0;
      let providerId = null;
      const parts = [];
      req.on('response', headers => { status = Number(headers[':status']); providerId = headers['apns-id'] ?? null; });
      req.on('data', chunk => { if (parts.reduce((a, b) => a + b.length, 0) < 2048) parts.push(chunk); });
      req.on('end', () => {
        clearTimeout(timer);
        let reason = null;
        try { reason = JSON.parse(Buffer.concat(parts).toString()).reason; } catch {}
        if (status === 200) return finish({ ok: true, providerId });
        const invalid = status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
        finish({ ok: false, retry: status === 429 || status >= 500, invalid, error: 'APNs ' + status + (reason ? ': ' + reason : '') });
      });
      req.on('error', error => { clearTimeout(timer); finish({ ok: false, retry: true, error: 'APNs request failed: ' + error.code }); });
      req.end(payload);
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, retry: false, error: 'APNs setup failed: ' + error.message });
    }
  });
}
