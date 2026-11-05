import test from 'node:test';
import assert from 'node:assert/strict';
import { randomKey, readMasterKey } from '../src/crypto.js';
import { generateKeyPairSync } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/api.js';
import { createWorker } from '../src/worker.js';

const root = async callback => {
  const db = openDatabase(':memory:');
  const adminKey = randomKey();
  const masterKey = readMasterKey(randomKey());
  const worker = createWorker({ db, masterKey, mock: true });
  const server = createApi({ db, adminKey, masterKey, worker });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, key, data, extra = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...extra },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    return { status: response.status, data: await response.json() };
  }
  try { await callback({ request, adminKey, worker, db }); }
  finally { await new Promise(resolve => server.close(resolve)); db.close(); }
};

test('project -> registration -> device -> topic -> send -> receipt', async () => root(async ({ request, adminKey, worker }) => {
  const created = await request('POST', '/v1/admin/projects', adminKey, { name: 'Demo App' });
  assert.equal(created.status, 201);
  const { projectId, apiKey } = created.data;
  const rootPath = `/v1/projects/${projectId}`;
  assert.equal((await request('GET', '/v1/admin/projects', 'wrong')).status, 401);
  const ticket = await request('POST', rootPath + '/registration-tokens', apiKey, { userId: 'user-1' });
  assert.equal(ticket.status, 200);
  const registration = await request('POST', rootPath + '/devices', ticket.data.token, {
    installationId: 'phone-1', platform: 'android', token: 'native-fcm-token-placeholder-0001', locale: 'tr-TR'
  });
  assert.equal(registration.status, 200);
  assert.equal((await request('POST', rootPath + '/devices', 'wrong', { installationId: 'phone-2' })).status, 401);
  assert.equal((await request('POST', rootPath + '/topics', apiKey,
    { installationId: 'phone-1', topic: 'updates', subscribed: true })).status, 200);

  const msgBody = { title: 'Hello', body: 'Message', data: { view: 'home' }, target: { topic: 'updates', locale: 'tr-TR' } };
  const queued = await request('POST', rootPath + '/messages', apiKey, msgBody, { 'idempotency-key': 'message_0001' });
  assert.equal(queued.status, 201);
  assert.equal(queued.data.queued, 1);
  const duplicate = await request('POST', rootPath + '/messages', apiKey, msgBody, { 'idempotency-key': 'message_0001' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.messageId, queued.data.messageId);
  assert.equal((await request('POST', rootPath + '/messages', apiKey, { ...msgBody, title: 'Different' }, { 'idempotency-key': 'message_0001' })).status, 409);

  assert.equal(await worker.tick(), 1);
  const receipt = await request('GET', rootPath + '/messages/' + queued.data.messageId, apiKey);
  assert.equal(receipt.data.counts.accepted, 1);
  assert.equal((await request('GET', rootPath + '/messages', apiKey)).data.messages.length, 1);
  const removed = await request('DELETE', rootPath + '/devices/phone-1', ticket.data.token);
  assert.equal(removed.data.removed, 1);
  assert.equal((await request('POST', rootPath + '/messages', apiKey, { ...msgBody, target: { all: true } })).data.queued, 0);
}));

test('scheduled notification waits for due time', async () => root(async ({ request, adminKey, worker }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Scheduled App' });
  const route = `/v1/projects/${p.projectId}`;
  const { data: t } = await request('POST', route + '/registration-tokens', p.apiKey, { userId: 'person' });
  await request('POST', route + '/devices', t.token, { installationId: 'device1', platform: 'ios', token: 'b'.repeat(64) });
  const future = new Date(Date.now() + 60000).toISOString();
  const message = await request('POST', route + '/messages', p.apiKey, { title: 'Later', body: 'Not yet', sendAt: future, target: { all: true } });
  assert.equal(message.status, 201);
  assert.equal(await worker.tick(), 0);
  const receipt = await request('GET', route + '/messages/' + message.data.messageId, p.apiKey);
  assert.equal(receipt.data.counts.queued, 1);
}));

test('credentials require admin auth and ciphertext storage', async () => root(async ({ request, adminKey, db }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Secure Store' });
  const path = `/v1/admin/projects/${p.projectId}/credentials`;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fake = { fcm: { projectId: 'test-project', clientEmail: 'abc@test-project.iam.gserviceaccount.com', privateKey: pem } };
  assert.equal((await request('PUT', path, p.apiKey, fake)).status, 401);
  assert.equal((await request('PUT', path, adminKey, fake)).status, 200);
  const value = db.prepare('SELECT credentials FROM projects WHERE id=?').get(p.projectId).credentials;
  assert.equal(value.includes(pem), false);
}));

test('cancel scheduled messages, fetch stats and rotate API key', async () => root(async ({ request, adminKey, db }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Controls App' });
  const route = `/v1/projects/${p.projectId}`;
  const { data: t } = await request('POST', route + '/registration-tokens', p.apiKey, { userId: 'person' });
  await request('POST', route + '/devices', t.token, { installationId: 'device2', platform: 'android', token: 'long-fcm-device-token-test-12345' });
  const message = await request('POST', route + '/messages', p.apiKey, {
    title: 'Scheduled', body: 'Not sent', target: { all: true }, sendAt: new Date(Date.now() + 100_000).toISOString()
  });
  assert.equal(message.status, 201);
  const canceled = await request('POST', route + '/messages/' + message.data.messageId + '/cancel', p.apiKey);
  assert.equal(canceled.data.canceled, 1);
  const stats = await request('GET', route + '/stats', p.apiKey);
  assert.equal(stats.data.activeDevices, 1);
  assert.equal(stats.data.deliveryCounts.canceled, 1);
  const rotated = await request('POST', '/v1/admin/projects/' + p.projectId + '/rotate-key', adminKey);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.apiKey, p.apiKey);
  assert.equal((await request('GET', route + '/stats', p.apiKey)).status, 401);
  assert.equal((await request('GET', route + '/stats', rotated.data.apiKey)).status, 200);
}));

