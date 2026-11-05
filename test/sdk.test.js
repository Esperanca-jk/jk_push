import test from 'node:test';
import assert from 'node:assert/strict';
import { createJkPushClient } from '../sdk/server.mjs';

const projectId = 'd60fd39c-11b7-4f0c-9916-34d40884475c';

test('server SDK attaches bearer auth and idempotency key', async () => {
  let sent;
  const client = createJkPushClient({ baseUrl: 'https://push.example.com/', projectId,
    apiKey: 'jk_sk_' + 'x'.repeat(43),
    fetchImpl: async (url, init) => {
      sent = { url, ...init };
      return { ok: true, json: async () => ({ messageId: 'a' }) };
    }
  });
  const result = await client.send({ title: 'Hello', body: 'World', target: { all: true } }, 'attempt_1234');
  assert.equal(result.messageId, 'a');
  assert.equal(sent.url, `https://push.example.com/v1/projects/${projectId}/messages`);
  assert.equal(sent.headers.authorization.startsWith('Bearer jk_sk_'), true);
  assert.equal(sent.headers['idempotency-key'], 'attempt_1234');
});

test('server SDK throws typed HTTP errors without exposing keys', async () => {
  const client = createJkPushClient({ baseUrl: 'https://push.example.com', projectId,
    apiKey: 'jk_sk_secret',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'Too many requests' }) }) });
  await assert.rejects(client.stats(), error => error.status === 429 && error.message === 'Too many requests');
});
