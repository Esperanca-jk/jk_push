# REST API reference

Use `Authorization: Bearer ...` on all protected endpoints and `Content-Type: application/json` for requests with a body. Commands below use `curl` examples; replace placeholders.

## 1. Create project — admin only

```bash
curl -sS http://127.0.0.1:8787/v1/admin/projects \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_KEY" \
  -d '{"name":"My App"}'
```

Response: `projectId` and **one-time** `apiKey` (starts with `jk_sk_`). Put the key only on your trusted application backend.

`GET /v1/admin/projects` lists projects (no keys). `POST /v1/admin/projects/{projectId}/rotate-key` revokes the old project key and returns a replacement **once** (admin only). `GET /health` returns readiness.

## 2. Add provider credentials — admin only

`PUT /v1/admin/projects/{projectId}/credentials`

```json
{
  "apns": {
    "teamId": "ABCDEFGHIJ",
    "keyId": "ABCDEFGHIJ",
    "bundleId": "com.example.app",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  },
  "fcm": {
    "projectId": "your-firebase-project",
    "clientEmail": "example@your-firebase-project.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  }
}
```

You may provide only `apns` or only `fcm`; the other saved provider is retained. Values are encrypted on disk. Never commit credentials. Send secrets only over HTTPS when remote.

## 3. Issue a registration token — trusted application backend

`POST /v1/projects/{projectId}/registration-tokens` with project server API key:

```json
{ "userId": "user-123" }
```

Returns `token`, `expiresIn: 600`. Only your authenticated application backend should call this endpoint. It must verify the end user's identity before requesting the token. The short-lived token is scoped to the project and user ID.

## 4. Register native device — mobile app

`POST /v1/projects/{projectId}/devices` with **registration token**, not project API key:

```json
{
  "installationId": "install_abc123",
  "platform": "ios",
  "token": "<native APNs hex token>",
  "environment": "production",
  "locale": "en-US"
}
```

For Android, use platform `android` and a native FCM token. Clients can remove their registration via `DELETE /v1/projects/{projectId}/devices/{installationId}` with a valid registration token for the same user ID. Devices are upserted on token rotation.

## 5. Subscribe device to a topic — trusted backend

`POST /v1/projects/{projectId}/topics` with project server key:

```json
{ "installationId": "install_abc123", "topic": "news", "subscribed": true }
```

Set `subscribed: false` to remove the subscription. Do not treat topics as security/authorization: this API trusts your application backend to decide membership.

## 6. Queue a message — trusted backend

`POST /v1/projects/{projectId}/messages` with project server key:

```json
{
  "title": "Weekly update",
  "body": "New items are available.",
  "data": { "screen": "feed" },
  "target": { "topic": "news", "locale": "en-US" },
  "sendAt": "2026-11-07T10:00:00Z"
}
```

Choose exactly one main target selector:

- `{ "all": true }`
- `{ "userIds": ["user-123", "user-456"] }`
- `{ "installationIds": ["install_abc123"] }`
- `{ "topic": "news" }`

Add `locale` to any selector. Omit `sendAt` to queue immediately. Each API request targets at most **1000 devices** in v0.1; larger requests return HTTP 413 rather than silently truncating results. Batch larger sends in your backend.

Set `Idempotency-Key: unique-request-id` to avoid duplicate queue insertion on network retry. Reusing a key with a different payload returns HTTP 409. The response includes `messageId` and `queued`.

`GET /v1/projects/{projectId}/messages` lists recent messages. `GET /v1/projects/{projectId}/messages/{messageId}` returns per-state counts (`queued`, `accepted`, `failed`, `canceled`). `POST /v1/projects/{projectId}/messages/{messageId}/cancel` cancels any **queued** deliveries; in-flight or provider-accepted notifications cannot be recalled. `GET /v1/projects/{projectId}/stats` reports active devices, campaigns, and delivery state totals.

**Accepted** means APNs or FCM accepted the request, not that the user saw or opened the notification.

## Status codes

- `200`, `201`: success
- `400`: validation error
- `401`: incorrect or expired bearer token
- `404`: unknown project, device, or message
- `409`: idempotency conflict
- `413`: oversized body or target list
- `415`: expected JSON content type
- `429`: per-IP rate limit
