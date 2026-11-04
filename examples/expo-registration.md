# Expo / React Native integration

Use a **development or production build**, not Expo Go. Configure `expo-notifications` and the Firebase Android configuration; iOS requires the push notification entitlement.

```bash
npx expo install expo-notifications expo-secure-store expo-crypto
```

Persist an installation ID securely. The following helper is an example and needs to be imported from your application code:

```typescript
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { registerExpoDevice } from './jk_push-expo';

async function installationId() {
  let id = await SecureStore.getItemAsync('jk_push-installation-id');
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync('jk_push-installation-id', id);
  }
  return id;
}

async function enableNotifications() {
  // YOUR backend validates the signed-in user and issues a short-lived token
  // using JK Push's POST /v1/projects/:id/registration-tokens endpoint.
  const response = await fetch('https://my-backend.example.com/notifications/registration-token', {
    headers: { Authorization: 'Bearer <your-app-login-token>' }
  });
  if (!response.ok) throw new Error('Authentication required');
  const { token, projectId } = await response.json();
  return registerExpoDevice({
    serverUrl: 'https://push.example.com',
    projectId,
    registrationToken: token,
    installationId: await installationId(),
    apnsEnvironment: 'production'
  });
}
```

Set `apnsEnvironment` to `sandbox` if your APNs token belongs to an Apple development build. In production it should normally be `production`. Update the stored push token after rotation (Expo exposes `Notifications.addPushTokenListener`). The receiving app must handle notification press events, Android channels, permission revocation, and in-app navigation itself.

**Important:** This client helper is only a source file. It is not an installed npm package yet. Copy `sdk/expo.ts` into your Expo app and update the import path.
