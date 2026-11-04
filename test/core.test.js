import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { randomKey, readMasterKey, encrypt, decrypt, makeRegistrationToken, verifyRegistrationToken } from '../src/crypto.js';
import { checkDevice, checkMessage } from '../src/validate.js';
import { makeApnsJwt } from '../src/providers/apns.js';
import { makeGoogleAssertion } from '../src/providers/fcm.js';
import { openDatabase } from '../src/db.js';
import { createWorker } from '../src/worker.js';

const master = readMasterKey(randomKey());
const project = 'd60fd39c-11b7-4f0c-9916-34d40884475c';

test('AES-GCM roundtrip and tamper detection', () => {
  const encoded = encrypt({ secret: 'hello' }, master);
  assert.deepEqual(decrypt(encoded, master), { secret: 'hello' });
  assert.throws(() => decrypt(encoded.slice(0, -3) + 'abc', master));
});
test('registration tickets are project-scoped and expire', () => {
  const token = makeRegistrationToken(project, 'user-123', master, 60, 1000);
  assert.equal(verifyRegistrationToken(token, project, master, 1020).userId, 'user-123');
  assert.equal(verifyRegistrationToken(token, 'another-project', master, 1020), null);
  assert.equal(verifyRegistrationToken(token, project, master, 1060), null);
  assert.equal(verifyRegistrationToken(token.slice(0, -2) + 'aa', project, master, 1020), null);
});
test('device validation enforces token platform and reasonable locale', () => {
  assert.equal(checkDevice({ platform: 'ios', installationId: 'test', token: 'a'.repeat(64) }).platform, 'ios');
  assert.throws(() => checkDevice({ platform: 'ios', installationId: 'x', token: 'fcm_token' }), /Invalid push token length|hexadecimal/);
  assert.throws(() => checkDevice({ platform: 'android', installationId: 'x', token: 'x'.repeat(64), locale: '<script>' }), /Invalid locale/);
});
test('message validation rejects missing target and oversized data', () => {
  assert.throws(() => checkMessage({ title: 'hi', body: 'world' }), /target/);
  assert.throws(() => checkMessage({ title: 'hi', body: 'world', target: { all: true, topic: 'news' } }), /exactly one/);
  assert.throws(() => checkMessage({ title: 'hi', body: 'world', target: { all: true }, data: { value: 1 } }), /string pairs/);
  assert.equal(checkMessage({ title: 'hi', body: 'world', target: { all: true } }).title, 'hi');
});
test('APNs JWT is signed with ES256 raw R||S signature', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { teamId: 'ABCDEFGHIJ', keyId: 'KLMNOPQRST', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const [head, body, signature] = makeApnsJwt(config, 120_000).split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url')).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(body, 'base64url')).iss, config.teamId);
  assert.equal(verify('sha256', Buffer.from(head + '.' + body), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
});
test('FCM assertion is signed with RS256', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { clientEmail: 'service@project.iam.gserviceaccount.com', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const [head, body, signature] = makeGoogleAssertion(config, 1000).split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url')).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(body, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(verify('sha256', Buffer.from(head + '.' + body), keys.publicKey, Buffer.from(signature, 'base64url')), true);
});
test('worker retries temporary errors and then accepts', async () => {
  const db = openDatabase(':memory:');
  let time = 200_000;
  db.prepare('INSERT INTO projects(id,name,key_hash,created_at) VALUES(?,?,?,?)').run(project, 'Test', 'hash', time);
  db.prepare(`INSERT INTO devices(project_id,installation_id,user_id,platform,token_cipher,token_hash,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(project, 'install', 'user', 'android', encrypt('long-long-fcm-token-123456', master), 'hash', time);
  db.prepare(`INSERT INTO messages(id,project_id,title,body,data_json,scheduled_at,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run('m1', project, 'T', 'B', '{}', time, time);
  db.prepare('INSERT INTO deliveries(message_id,device_id,next_attempt) VALUES(?,?,?)').run('m1', 1, time);
  let calls = 0;
  const worker = createWorker({ db, masterKey: master, now: () => time, transports: { send: async () => {
    calls++;
    return calls === 1 ? { ok: false, retry: true, error: 'HTTP 429' } : { ok: true, providerId: 'sent' };
  } } });
  assert.equal(await worker.tick(), 1);
  assert.equal(db.prepare('SELECT status FROM deliveries').get().status, 'queued');
  time += 11_000;
  assert.equal(await worker.tick(), 1);
  assert.equal(db.prepare('SELECT status FROM deliveries').get().status, 'accepted');
  assert.equal(calls, 2);
  db.close();
});
