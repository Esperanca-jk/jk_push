# JK Push security model

## Trust boundaries

- `ADMIN_KEY` is a highly privileged control-plane secret. Anyone with it can manage projects and provider credentials.
- Project server keys (`jk_sk_*`) allow issuing device tickets, editing topics, sending notifications, deleting user devices and viewing project metadata. They are stored as SHA-256 digests and **must never be embedded in mobile applications**.
- Device registration tokens expire after 10 minutes and are signed using HMAC-SHA256. They identify a trusted backend-authenticated user and a project, and are suitable only for short-lived device registration/unregistration. The application backend must first authenticate and authorize the user.
- APNs/FCM private keys and device push tokens are stored encrypted with AES-256-GCM using `MASTER_KEY`. All recipients' native tokens remain hidden from the device-list API.
- A device installation ID and native push token belong to one user at a time within a project. A conflicting attempt responds with 409, while duplicate installations under the same user/token are consolidated. Delete an old device before user switching.

## Deployment checklist

- Use HTTPS for all externally accessible endpoints. Bind the app to loopback and terminate TLS at a trusted reverse proxy. Consider admin access via VPN/allowlisted IPs.
- Apply host-level firewall, reverse-proxy rate limiting and request-body limits. JK Push's in-memory per-IP quota is single-process convenience only and is insufficient for hostile public internet traffic.
- Restrict `POST /registration-tokens` in **your app's own backend** to authenticated users. It must never let an arbitrary client request a ticket for any other user ID.
- Back up the SQLite database and the `MASTER_KEY` separately. Restoring a DB without its key will not restore encrypted data. Master-key rotation is **not automatically supported** in v0.2; do not replace it without migrating encrypted records.
- Log authentication failures/metadata only; never log credentials, bearer values, provider private keys or push tokens. The dashboard keeps secrets in memory and does not persist them in browser storage.
- Use project-specific quotas, account billing and abuse monitoring externally if running a shared public SaaS. This release is a **self-hosted server for trusted operators**, not an open anonymous signup platform.
- Comply with device opt-in, user access/delete rights, reasonable retention, regional rules, and Apple's and Google's platform requirements. There is no automatic retention/expiry purge for old campaign metadata in this release.
- Keep Node.js and your host patched. Avoid untrusted plugins sharing the same process or filesystem.

## Delivery model

A successful `accepted` status means APNs/FCM accepted a request, not that a device displayed or opened it. Device acceptance and opens require app-side instrumentation. Temporary provider failures are retried up to 5 times; permanent invalid device tokens are disabled. The worker avoids disabling a token that has been refreshed while the provider request was in flight.

The supported architecture is one writable SQLite database with one worker process. A crash after provider acceptance but before local acknowledgment may cause duplicate delivery. `Idempotency-Key` prevents duplicate API queueing for the same message, but not duplicate provider delivery after crash.

## Vulnerability reporting

Please do not post secrets, private logs or working exploits publicly. Contact the repository maintainer privately using the contact information in their GitHub profile.
