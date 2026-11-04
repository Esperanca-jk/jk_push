import test from 'node:test';
import assert from 'node:assert/strict';
import { randomKey, readMasterKey } from '../src/crypto.js';
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
  const fake = { fcm: { projectId: 'test-project', clientEmail: 'abc@test-project.iam.gserviceaccount.com', privateKey: '-----BEGIN PRIVATE KEY-----\nNOT-REAL\n-----END PRIVATE KEY-----' } };
  assert.equal((await request('PUT', path, p.apiKey, fake)).status, 401);
  assert.equal((await request('PUT', path, adminKey, fake)).status, 200);
  const value = db.prepare('SELECT credentials FROM projects WHERE id=?').get(p.projectId).credentials;
  assert.equal(value.includes('NOT-REAL'), false);
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
