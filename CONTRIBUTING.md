# Contributing to JK Push

Thanks for contributing. The most useful contributions are reproducible fixes, platform-specific tests, and documentation that helps developers use APNs / FCM correctly.

## Development

Use Node.js 22.13+ and run `npm test` and `npm run check`. A real Apple or Firebase account is **not** required to run the tests; the integration suite uses a fake provider transport.

Please make PRs narrowly scoped. Include a failing test for a bug fix and no secrets, private logs or user push tokens in test fixtures. Keep APNs and FCM request handling independent and avoid accidentally retrying permanent errors. New features should document migration, security, and privacy impact.

There are intentionally **no GitHub Actions workflows**; CI is run manually or within the contributor's own environment.
