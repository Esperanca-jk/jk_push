# JK Push

**A self-hosted native push notification platform for iOS and Android.** Build an operator console, register devices, target audiences, schedule messages and send through **APNs** and **FCM HTTP v1** — without a per-user or per-message software subscription.

[Quick start](#quick-start) · [API reference](docs/API.md) · [Provider setup](docs/PROVIDERS.md) · [Deployment](docs/DEPLOYMENT.md) · [Security](docs/SECURITY.md)

> **Release: v0.2.0 (beta).** The API, local queue, migrations and provider payloads have automated tests. Live APNs/FCM delivery and large-scale operating characteristics still require validation with real accounts and devices before production use. Provider acceptance does **not** mean the notification was displayed or opened.

## Features

| Capability | Status |
| --- | --- |
| Native APNs HTTP/2 delivery and FCM HTTP v1 | Implemented; live credentials required |
| Multi-project isolation, one-time server keys and key rotation | Implemented |
| Short-lived, user-scoped device registration tokens | Implemented |
| Encrypted device tokens and provider private keys at rest | Implemented (AES-256-GCM) |
| Expo / React Native integration helper | Source example, not an npm package |
| Node.js backend SDK | Included (`sdk/server.mjs`) |
| Target all, users, installations or topics; optional locale/platform filters | Implemented |
| Notification options: priority, TTL, collapse key, iOS badge/sound, Android channel | Implemented |
| Schedule, cancel queued sends, retry temporary errors, idempotency | Implemented |
| Local SQLite queue with crash recovery | Implemented (single worker process) |
| Dashboard, counts, campaign list, provider configuration status, device list | Implemented |
| Remove user devices / delete projects and stored provider credentials | Implemented |
| Background notifications, opened/delivered analytics, high-availability clusters | Not implemented |

## Quick start

**Requirements:** Node.js 22.13+ (`node:sqlite`), a terminal and a browser. No npm packages are required to run the server or tests.

```bash
git clone https://github.com/Esperanca-jk/jk_push.git
cd jk_push
npm run init
npm start
```

`npm run init` creates an ignored `.env` with unique, cryptographically random `ADMIN_KEY` and `MASTER_KEY`, enables **mock delivery**, and will refuse to overwrite an existing `.env`. The private keys are required to decrypt persisted data, so **back up `MASTER_KEY` securely**.

Open **http://127.0.0.1:8787/dashboard** and paste `ADMIN_KEY` from your local `.env` file. Create a project, then save the newly generated `jk_sk_...` project server key; it is shown once. The app is bound to localhost by default.

In mock mode you can test the entire queue without contacting Apple/Google or consuming API quotas. Device registration requires a native-looking token and a short-lived registration ticket; [the API walkthrough](docs/API.md) shows how to create both.

### Send a message from your backend

```javascript
import { createJkPushClient } from './sdk/server.mjs';

const push = createJkPushClient({
  baseUrl: 'http://127.0.0.1:8787',
  projectId: process.env.JK_PUSH_PROJECT_ID,
  apiKey: process.env.JK_PUSH_SERVER_KEY
});

const queued = await push.send({
  title: 'A new update',
  body: 'Your dashboard is ready',
  data: { screen: 'updates' },
  target: { userIds: ['user-123'] },
  options: { ttlSeconds: 3600, priority: 'normal' }
}, 'unique-business-event-123');
console.log(queued.messageId);
```

Keep `JK_PUSH_SERVER_KEY` on your **trusted backend**, never in mobile applications. Your backend authenticates users, obtains a 10-minute registration ticket, and passes only that ticket to the app. See [Expo registration](examples/expo-registration.md).

## Enable real native delivery

After verifying mock mode, configure the APNs `.p8` key and/or Firebase service-account JSON for each project through the **admin-only** credential API; both require their associated app-side entitlements and configuration. Set `MOCK_DELIVERY=0` and restart the server.

- Apple iOS: Team ID, Key ID, bundle identifier, APNs Auth Key, iOS push entitlement, and Apple development/distribution configuration.
- Google Android: Firebase project, service-account credential authorized for FCM, Android app configured with Firebase and notification permission/channel.
- The service sends directly to the providers; it does **not** use Expo Push Service tokens.

Read [PROVIDERS.md](docs/PROVIDERS.md) for field-by-field setup.

## Operation

```bash
npm test
npm run check
npm start
```

The server keeps notification state in SQLite. The worker polls every two seconds and retries transient failures (at most five attempts). Each message is capped at **10,000 queued recipients** as a single-process safety guard; it is not a hosted-plan quota. A deployment with more recipients needs partitioned campaigns and capacity testing. Delivery is **at least once** under crashes; duplicates can occur.

For Docker Compose, persistent backups, TLS reverse proxies, production configuration and troubleshooting, read [DEPLOYMENT.md](docs/DEPLOYMENT.md). This repository intentionally does not install GitHub Actions workflows or schedule CI jobs. Local tests use mock transports and no external services.

## Cost model

JK Push is licensed under **MIT** and has no built-in service fee, paid tiers or recipient charges. You are responsible for hosting/storage/network costs, Apple Developer Program fees where applicable, security, and provider terms and rate limits. Operating a hosted service for others will have costs even though the software is free.

## Security and privacy

- Passwords, provider credentials, API keys and device tokens are not exposed through the public device-list API.
- AES-256-GCM encryption protects credentials and native tokens **at rest**; use HTTPS and a trusted reverse proxy for any external access.
- Device registration is user-scoped; never expose project server keys, `ADMIN_KEY`, `MASTER_KEY`, APNs keys or Firebase service accounts to client apps.
- You remain responsible for push consent, user rights, data retention, deletion policies and compliance with local laws.

See [SECURITY.md](docs/SECURITY.md) for risks and [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

© 2026 Umut Öztosun. [MIT License](LICENSE).
