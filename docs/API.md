# REST API

Base URL: `http://127.0.0.1:8787` locally, or your HTTPS origin in production. Protected endpoints require `Authorization: Bearer <key>`. JSON write endpoints require `Content-Type: application/json`; request body limit is 64 KiB. The JSON responses use `Cache-Control: no-store`.

Use **admin** credentials only for project/credential management, **project server** credentials for messages/topics and issuing registration tickets, and **short-lived registration tokens** from mobile clients.

## Admin routes

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/v1/admin/projects` | Create a project: `{ "name": "Demo" }`. Returns `projectId` and one-time `apiKey` |
| `GET` | `/v1/admin/projects` | List projects and number of devices |
| `POST` | `/v1/admin/projects/{projectId}/rotate-key` | Revoke server key and issue a new one |
| `PUT` | `/v1/admin/projects/{projectId}/credentials` | Save or replace APNs/FCM provider credentials |
| `GET` | `/v1/admin/projects/{projectId}/providers` | See if APNs/FCM credentials are configured (no secrets) |
| `DELETE` | `/v1/admin/projects/{projectId}/credentials/apns` | Remove APNs credentials |
| `DELETE` | `/v1/admin/projects/{projectId}/credentials/fcm` | Remove FCM credentials |
| `DELETE` | `/v1/admin/projects/{projectId}` | Permanently delete project and all related records; **requires `X-Confirm-Delete: {projectId}`** |

### Provider credentials

`PUT /v1/admin/projects/{projectId}/credentials` accepts either or both of these objects:

```json
{
  "apns": {
    "teamId": "ABCDEFGHIJ",
    "keyId": "ABCDEFGHIJ",
    "bundleId": "com.example.app",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...real P-256 key...\n-----END PRIVATE KEY-----"
  },
  "fcm": {
    "projectId": "your-firebase-project",
    "clientEmail": "example@your-firebase-project.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...real RSA key...\n-----END PRIVATE KEY-----"
  }
}
```

Keys are checked for type and syntax, encrypted on disk and never returned. A successful credential save does not prove that Apple/Google will accept the account permissions or topic identifiers. Use [provider setup](PROVIDERS.md) and test on real devices.

## Project routes

All routes below start with `/v1/projects/{projectId}` and require a **project server key** unless explicitly marked *registration token*.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/registration-tokens` | `{ "userId": "user-123" }` → signed device registration token, expires in 600 sec |
| `POST` | `/devices` | **Registration token**: register/update a device |
| `DELETE` | `/devices/{installationId}` | **Registration token**: remove own device |
| `GET` | `/devices?after=0&limit=50` | List devices without push tokens, up to 100 per page; response includes `nextCursor` |
| `DELETE` | `/users/{userId}` | Remove all devices and topic memberships for a user (server-side privacy action) |
| `POST` | `/topics` | Subscribe/unsubscribe an installation to a topic |
| `POST` | `/messages` | Queue a notification |
| `GET` | `/messages` | List 50 most recent notifications |
| `GET` | `/messages/{messageId}` | Message with delivery-state counts |
| `POST` | `/messages/{messageId}/cancel` | Cancel remaining queued deliveries |
| `GET` | `/stats` | Active devices, campaign counts, delivery-state totals |

### Device registration

The **trusted application backend** must authenticate the user, then request a registration ticket using its project key:

```json
{ "userId": "user:123@example.com" }
```

Pass only the returned 10-minute ticket to the client app. The app calls `POST /devices` with the ticket and a native token:

```json
{
  "installationId": "install_abc123",
  "platform": "ios",
  "token": "<real native APNs hex token>",
  "environment": "production",
  "locale": "en-US"
}
```

For Android use `platform: android` and a native FCM token. The same installation ID cannot be claimed by a different user until it is unregistered; unregister devices on logout. Client token refresh is a re-registration.

### Subscribe to a topic

Send from your **trusted backend** (not directly from an untrusted app):

```json
{ "installationId": "install_abc123", "topic": "news", "subscribed": true }
```

Set `subscribed` to `false` to unsubscribe. Topic membership should be authorization-checked by your backend.

### Create notification

`POST /messages` example:

```json
{
  "title": "Weekly update",
  "body": "New items are available.",
  "data": { "screen": "feed" },
  "target": { "topic": "news", "locale": "en-US", "platform": "android" },
  "sendAt": "2026-11-07T10:00:00Z",
  "options": {
    "priority": "normal",
    "ttlSeconds": 3600,
    "collapseKey": "weekly-news",
    "badge": 1,
    "sound": "default",
    "channelId": "updates"
  }
}
```

Choose exactly one selector: `all: true`, `userIds: ["..."]`, `installationIds: ["..."]`, or `topic: "..."`. You may also filter by `locale` and `platform` (`ios`/`android`). `sendAt` is optional, but when used must be a timestamp with timezone. Device targeting is resolved when the message is queued, **not at the time it is sent**.

**Options** (optional): `priority` high/normal (default high); `ttlSeconds` 0–2419200 (default 86400); `collapseKey` (up to 64 characters); `badge` iOS integer; `sound` notification sound; `channelId` Android channel registered by the app. iOS ignores Android channel settings. Collapsing is controlled by APNs/FCM behavior and is not a server-side queue deduplication guarantee. A TTL of 0 requests immediate delivery only at the provider; it does not cancel a queued message before it is sent.

The API rejects FCM-reserved data keys (including `aps`, `google.*`, `gcm*`). Custom data values must be strings. A single request can queue up to **10,000 devices**; split larger broadcasts into campaigns and capacity-test your own host. Max request JSON: 64 KiB.

Set an `Idempotency-Key` header (6–128 characters, letters/numbers/`_`/`-`) on retriable requests. Same key + same payload returns the original `messageId`; using the same key for different payloads returns HTTP 409.

**Delivery states:** `queued`, `processing`, `accepted`, `failed`, `canceled`, `expired`. `accepted` means APNs or FCM accepted the HTTP request, **not** that the app displayed the notification. Pending jobs are canceled; already processing jobs may still complete. The worker retries transient errors with exponential backoff up to 5 attempts. Process crashes can lead to duplicate provider submissions.

## HTTP status codes

`200`, `201` success; `400` invalid data; `401` wrong/expired token; `404` unknown resource; `409` ownership/idempotency conflict; `413` excessive body/recipients; `415` expected JSON content type; `429` per-IP rate limit; `500` internal server error (details logged on server only).