test('installation cannot be reassigned to a different user', async () => root(async ({ request, adminKey, db }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Ownership' });
  const rootPath = `/v1/projects/${p.projectId}`;
  const a = await request('POST', rootPath + '/registration-tokens', p.apiKey, { userId: 'user-a' });
  const b = await request('POST', rootPath + '/registration-tokens', p.apiKey, { userId: 'user-b' });
  const device = { installationId: 'install-123', platform: 'ios', token: 'a'.repeat(64) };
  assert.equal((await request('POST', rootPath + '/devices', a.data.token, device)).status, 200);
  assert.equal((await request('POST', rootPath + '/devices', b.data.token, { ...device, token: 'b'.repeat(64) })).status, 409);
  assert.equal(db.prepare('SELECT user_id FROM devices WHERE project_id=? AND installation_id=?')
    .get(p.projectId, 'install-123').user_id, 'user-a');
  assert.equal((await request('POST', rootPath + '/devices', a.data.token, { ...device, token: 'c'.repeat(64) })).status, 200);
}));

test('device list is paginated, excludes secrets, supports deletion by user ID', async () => root(async ({ request, adminKey, db, worker }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Device Manager' });
  const route = `/v1/projects/${p.projectId}`;
  for (let i = 0; i < 3; i++) {
    const userId = i === 2 ? 'second:user@example.com' : 'first:user@example.com';
    const ticket = await request('POST', route + '/registration-tokens', p.apiKey, { userId });
    const saved = await request('POST', route + '/devices', ticket.data.token, {
      installationId: `phone${i}`, platform: i === 2 ? 'ios' : 'android',
      token: i === 2 ? 'a'.repeat(64) : `long-native-token-${i}-abcdef`, locale: 'en-US'
    });
    assert.equal(saved.status, 200);
  }
  const page1 = await request('GET', route + '/devices?limit=2', p.apiKey);
  assert.equal(page1.data.devices.length, 2);
  assert.ok(page1.data.nextCursor);
  assert.equal(JSON.stringify(page1.data).includes('token_cipher'), false);
  assert.equal(JSON.stringify(page1.data).includes('long-native-token'), false);
  const page2 = await request('GET', route + '/devices?limit=2&after=' + page1.data.nextCursor, p.apiKey);
  assert.equal(page2.data.devices.length, 1);
  assert.equal(page2.data.nextCursor, null);
  assert.equal((await request('GET', route + '/devices?limit=101', p.apiKey)).status, 400);
  const msg = await request('POST', route + '/messages', p.apiKey, {
    title: 'Hi', body: 'News', target: { userIds: ['first:user@example.com'], platform: 'android' },
    options: { badge: 3, ttlSeconds: 300, priority: 'normal', collapseKey: 'updates' }
  });
  assert.equal(msg.data.queued, 2);
  const row = db.prepare('SELECT options_json FROM messages WHERE id=?').get(msg.data.messageId);
  assert.equal(JSON.parse(row.options_json).badge, 3);
  const deleted = await request('DELETE', route + '/users/first:user@example.com', p.apiKey);
  assert.equal(deleted.data.removedDevices, 2);
  assert.equal((await request('GET', route + '/stats', p.apiKey)).data.activeDevices, 1);
  assert.equal(await worker.tick(), 0);
}));

