# Native delivery provider setup

JK Push does not issue iOS/Android push entitlements or Firebase credentials. Set up each native application first, then provide the server with permission to use its provider endpoints.

## Apple APNs

1. Enroll in the Apple Developer Program where required by your distribution path.
2. Enable the **Push Notifications** capability for your app identifier and enable push entitlements in the app target.
3. In Apple Developer, create an APNs Auth Key (`.p8`), record its **Key ID**, **Team ID**, and your application's **bundle identifier**.
4. Configure `apns` using the admin credential API. Store the full private PEM as a JSON string containing escaped newlines. Never commit the `.p8`.
5. Build on a real iPhone, grant notification permissions, obtain the **native APNs device token** and register it with JK Push.
6. Register `environment: sandbox` for development builds and `production` for production/TestFlight builds, matching the actual token environment.
7. Use `target: { installationIds: ["..."] }` for a controlled first test; check the message receipt and device screen.

APNs requires TLS 1.2+ over HTTP/2 to Apple's push servers. JK Push signs requests using ES256 token authentication, passes an `apns-topic` bundle ID and `apns-push-type: alert` header, and reuses sessions. Only alert push is implemented: silent/background and Live Activity push are out of scope.

Official reference: https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns

## Firebase Cloud Messaging

1. Create a Firebase project and register the Android application matching its package name.
2. Add Firebase configuration to the native app, install FCM-capable SDKs, and configure Android notification permission and channels.
3. Enable the **Firebase Cloud Messaging API (v1)** and create a service account authorized to send FCM messages.
4. From the service account JSON use `project_id`, `client_email`, and `private_key` for the JK Push `fcm` credential fields.
5. On a physical Android device obtain a **native FCM registration token** and register it with JK Push (`platform: android`).
6. Send a targeted test notification, inspect the provider-accepted status, and verify device behavior in foreground/background.

JK Push obtains OAuth 2.0 access tokens for the Firebase Messaging scope and sends to FCM HTTP v1. It treats `UNREGISTERED` as a permanently invalid token. Other `INVALID_ARGUMENT` errors are *not* blindly interpreted as invalid devices because payload problems can produce them as well.

Official references:
- https://firebase.google.com/docs/cloud-messaging/send/v1-api
- https://firebase.google.com/docs/cloud-messaging/error-codes
- https://firebase.google.com/docs/cloud-messaging/manage-tokens

## Expo / React Native

Copy [`sdk/expo.ts`](../sdk/expo.ts) into your Expo app and read [`examples/expo-registration.md`](../examples/expo-registration.md). Use a **development build** or store build, not Expo Go. Create an Android notification channel before requesting an Android 13+ native token. Provide platform-specific push setup, request permission and handle opened notifications in the app.

Expo reference: https://docs.expo.dev/versions/latest/sdk/notifications/

## Troubleshooting

- **APNs 400 BadDeviceToken**: check token environment, app topic, token format and provisioned entitlement.
- **APNs 403**: check Team/Key IDs, APNs key validity and rights.
- **FCM 401/403**: check OAuth credentials, API permission, service-account access and project ID.
- **FCM UNREGISTERED**: the registration token is no longer valid; request a new one from the app.
- **Provider accepted but no alert**: confirm user consent, iOS Focus settings, Android 13+ channel/permissions, and foreground notification handlers. APNs/FCM acceptance does not guarantee screen display.
