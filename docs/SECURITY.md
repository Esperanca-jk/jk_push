# Security model and limitations

## Trust boundaries

- `ADMIN_KEY` is the control-plane secret. Store it only on the server / with authorized operators.
- Project API keys (`jk_sk_*`) are private **server-to-server** credentials and are stored as SHA-256 digests.
- Device registration tickets are HMAC-SHA256 signed by the server, expire after 10 minutes, and identify a project plus authenticated user ID. The application backend must verify the user first.
- APNs private keys, FCM service-account private keys and native device tokens are AES-256-GCM encrypted at rest with `MASTER_KEY`. Back up this master key separately and securely.
- Token unregistration validates ownership by registration ticket user ID. Re-registering an existing installation ID under a different user is rejected (HTTP 409).

## Hardening before public deployment

- Use a TLS reverse proxy with IP filtering, body limits, and per-project quotas. The default server binds to loopback.
- Keep your host patched. Protect database files and backups with OS permissions. Avoid colocating untrusted workloads.
- Rotate APNs/FCM credentials if exposed; changing MASTER_KEY currently requires re-encrypting stored secrets.
- Maintain an allowlist for your application backend's routes that mint registration tickets. Require normal user authentication there.
- Add abuse prevention to the device registration endpoint at the reverse proxy. A valid short-lived ticket can currently register multiple installations until expiry.
- Rate limiting here is a single-process convenience, not a full distributed abuse-control system.
- TLS termination, data retention, subject-access requests, export, moderation, and platform compliance are deployment responsibilities.
- Never log raw bearer tokens, device tokens, .p8 keys, or provider service-account JSON.

## Delivery guarantees

The worker retries transient errors up to five attempts, with exponential backoff. APNs and FCM may accept pushes that are never displayed. A process crash after the provider accepts a push but before SQLite commits its result can cause duplicate delivery on recovery. Callers should design notifications to tolerate duplicates.

## Responsible disclosure

Do not publish working exploit steps or private credentials in an issue. Please contact the maintainer privately through their GitHub profile before public disclosure.
