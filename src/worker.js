import { decrypt } from './crypto.js';
import { transaction } from './db.js';
import { sendApns } from './providers/apns.js';
import { sendFcm } from './providers/fcm.js';

export function createWorker({ db, masterKey, mock = false, transports = {}, now = () => Date.now() }) {
  let running = false;
  let timer = null;
  const send = transports.send ?? (async (creds, device, message) => {
    if (mock) return { ok: true, providerId: 'mock:accepted' };
    return device.platform === 'ios' ? sendApns(creds?.apns, device, message) : sendFcm(creds?.fcm, device, message);
  });
  function recover() {
    db.prepare("UPDATE deliveries SET status = 'queued' WHERE status = 'processing' AND next_attempt < ?").run(now() - 5 * 60_000);
  }
  async function tick(max = 25) {
    if (running) return 0;
    running = true;
    let handled = 0;
    try {
      for (let i = 0; i < max; i++) {
        const row = transaction(db, () => {
          const due = db.prepare(`SELECT d.id, d.attempts, d.device_id,
            v.platform, v.token_cipher, v.token_hash, v.environment, v.enabled,
            m.title, m.body, m.data_json, m.options_json, m.scheduled_at, p.credentials
            FROM deliveries d
            JOIN devices v ON v.id=d.device_id
            JOIN messages m ON m.id=d.message_id
            JOIN projects p ON p.id=m.project_id
            WHERE d.status='queued' AND d.next_attempt <= ?
            ORDER BY d.next_attempt, d.id LIMIT 1`).get(now());
          if (!due) return null;
          db.prepare("UPDATE deliveries SET status='processing', next_attempt=? WHERE id=?").run(now(), due.id);
          return due;
        });
        if (!row) break;
        handled++;
        let result;
        const options = JSON.parse(row.options_json || '{}');
        if (options.ttlSeconds > 0 && now() > row.scheduled_at + options.ttlSeconds * 1000) {
          result = { ok: false, expired: true, retry: false, error: 'Notification TTL expired' };
        } else if (!row.enabled) result = { ok: false, retry: false, error: 'Device disabled' };
        else {
          try {
            const device = { platform: row.platform, environment: row.environment, token: decrypt(row.token_cipher, masterKey) };
            result = await send(decrypt(row.credentials, masterKey), device, row);
          } catch (error) {
            result = { ok: false, retry: true, error: 'Delivery failed: ' + (error.code ?? error.message ?? 'unknown').slice(0,100) };
          }
        }
        transaction(db, () => {
          const attempts = row.attempts + 1;
          let status = result.ok ? 'accepted' : result.expired ? 'expired' : 'failed';
          if (!result.ok && result.retry && attempts < 5) status = 'queued';
          const delayMs = Math.min(3600, 5 * Math.pow(2, attempts)) * 1000;
          db.prepare(`UPDATE deliveries SET status=?, attempts=?, next_attempt=?, last_error=?, provider_id=? WHERE id=?`)
            .run(status, attempts, status === 'queued' ? now() + delayMs : now(),
              result.ok ? null : String(result.error ?? 'Provider rejected request').slice(0,180),
              result.ok ? String(result.providerId ?? '').slice(0,160) : null, row.id);
          if (result.invalid) db.prepare('UPDATE devices SET enabled=0 WHERE id=? AND token_hash=?').run(row.device_id, row.token_hash);
        });
      }
    } finally { running = false; }
    return handled;
  }
  return {
    tick, recover,
    start(intervalMs = 2000) {
      recover();
      timer = setInterval(() => { tick().catch(error => console.error('[worker]', error.message)); }, intervalMs);
      timer.unref();
      return this;
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
