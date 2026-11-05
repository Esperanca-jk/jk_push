# Deployment & operations

## Local development

```bash
npm run init          # Creates .env once; refuses to overwrite secrets
npm start             # Loads local .env via Node.js 22's --env-file-if-exists
npm test              # Mock transports, no provider access
npm run check         # Syntax checks, no GitHub Actions
```

Start at `http://127.0.0.1:8787/dashboard` and read the admin key from `.env`. **Mock delivery starts enabled**, so no real push is sent. Once credentials are configured and a device is ready, set `MOCK_DELIVERY=0`, restart and test one installation.

## Docker Compose

```bash
npm run init
docker compose up --build -d
docker compose ps
```

The included Compose file maps `127.0.0.1:8787` on the **host** to the app container and persists SQLite in a named Docker volume. Keep the port bound to loopback and place a trusted TLS proxy (Caddy, Nginx or an ingress) in front. Add rate limits, restricted admin access, request limits and firewall rules at that edge. Never expose the container's raw HTTP port publicly.

Example reverse proxy configuration (adapt the domain and security measures):

```caddyfile
push.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
}
```

Caddy can provision certificates for publicly resolvable domains when DNS and ports are configured appropriately. **Restrict** admin endpoints with firewall/IP controls, VPN or authentication at the reverse proxy; knowing only the dashboard URL must never be considered sufficient security.

## Secrets

- `ADMIN_KEY`: random control-plane secret (never in mobile code).
- `MASTER_KEY`: 32 random bytes encoded as base64url; this key decrypts existing device and provider secrets. Losing it means encrypted fields cannot be recovered.
- Project `jk_sk_` keys: shown only once on project creation/rotation; store in your backend's secret store.
- Provider private keys: stored encrypted in SQLite. Use separate keys per account when possible and rotate if exposed.
- Use OS-level file permissions and encryption-at-rest for database backups. Never commit `.env`, `.p8`, Google service-account JSON, or database files.

## Backups and migration

Use SQLite's **online backup API** or the SQLite `VACUUM INTO` command rather than copying a live WAL database file alone. With a stopped server, you may copy the `.sqlite` file together with `-wal` and `-shm` files if present. Back up `MASTER_KEY` securely and separately; restoring SQLite without it cannot restore encrypted device/provider data.

JK Push v0.2 adds an `options_json` column automatically on startup while retaining existing messages and deliveries. Take a verified backup before updating from v0.1, and restart the single server process to apply the schema change. Rolling back after adding features may require manual schema consideration.

## Reliability and capacity

One process and one writable SQLite database are supported. The worker checks up to 25 due deliveries per two-second tick and retries temporary provider errors up to 5 times. Large campaigns will take time; do not assume provider throughput or guaranteed arrival order. A 10,000-device per-message guard prevents accidentally enqueuing huge broadcasts in one transaction; it is not a hosted-service quota.

APNs and FCM can accept a notification while the client remains offline, has notification permission disabled, or silently drops it. The service reports **provider acceptance, not device delivery, opens or impressions**.

A crash after the provider received the push but before the local delivery status was persisted can cause duplicate sends on recovery. Implement idempotent app-side handling for important events. Run one writer/worker instance per database, and use external monitoring for disk space, queue age, provider errors, backups and service uptime.

## Costs

JK Push itself is MIT-licensed and has no fee. Compute, storage, bandwidth, monitoring and managed TLS/proxies may have costs. Apple Developer Program membership may be required for iOS app distribution. Firebase/Apple impose service limitations and policies even if messages are free. There are **no GitHub Actions workflows** included.
