import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomKey, digest, encrypt, decrypt, makeRegistrationToken, verifyRegistrationToken, secureEqual } from './crypto.js';
import { transaction } from './db.js';
import { ensure, ID, USER_ID, TOPIC, checkDevice, checkMessage } from './validate.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BEARER = /^Bearer (\S+)$/i;
function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}
async function bodyJson(req) {
  ensure(String(req.headers['content-type'] || '').startsWith('application/json'), 'Content-Type must be application/json', 415);
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    ensure(length <= 64 * 1024, 'Request body exceeds 64 KiB', 413);
    parts.push(part);
  }
  try {
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    ensure(data && typeof data === 'object' && !Array.isArray(data), 'Expected JSON object');
    return data;
  } catch (error) {
    if (error.status) throw error;
    ensure(false, 'Malformed JSON');
  }
}
function tokenFrom(req) { return BEARER.exec(String(req.headers.authorization || ''))?.[1] ?? ''; }
function requireAdmin(req, adminKey) {
  ensure(secureEqual(tokenFrom(req), adminKey), 'Unauthorized', 401);
}
function projectAuth(req, db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  ensure(project, 'Project not found', 404);
  const supplied = tokenFrom(req);
  ensure(supplied.startsWith('jk_sk_') && secureEqual(digest(supplied), project.key_hash), 'Unauthorized', 401);
  return project;
}
function clientAuth(req, projectId, masterKey) {
  const ticket = verifyRegistrationToken(tokenFrom(req), projectId, masterKey);
  ensure(ticket, 'Invalid or expired device registration token', 401);
  return ticket;
}
function validCredentials(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Expected credentials object');
  const result = {};
  if (input.apns !== undefined) {
    const c = input.apns;
    ensure(c && /^[A-Z0-9]{10}$/.test(c.teamId ?? '') && /^[A-Z0-9]{10}$/.test(c.keyId ?? '') &&
      /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(c.bundleId ?? '') &&
      typeof c.privateKey === 'string' && c.privateKey.includes('BEGIN PRIVATE KEY'), 'Invalid APNs credential fields');
    let key;
    try { key = createPrivateKey(c.privateKey); } catch {}
    ensure(key?.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1',
      'APNs privateKey must be a valid P-256 EC private key');
    result.apns = { teamId: c.teamId, keyId: c.keyId, bundleId: c.bundleId, privateKey: c.privateKey };
  }
  if (input.fcm !== undefined) {
    const c = input.fcm;
    ensure(c && /^[a-z0-9][a-z0-9-]{2,90}$/i.test(c.projectId ?? '') &&
      typeof c.clientEmail === 'string' && c.clientEmail.endsWith('.gserviceaccount.com') &&
      typeof c.privateKey === 'string' && c.privateKey.includes('BEGIN PRIVATE KEY'), 'Invalid FCM credential fields');
    let key;
    try { key = createPrivateKey(c.privateKey); } catch {}
    ensure(key?.asymmetricKeyType === 'rsa', 'FCM privateKey must be a valid RSA private key');
    result.fcm = { projectId: c.projectId, clientEmail: c.clientEmail, privateKey: c.privateKey };
  }
  ensure(Object.keys(result).length > 0, 'Specify apns or fcm credentials');
  return result;
}

