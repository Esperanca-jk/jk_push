/**
 * Lightweight server-side client. Never import this with a server key in mobile code.
 * This file is self-contained and can be copied into any Node.js 20+ backend.
 */
export function createJkPushClient({ baseUrl, projectId, apiKey, fetchImpl = fetch }) {
  if (!/^https?:\/\//.test(baseUrl ?? '') || !/^[a-f0-9-]{36}$/.test(projectId ?? '') ||
      typeof apiKey !== 'string' || !apiKey.startsWith('jk_sk_')) {
    throw new Error('Valid baseUrl, projectId and project server API key are required');
  }
  const origin = baseUrl.replace(/\/+$/, '');
  const prefix = `/v1/projects/${encodeURIComponent(projectId)}`;
  async function call(method, endpoint, data, headers = {}) {
    const response = await fetchImpl(origin + prefix + endpoint, {
      method,
      headers: { authorization: 'Bearer ' + apiKey, ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `JK Push HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  return {
    issueRegistrationToken(userId) { return call('POST', '/registration-tokens', { userId }); },
    send(payload, idempotencyKey) {
      return call('POST', '/messages', payload, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
    },
    cancel(messageId) { return call('POST', `/messages/${encodeURIComponent(messageId)}/cancel`); },
    getMessage(messageId) { return call('GET', `/messages/${encodeURIComponent(messageId)}`); },
    listMessages() { return call('GET', '/messages'); },
    stats() { return call('GET', '/stats'); },
    listDevices({ after = 0, limit = 50 } = {}) {
      return call('GET', `/devices?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`);
    },
    deleteUserDevices(userId) { return call('DELETE', `/users/${encodeURIComponent(userId)}`); },
    subscribe(installationId, topic) { return call('POST', '/topics', { installationId, topic, subscribed: true }); },
    unsubscribe(installationId, topic) { return call('POST', '/topics', { installationId, topic, subscribed: false }); }
  };
}
