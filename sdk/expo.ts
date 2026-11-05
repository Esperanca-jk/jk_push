/**
 * Copy into an Expo app configured for native notifications.
 * Fetch the registration token from your authenticated backend. Never ship server credentials.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

export type RegisterOptions = {
  serverUrl: string;
  projectId: string;
  registrationToken: string;
  installationId: string;
  locale?: string;
  apnsEnvironment?: 'sandbox' | 'production';
  androidChannelId?: string;
};

async function sendRegistration(options: RegisterOptions, nativeToken: string) {
  const response = await fetch(
    `${options.serverUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(options.projectId)}/devices`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.registrationToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        installationId: options.installationId,
        platform: Platform.OS,
        token: nativeToken,
        environment: Platform.OS === 'ios' ? (options.apnsEnvironment ?? 'production') : 'production',
        ...(options.locale ? { locale: options.locale } : {})
      })
    }
  );
  if (!response.ok) throw new Error(`JK Push registration failed (HTTP ${response.status})`);
  return { registered: true as const, ...(await response.json()) };
}

export async function registerExpoDevice(options: RegisterOptions) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('JK Push supports iOS and Android devices only');
  }
  if (Platform.OS === 'android') {
    // Android 13+ needs a notification channel before requesting a device push token.
    await Notifications.setNotificationChannelAsync(options.androidChannelId ?? 'default', {
      name: 'Default', importance: Notifications.AndroidImportance.DEFAULT
    });
  }
  const existing = await Notifications.getPermissionsAsync();
  const permission = existing.granted ? existing : await Notifications.requestPermissionsAsync();
  const provisional = Platform.OS === 'ios' &&
    permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!permission.granted && !provisional) {
    return { registered: false as const, reason: 'notification-permission-denied' as const };
  }

  // Never call getExpoPushTokenAsync: JK Push sends directly to APNs and FCM.
  const native = await Notifications.getDevicePushTokenAsync();
  if (typeof native.data !== 'string') throw new Error('Expected a native APNs / FCM push token');
  return sendRegistration(options, native.data);
}

/** Subscribe to native token rotations; request a fresh short-lived ticket for each change. */
export function watchExpoPushTokenChanges(
  refreshOptions: () => Promise<RegisterOptions>,
  onError: (error: unknown) => void
) {
  return Notifications.addPushTokenListener(token => {
    if (typeof token.data !== 'string') return;
    void refreshOptions()
      .then(options => sendRegistration(options, token.data as string))
      .catch(onError);
  });
}

export async function unregisterExpoDevice(options: RegisterOptions) {
  const response = await fetch(
    `${options.serverUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(options.projectId)}/devices/${encodeURIComponent(options.installationId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${options.registrationToken}` } }
  );
  if (!response.ok) throw new Error(`JK Push unregistration failed (HTTP ${response.status})`);
  return response.json();
}
