/**
 * In-memory end-to-end walkthrough. Uses mock delivery; no provider credentials
 * or network calls to Apple/Google are involved.
 */
import assert from 'node:assert/strict';
import { randomKey, readMasterKey } from '../src/crypto.js';
import { openDatabase } from '../src/db.js';
import { createApi } from '../src/api.js';
import { createWorker } from '../src/worker.js';
import { createJkPushClient } from '../sdk/server.mjs';

const db = openDatabase(':memory:');
const adminKey = randomKey();
const masterKey = readMasterKey(randomKey());
const worker = createWorker({ db, masterKey, mock: true });
const server = createApi({ db, adminKey, masterKey, worker });

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  async function post(path, bearer, payload) {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error('Request failed: HTTP ' + response.status + ' (' + (result.error || 'unknown error') + ')');
    return result;
  }

  const { projectId, apiKey } = await post('/v1/admin/projects', adminKey, { name: 'Local Demo' });
  const client = createJkPushClient({ baseUrl, projectId, apiKey });
  const { token } = await client.issueRegistrationToken('demo-user');

  await post('/v1/projects/' + projectId + '/devices', token, {
    installationId: 'demo-installation-1',
    platform: 'android',
    token: 'mock-native-fcm-token-example-0001',
    locale: 'en-US'
  });

  const message = await client.send({
    title: 'Hello from JK Push',
    body: 'This is a local mock notification.',
    data: { screen: 'welcome' },
    target: { userIds: ['demo-user'] }
  }, 'mock_demo_001');
  assert.equal(message.queued, 1, 'Expected one queued recipient');
  assert.equal(await worker.tick(), 1, 'Expected one processed delivery');

  const receipt = await client.getMessage(message.messageId);
  assert.equal(receipt.counts.accepted, 1, 'Expected mock provider acceptance');
  console.log('Mock demo complete: 1 device registered, 1 message queued.');
  console.log('Mock delivery accepted: 1 (simulated; no real notification sent).');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  db.close();
}
