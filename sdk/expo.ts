/**
 * JK Push device registration helper for Expo projects.
 * The caller must fetch a short-lived registration token from THEIR trusted backend.
 * Never embed a JK Push server API key or Apple/FCM credentials in a mobile app.
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
};

export async function registerExpoDevice(options: RegisterOptions) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('JK Push Expo helper supports only iOS and Android');
  }
  const permission = await Notifications.getPermissionsAsync();
  const granted = permission.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return { registered: false, reason: 'notification-permission-denied' as const };

  // Native APNs token on iOS, native FCM token on Android (not an ExpoPushToken).
  const native = await Notifications.getDevicePushTokenAsync();
  if (typeof native.data !== 'string') throw new Error('Expected a native push token');
  const response = await fetch(
    `${options.serverUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(options.projectId)}/devices`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.registrationToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        installationId: options.installationId,
        platform: Platform.OS,
        token: native.data,
        environment: Platform.OS === 'ios' ? options.apnsEnvironment ?? 'production' : 'production',
        ...(options.locale ? { locale: options.locale } : {})
      })
    }
  );
  if (!response.ok) throw new Error(`JK Push registration failed (HTTP ${response.status})`);
  return { registered: true as const, ...(await response.json()) };
}