test('admin can inspect and remove provider credentials and delete confirmed project', async () => root(async ({ request, adminKey }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Lifecycle App' });
  const base = `/v1/admin/projects/${p.projectId}`;
  assert.equal((await request('GET', base + '/providers', adminKey)).data.fcmConfigured, false);
  const invalid = { apns: { teamId: 'ABCDEFGHIJ', keyId: 'ABCDEFGHIJ', bundleId: 'com.example.app',
    privateKey: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----' } };
  assert.equal((await request('PUT', base + '/credentials', adminKey, invalid)).status, 400);
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const valid = { ...invalid, apns: { ...invalid.apns, privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) } };
  assert.equal((await request('PUT', base + '/credentials', adminKey, valid)).status, 200);
  assert.equal((await request('GET', base + '/providers', adminKey)).data.apnsConfigured, true);
  assert.equal((await request('DELETE', base + '/credentials/apns', adminKey)).data.apnsConfigured, false);
  assert.equal((await request('DELETE', base, adminKey)).status, 400);
  assert.equal((await request('DELETE', base, adminKey, undefined, { 'x-confirm-delete': p.projectId })).status, 200);
  assert.equal((await request('GET', base + '/providers', adminKey)).status, 404);
}));

test('same native push token cannot be assigned to two different users', async () => root(async ({ request, adminKey, db }) => {
  const { data: p } = await request('POST', '/v1/admin/projects', adminKey, { name: 'Push Token Ownership' });
  const route = `/v1/projects/${p.projectId}`;
  const user1 = (await request('POST', route + '/registration-tokens', p.apiKey, { userId: 'user1' })).data.token;
  const user2 = (await request('POST', route + '/registration-tokens', p.apiKey, { userId: 'user2' })).data.token;
  const token = 'an-android-native-token-that-is-shared';
  assert.equal((await request('POST', route + '/devices', user1,
    { installationId: 'phone1', platform: 'android', token })).status, 200);
  assert.equal((await request('POST', route + '/devices', user2,
    { installationId: 'phone2', platform: 'android', token })).status, 409);
  assert.equal((await request('POST', route + '/devices', user1,
    { installationId: 'phone3', platform: 'android', token })).status, 200);
  const devices = db.prepare('SELECT installation_id FROM devices WHERE project_id=?').all(p.projectId);
  assert.deepEqual(devices.map(d => d.installation_id), ['phone3']);
}));