export function createApi({ db, adminKey, masterKey, worker, clock = () => Date.now() }) {
  ensure(typeof adminKey === 'string' && adminKey.length >= 32 && !adminKey.startsWith('replace-'), 'ADMIN_KEY needs at least 32 random characters');
  ensure(Buffer.isBuffer(masterKey) && masterKey.length === 32, 'MASTER_KEY must be 32 bytes');
  const quotas = new Map();
  const server = createServer(async (req, res) => {
    try {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const bucket = Math.floor(clock() / 60_000);
      // Different registration tickets and project keys share the same reverse proxy IP.
      const principal = tokenFrom(req);
      const quotaKey = ip + ':' + (principal ? digest(principal).slice(0, 20) : 'anonymous');
      const quota = quotas.get(quotaKey) ?? { bucket, requests: 0 };
      if (quota.bucket !== bucket) { quota.bucket = bucket; quota.requests = 0; }
      quota.requests++;
      quotas.set(quotaKey, quota);
      if (quotas.size > 10000) quotas.clear();
      ensure(quota.requests <= 300, 'Too many requests', 429);
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method;
      let match;
      if (method === 'GET' && path === '/health') return json(res, 200, { ok: true, service: 'jk_push', status: 'ready' });
      if (method === 'GET' && (path === '/' || path === '/dashboard')) {
        const page = await readFile(join(ROOT, '..', 'dashboard', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(page);
      }
      if (method === 'POST' && path === '/v1/admin/projects') {
        requireAdmin(req, adminKey);
        const input = await bodyJson(req);
        ensure(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.length <= 80, 'Project name must have 2–80 characters');
        const id = randomUUID();
        const apiKey = 'jk_sk_' + randomKey();
        db.prepare('INSERT INTO projects(id,name,key_hash,created_at) VALUES(?,?,?,?)').run(id, input.name.trim(), digest(apiKey), clock());
        return json(res, 201, { projectId: id, name: input.name.trim(), apiKey, warning: 'Save the API key now; it will not be displayed again.' });
      }
      if (method === 'POST' && (match = /^\/v1\/admin\/projects\/([a-f0-9-]{36})\/rotate-key$/.exec(path))) {
        requireAdmin(req, adminKey);
        ensure(db.prepare('SELECT id FROM projects WHERE id=?').get(match[1]), 'Project not found', 404);
        const apiKey = 'jk_sk_' + randomKey();
        db.prepare('UPDATE projects SET key_hash=? WHERE id=?').run(digest(apiKey), match[1]);
        return json(res, 200, { projectId: match[1], apiKey, warning: 'Previous project server key has been revoked.' });
      }
      if (method === 'GET' && path === '/v1/admin/projects') {
        requireAdmin(req, adminKey);
        const rows = db.prepare(`SELECT p.id, p.name, p.created_at AS createdAt,
          COUNT(v.id) AS deviceCount FROM projects p LEFT JOIN devices v ON v.project_id=p.id
          GROUP BY p.id ORDER BY p.created_at DESC LIMIT 100`).all();
        return json(res, 200, { projects: rows });
      }
      if (method === 'PUT' && (match = /^\/v1\/admin\/projects\/([a-f0-9-]{36})\/credentials$/.exec(path))) {
        requireAdmin(req, adminKey);
        const current = db.prepare('SELECT credentials FROM projects WHERE id=?').get(match[1]);
        ensure(current, 'Project not found', 404);
        const input = await bodyJson(req);
        const update = validCredentials(input);
        const prior = current.credentials ? decrypt(current.credentials, masterKey) : {};
        const combined = { ...prior, ...update };
        db.prepare('UPDATE projects SET credentials=? WHERE id=?').run(encrypt(combined, masterKey), match[1]);
        return json(res, 200, { ok: true, providers: Object.keys(combined) });
      }
      if (method === 'GET' && (match = /^\/v1\/admin\/projects\/([a-f0-9-]{36})\/providers$/.exec(path))) {
        requireAdmin(req, adminKey);
        const project = db.prepare('SELECT credentials FROM projects WHERE id=?').get(match[1]);
        ensure(project, 'Project not found', 404);
        const creds = project.credentials ? decrypt(project.credentials, masterKey) : {};
        return json(res, 200, { apnsConfigured: !!creds.apns, fcmConfigured: !!creds.fcm });
      }
      if (method === 'DELETE' && (match = /^\/v1\/admin\/projects\/([a-f0-9-]{36})\/credentials\/(apns|fcm)$/.exec(path))) {
        requireAdmin(req, adminKey);
        const project = db.prepare('SELECT credentials FROM projects WHERE id=?').get(match[1]);
        ensure(project, 'Project not found', 404);
        const creds = project.credentials ? decrypt(project.credentials, masterKey) : {};
        delete creds[match[2]];
        db.prepare('UPDATE projects SET credentials=? WHERE id=?').run(Object.keys(creds).length ? encrypt(creds, masterKey) : null, match[1]);
        return json(res, 200, { ok: true, apnsConfigured: !!creds.apns, fcmConfigured: !!creds.fcm });
      }
      if (method === 'DELETE' && (match = /^\/v1\/admin\/projects\/([a-f0-9-]{36})$/.exec(path))) {
        requireAdmin(req, adminKey);
        ensure(req.headers['x-confirm-delete'] === match[1], 'Provide X-Confirm-Delete with the project ID', 400);
        const removed = db.prepare('DELETE FROM projects WHERE id=?').run(match[1]);
        ensure(removed.changes === 1, 'Project not found', 404);
        return json(res, 200, { ok: true, removed: 1 });
      }
      if (method === 'POST' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/registration-tokens$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const input = await bodyJson(req);
        ensure(typeof input.userId === 'string' && USER_ID.test(input.userId), 'Invalid userId');
        return json(res, 200, { token: makeRegistrationToken(match[1], input.userId, masterKey, 600, Math.floor(clock() / 1000)), expiresIn: 600 });
      }
      if (method === 'POST' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/devices$/.exec(path))) {
        const ticket = clientAuth(req, match[1], masterKey);
        const input = checkDevice(await bodyJson(req));
        const saved = transaction(db, () => {
          const tokenHash = digest(input.token);
          // A native token belongs to one app installation. Prevent stale account registrations
          // from forwarding another user's targeted messages to a newly signed-in account.
          const other = db.prepare('SELECT installation_id, user_id FROM devices WHERE project_id=? AND token_hash=? AND installation_id!=?')
            .get(match[1], tokenHash, input.installationId);
          ensure(!other || other.user_id === ticket.userId,
            'Push token is still registered to another user; remove the old registration first', 409);
          // Duplicate records for the same user/token cause duplicate notifications.
          if (other) db.prepare('DELETE FROM devices WHERE project_id=? AND installation_id=? AND user_id=?')
            .run(match[1], other.installation_id, ticket.userId);
          const upsert = db.prepare(`INSERT INTO devices(project_id,installation_id,user_id,platform,token_cipher,token_hash,environment,locale,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,installation_id) DO UPDATE SET
            user_id=excluded.user_id, platform=excluded.platform, token_cipher=excluded.token_cipher,
            token_hash=excluded.token_hash, environment=excluded.environment, locale=excluded.locale,
            enabled=1, updated_at=excluded.updated_at
            WHERE devices.user_id=excluded.user_id`).run(match[1], input.installationId, ticket.userId,
            input.platform, encrypt(input.token, masterKey), tokenHash, input.environment, input.locale, clock());
          ensure(upsert.changes === 1, 'Installation belongs to another user', 409);
          return upsert;
        });
        return json(res, 200, { ok: true, installationId: input.installationId });
      }
      if (method === 'DELETE' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/devices\/([A-Za-z0-9_-]{1,128})$/.exec(path))) {
        const ticket = clientAuth(req, match[1], masterKey);
        const done = db.prepare('DELETE FROM devices WHERE project_id=? AND installation_id=? AND user_id=?').run(match[1], match[2], ticket.userId);
        return json(res, 200, { ok: true, removed: Number(done.changes) });
      }
      if (method === 'GET' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/devices$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const query = new URL(req.url, 'http://localhost').searchParams;
        const limit = Number(query.get('limit') ?? 50);
        const after = Number(query.get('after') ?? 0);
        ensure(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(after) && after >= 0,
          'limit must be 1–100 and after must be a non-negative integer');
        const rows = db.prepare(`SELECT id, installation_id AS installationId, user_id AS userId,
          platform, environment, locale, enabled, updated_at AS updatedAt
          FROM devices WHERE project_id=? AND id>? ORDER BY id LIMIT ?`).all(match[1], after, limit + 1);
        return json(res, 200, { devices: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
      }
      if (method === 'DELETE' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/users\/([a-zA-Z0-9_.:@-]{1,128})$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const result = db.prepare('DELETE FROM devices WHERE project_id=? AND user_id=?').run(match[1], match[2]);
        return json(res, 200, { ok: true, removedDevices: Number(result.changes) });
      }
      if (method === 'POST' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/topics$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const input = await bodyJson(req);
        ensure(typeof input.installationId === 'string' && ID.test(input.installationId), 'Invalid installationId');
        ensure(typeof input.topic === 'string' && TOPIC.test(input.topic), 'Invalid topic');
        ensure(typeof input.subscribed === 'boolean', 'subscribed must be a boolean');
        const device = db.prepare('SELECT id FROM devices WHERE project_id=? AND installation_id=?').get(match[1], input.installationId);
        ensure(device, 'Device not found', 404);
        if (input.subscribed) db.prepare('INSERT OR IGNORE INTO topics(project_id,installation_id,topic) VALUES(?,?,?)').run(match[1], input.installationId, input.topic);
        else db.prepare('DELETE FROM topics WHERE project_id=? AND installation_id=? AND topic=?').run(match[1], input.installationId, input.topic);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/messages$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const raw = await bodyJson(req);
        const input = checkMessage(raw, clock());
        const idem = req.headers['idempotency-key'];
        ensure(idem === undefined || (typeof idem === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(idem)), 'Invalid Idempotency-Key');
        const requestHash = digest(JSON.stringify({ title: input.title, body: input.body, data: input.data, target: input.target, options: input.options, sendAt: raw.sendAt ?? null }));
        const created = transaction(db, () => {
          if (idem) {
            const existing = db.prepare('SELECT id, request_hash FROM messages WHERE project_id=? AND idempotency_key=?').get(match[1], idem);
            if (existing) {
              ensure(existing.request_hash === requestHash, 'Idempotency key reused with different payload', 409);
              return { messageId: existing.id, repeated: true };
            }
          }
          let sql = 'SELECT v.id FROM devices v WHERE v.project_id=? AND v.enabled=1';
          const args = [match[1]];
          const target = input.target;
          if (target.userIds) { sql += ` AND v.user_id IN (${target.userIds.map(() => '?').join(',')})`; args.push(...target.userIds); }
          if (target.installationIds) { sql += ` AND v.installation_id IN (${target.installationIds.map(() => '?').join(',')})`; args.push(...target.installationIds); }
          if (target.topic) { sql += ' AND EXISTS (SELECT 1 FROM topics t WHERE t.project_id=v.project_id AND t.installation_id=v.installation_id AND t.topic=?)'; args.push(target.topic); }
          if (target.locale) { sql += ' AND v.locale=?'; args.push(target.locale); }
          if (target.platform) { sql += ' AND v.platform=?'; args.push(target.platform); }
          sql += ' ORDER BY v.id LIMIT 10001';
          const devices = db.prepare(sql).all(...args);
          ensure(devices.length <= 10000, 'Target exceeds the 10000-device per-message safety limit', 413);
          const messageId = randomUUID();
          db.prepare(`INSERT INTO messages(id,project_id,title,body,data_json,options_json,scheduled_at,created_at,idempotency_key,request_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(messageId, match[1], input.title, input.body, JSON.stringify(input.data), JSON.stringify(input.options),
              input.scheduledAt, clock(), idem ?? null, requestHash);
          const insert = db.prepare('INSERT INTO deliveries(message_id,device_id,next_attempt) VALUES(?,?,?)');
          for (const device of devices) insert.run(messageId, device.id, Math.max(input.scheduledAt, clock()));
          return { messageId, queued: devices.length, repeated: false };
        });
        return json(res, created.repeated ? 200 : 201, created);
      }
      if (method === 'POST' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/cancel$/.exec(path))) {
        projectAuth(req, db, match[1]);
        ensure(db.prepare('SELECT id FROM messages WHERE project_id=? AND id=?').get(match[1], match[2]), 'Message not found', 404);
        const result = db.prepare("UPDATE deliveries SET status='canceled' WHERE message_id=? AND status='queued'").run(match[2]);
        return json(res, 200, { canceled: Number(result.changes), warning: 'Only queued deliveries were canceled; requests already accepted by providers cannot be recalled.' });
      }
      if (method === 'GET' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/stats$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const activeDevices = db.prepare('SELECT COUNT(*) AS count FROM devices WHERE project_id=? AND enabled=1').get(match[1]).count;
        const campaigns = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE project_id=?').get(match[1]).count;
        const deliveries = db.prepare(`SELECT d.status, COUNT(*) AS count FROM deliveries d
          JOIN messages m ON m.id=d.message_id WHERE m.project_id=? GROUP BY d.status`).all(match[1]);
        return json(res, 200, { activeDevices, campaigns, deliveryCounts: Object.fromEntries(deliveries.map(row => [row.status, row.count])) });
      }
      if (method === 'GET' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/messages$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const rows = db.prepare(`SELECT id, title, created_at AS createdAt, scheduled_at AS scheduledAt
          FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 50`).all(match[1]);
        return json(res, 200, { messages: rows });
      }
      if (method === 'GET' && (match = /^\/v1\/projects\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})$/.exec(path))) {
        projectAuth(req, db, match[1]);
        const msg = db.prepare('SELECT id,title,body,scheduled_at AS scheduledAt,created_at AS createdAt FROM messages WHERE project_id=? AND id=?').get(match[1], match[2]);
        ensure(msg, 'Message not found', 404);
        const stats = db.prepare('SELECT status, COUNT(*) AS count FROM deliveries WHERE message_id=? GROUP BY status').all(msg.id);
        return json(res, 200, { message: msg, counts: Object.fromEntries(stats.map(row => [row.status, row.count])) });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error('[api]', error.message);
      return json(res, status, { error: status >= 500 ? 'Internal server error' : error.message });
    }
  });
  return server;
}
