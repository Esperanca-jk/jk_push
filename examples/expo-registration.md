# Expo / React Native native push registration

This example uses **APNs** on iOS and **FCM** on Android, not the Expo Push Service. Use a development build or store build, not Expo Go. Configure `expo-notifications`, iOS push entitlements and Android Firebase before continuing.

```bash
npx expo install expo-notifications expo-secure-store expo-crypto
```

Copy [`sdk/expo.ts`](../sdk/expo.ts) into your mobile project (for example `src/lib/jk_push-expo.ts`), then call it after your application user has signed in.

```typescript
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { registerExpoDevice, watchExpoPushTokenChanges, unregisterExpoDevice } from './lib/jk_push-expo';

async function installationId(): Promise<string> {
  let id = await SecureStore.getItemAsync('jk_push-installation-id');
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync('jk_push-installation-id', id);
  }
  return id;
}

async function getOptions() {
  // YOUR backend verifies the signed-in user and uses its private JK Push server key.
  const response = await fetch('https://my-backend.example.com/notifications/registration-token', {
    headers: { Authorization: 'Bearer <your-app-login-token>' }
  });
  if (!response.ok) throw new Error('Authentication required');
  const { token, projectId } = await response.json();
  return {
    serverUrl: 'https://push.example.com',
    projectId,
    registrationToken: token,
    installationId: await installationId(),
    apnsEnvironment: 'production' as const,
    androidChannelId: 'default',
    locale: 'en-US'
  };
}

// After login:
const options = await getOptions();
await registerExpoDevice(options);

// Keep this listener active while signed in. On token rotation it requests a fresh ticket.
const listener = watchExpoPushTokenChanges(getOptions, console.error);

// On logout, ideally before revoking your app's own authentication:
await unregisterExpoDevice(await getOptions());
listener.remove();
```

When switching accounts on a shared phone, unregister the old installation **before** registering under the new user. The server rejects reassigning an existing installation ID to another user to prevent account hijacking. If the old user cannot unregister, have your trusted backend delete the previous user's device records through `DELETE /v1/projects/{projectId}/users/{userId}` after validating the request.

Register the app's notification press/foreground handlers and handle Android notification channels and app navigation. The helper does not automatically manage received pushes or notification opening. Read [Expo's official notification guide](https://docs.expo.dev/versions/latest/sdk/notifications/).
