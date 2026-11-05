# Contributing to JK Push

Bug reports, platform-specific tests, documentation and focused improvements are welcome. The most useful contributions include real-world APNs and FCM interoperability test results, false-positive analysis, minimal failing fixtures and SDK examples.

## Local development

Use Node.js 22.13+. Run `npm test` and `npm run check` before opening a pull request. Tests use an in-memory SQLite database and mock transports; no Apple or Firebase account is required. Never upload actual signing keys, service-account JSON, production device tokens or confidential user data in issues or PRs.

For provider changes, add test coverage for header construction, auth errors, retryability and invalid-token handling. For database changes, add a migration test and document backup/rollback considerations. Keep security and privacy impact explicit in PR descriptions.

There are deliberately **no GitHub Actions workflows** in this repository. Contributors can test locally without consuming someone else's Actions minutes.
