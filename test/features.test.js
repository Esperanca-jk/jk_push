import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { readMasterKey, encrypt, digest } from '../src/crypto.js';
import { checkMessage } from '../src/validate.js';
import { makeApnsJwt, buildApnsRequest } from '../src/providers/apns.js';
import { buildFcmMessage } from '../src/providers/fcm.js';
import { createWorker } from '../src/worker.js';

const project = 'f60fd39c-11b7-4f0c-9916-34d40884475c';
const master = readMasterKey(randomBytes(32).toString('base64url'));

function options(message) { return JSON.stringify(checkMessage(message, 10_000).options); }
const message = { title: 'News', body: 'Open app', target: { all: true },
  options: { priority: 'normal', ttlSeconds: 3600, badge: 7, channelId: 'updates', collapseKey: 'feed', sound: 'ping' } };

test('APNs request includes badge, expiry, priority, collapse key and top-level custom data', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', bundleId: 'com.example.app',
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const result = buildApnsRequest(config, { token: 'a'.repeat(64) },
    { ...message, data_json: '{"view":"news"}', options_json: options(message) }, 1_000_000);
  const payload = JSON.parse(result.payload);
  assert.equal(result.headers['apns-priority'], '5');
  assert.equal(result.headers['apns-expiration'], '4600');
  assert.equal(result.headers['apns-collapse-id'], 'feed');
  assert.equal(payload.aps.badge, 7);
  assert.equal(payload.aps.sound, 'ping');
  assert.equal(payload.view, 'news');
  const rotated = { ...config, privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  assert.notEqual(makeApnsJwt(rotated, 1_000_000), makeApnsJwt(config, 1_000_000));
});

test('FCM request includes Android channel, expiry and collapse options', () => {
  const result = buildFcmMessage({ token: 'native-fcm-token' },
    { ...message, data_json: '{"view":"news"}', options_json: options(message) });
  assert.equal(result.message.android.priority, 'NORMAL');
  assert.equal(result.message.android.ttl, '3600s');
  assert.equal(result.message.android.collapse_key, 'feed');
  assert.equal(result.message.android.notification.channel_id, 'updates');
  assert.equal(result.message.android.notification.sound, 'ping');
  assert.deepEqual(result.message.data, { view: 'news' });
});

test('validates platform targets, user IDs, options and reserved data keys', () => {
  assert.equal(checkMessage({ title: 'Hi', body: 'test', target: { userIds: ['user:123@example.com'], platform: 'ios' } }).target.platform, 'ios');
  assert.throws(() => checkMessage({ title: 'Hi', body: 'test', target: { all: true, platform: 'web' } }), /platform/);
  assert.throws(() => checkMessage({ title: 'Hi', body: 'test', target: { all: true }, data: { 'google.foo': 'bar' } }), /reserved/);
  assert.throws(() => checkMessage({ title: 'Hi', body: 'test', target: { all: true }, options: { ttlSeconds: 2419201 } }), /ttlSeconds/);
  assert.throws(() => checkMessage({ title: 'Hi', body: 'test', target: { all: true }, options: { something: true } }), /Unknown/);
});

test('worker marks expired messages without contacting provider', async () => {
  const db = openDatabase(':memory:');
  const old = 100_000;
  db.prepare('INSERT INTO projects(id,name,key_hash,created_at) VALUES(?,?,?,?)').run(project, 'Test', 'hash', old);
  db.prepare(`INSERT INTO devices(project_id,installation_id,user_id,platform,token_cipher,token_hash,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(project, 'one', 'user', 'android', encrypt('valid-fcm-token-example-123', master), digest('valid-fcm-token-example-123'), old);
  db.prepare(`INSERT INTO messages(id,project_id,title,body,data_json,options_json,scheduled_at,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('m1', project, 'News', 'Hello', '{}', '{"ttlSeconds":60}', old, old);
  db.prepare('INSERT INTO deliveries(message_id,device_id,next_attempt) VALUES(?,?,?)').run('m1', 1, old);
  let calls = 0;
  const worker = createWorker({ db, masterKey: master, now: () => old + 61_000,
    transports: { send: async () => { calls++; return { ok: true }; } } });
  assert.equal(await worker.tick(), 1);
  assert.equal(calls, 0);
  assert.equal(db.prepare('SELECT status FROM deliveries').get().status, 'expired');
  db.close();
});

test('permanent invalid result does not disable a device that rotated its token mid-send', async () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO projects(id,name,key_hash,created_at) VALUES(?,?,?,?)').run(project, 'Test', 'hash', 1000);
  db.prepare(`INSERT INTO devices(project_id,installation_id,user_id,platform,token_cipher,token_hash,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(project, 'one', 'user', 'android', encrypt('old-native-fcm-token-123', master), digest('old-native-fcm-token-123'), 1000);
  db.prepare(`INSERT INTO messages(id,project_id,title,body,data_json,scheduled_at,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run('m1', project, 'News', 'Hello', '{}', 1000, 1000);
  db.prepare('INSERT INTO deliveries(message_id,device_id,next_attempt) VALUES(?,?,?)').run('m1', 1, 1000);
  const worker = createWorker({ db, masterKey: master, now: () => 2000,
    transports: { send: async () => {
      db.prepare('UPDATE devices SET token_hash=?, token_cipher=? WHERE id=1').run(digest('new-native-fcm-token-567'), encrypt('new-native-fcm-token-567', master));
      return { ok: false, invalid: true, retry: false, error: 'UNREGISTERED' };
    } } });
  assert.equal(await worker.tick(), 1);
  assert.equal(db.prepare('SELECT enabled FROM devices').get().enabled, 1);
  db.close();
});

test('opens and upgrades a legacy SQLite messages schema without dropping data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jk-push-migrate-'));
  const filename = join(dir, 'legacy.sqlite');
  try {
    const initial = openDatabase(filename);
    initial.exec('DROP TABLE messages');
    initial.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, data_json TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      idempotency_key TEXT, request_hash TEXT,
      UNIQUE(project_id, idempotency_key)
    )`);
    initial.prepare('INSERT INTO messages(id,project_id,title,body,data_json,scheduled_at,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('old-msg', project, 'Old', 'Message', '{}', 1000, 1000);
    initial.close();
    const migrated = openDatabase(filename);
    const record = migrated.prepare('SELECT title, options_json FROM messages WHERE id=?').get('old-msg');
    assert.equal(record.title, 'Old');
    assert.equal(record.options_json, '{}');
    migrated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
