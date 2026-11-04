# JK Push

**Native mobile push notifications with no service subscription.** A lightweight self-hosted REST API and dashboard that sends directly to **Apple Push Notification service (APNs)** and **Firebase Cloud Messaging (FCM HTTP v1)**.

> **Project status: v0.1 technical preview.** This version is suitable for local evaluation and controlled pilots. It has unit/integration coverage and a mock provider mode, but has **not** been validated with live Apple/Google accounts at production scale. Do not interpret provider acceptance as guaranteed device delivery.

## Why JK Push?

- 🟢 **No per-message / per-user license fees**; MIT-licensed code.
- 📱 **Real native push tokens**, not Expo Push Service tokens.
- 🧱 **Multi-project** API with isolated server keys.
- 🔐 Encrypted provider credentials and device tokens at rest (AES-256-GCM).
- ⏰ Scheduled messages, cancellation of queued sends, persistent queue, bounded retries, idempotency keys.
- 🎯 All devices, a user list, installation IDs, topic subscriptions, optional locale targeting.
- 🖥️ Minimal browser dashboard and optional Expo integration helper.
- 🧪 Mock mode for development without sending a single real notification.
- ⚙️ SQLite persistence and **zero npm runtime dependencies** (Node.js built-ins only).

## Architecture

```text
Your backend ──────── REST API ──────── SQLite queue ────── worker
      │                   │                                  │
      │            project server key                        ├─ APNs HTTP/2 → iOS
      │                   │                                  └─ FCM HTTP v1 → Android
      ▼                   ▼
short-lived token      dashboard
      │
Expo / native client ── device registration (native token)
```

## Requirements

- **Node.js 22.13+** with `node:sqlite`. Node.js 22 currently warns that SQLite is experimental. Pin and test your runtime when upgrading.
- An Apple Developer account and APNs `.p8` key for iOS distribution.
- A Firebase project and service-account credentials with FCM permissions for Android.
- Your own server, workstation or VPS (hosting and networking are **not** necessarily free).

FCM Cloud Messaging has no usage charge under the official Firebase price list. Apple does not charge per APNs message, but app distribution may require a paid Developer Program membership. Delivery remains subject to provider policies and limits.

## Start locally (mock mode)

```bash
# Generate two different secure random values:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

# Windows PowerShell (enter your own generated values):
$env:MASTER_KEY = 'YOUR_FIRST_RANDOM_VALUE'
$env:ADMIN_KEY = 'YOUR_SECOND_RANDOM_VALUE'
$env:MOCK_DELIVERY = '1'
npm start
```

Open **http://127.0.0.1:8787/dashboard**. Enter `ADMIN_KEY`, create a project, and save the server API key shown once. For a reproducible API walkthrough, see [docs/API.md](docs/API.md).

### Linux / macOS

```bash
export MASTER_KEY='YOUR_FIRST_RANDOM_VALUE'
export ADMIN_KEY='YOUR_SECOND_RANDOM_VALUE'
export MOCK_DELIVERY=1
npm start
```

To use real APNs/FCM, stop the server, remove `MOCK_DELIVERY=1`, configure per-project provider credentials through the admin API, and restart the service. The dashboard does not currently edit credentials.

## Development

```bash
npm test
npm run check
```

Tests use an in-memory SQLite database, a mock transport and HTTP-level assertions. **No cloud API, external service or GitHub Actions minutes are used.** No workflow files are included.

## Production warnings

1. **HTTPS is mandatory** when accessible from outside your machine. Bind locally and put a TLS reverse proxy in front; do not expose the default HTTP listener on the public internet.
2. **Server keys stay on your trusted backend.** Never ship your `ADMIN_KEY`, `MASTER_KEY`, project server key, `.p8` or Google service-account JSON in a mobile app.
3. **Protect database backups.** Keep the `MASTER_KEY` safe and back it up separately: encrypted tokens and provider keys cannot be recovered without it.
4. **One process / one writable SQLite database** is the supported deployment model. This is not yet a distributed queue or high-availability service. Sudden termination can cause a provider send to be retried once; push delivery is at-least-once, not exactly-once.
5. **Rate limiting** is per remote IP and in-memory; for internet-facing deployments add a trusted reverse proxy / WAF and enforce account limits.
6. **No open signup or multi-tenant billing** is included. Projects are created by a trusted administrator.
7. **Device consent and data privacy** remain your responsibility. Implement privacy disclosures, retention, backups, and user deletion policies appropriate for your jurisdiction.
8. **Native app configuration is required.** Installing this server alone will not enable push entitlements, Firebase configuration, notification permissions or Android channels.

## Roadmap

User preferences/quiet hours, more detailed campaign analytics, proper audit logging, optional Postgres/Redis scale-out, hosted SaaS onboarding, and native Swift/Kotlin SDK packaging. These are **planned**, not shipped in v0.1.

## Docs

- [REST API](docs/API.md)
- [Security model](docs/SECURITY.md)
- [Expo integration](examples/expo-registration.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)

© 2026 Umut Öztosun — MIT License.
