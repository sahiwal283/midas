import { notificationApi } from '../api/notifications';

/**
 * Web push helpers. Push is available when the browser supports it AND the
 * API has VAPID keys configured. On iOS, push additionally requires the app
 * to be installed to the home screen (Add to Home Screen) first.
 */

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Fire-and-forget; registration failures must never affect the app.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? navigator.serviceWorker.register('/sw.js');
}

/** PushManager.subscribe wants the VAPID key as a Uint8Array over a plain ArrayBuffer. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'subscribed' | 'ready';

/** True when an existing subscription was made under the given VAPID key. */
function keyMatches(existing: ArrayBuffer | null, publicKey: string): boolean {
  if (!existing) return true; // can't tell — assume current
  const a = new Uint8Array(existing);
  const b = urlBase64ToUint8Array(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** What the enable-notifications UI should show right now. */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  const { publicKey } = await notificationApi.pushPublicKey();
  if (!publicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return 'ready';
  // A subscription made under a rotated VAPID key is undeliverable — offer
  // re-enable instead of pretending push works.
  return keyMatches(sub.options?.applicationServerKey ?? null, publicKey) ? 'subscribed' : 'ready';
}

/** Must be called from a user gesture (permission prompt requirement). */
export async function subscribeToPush(): Promise<void> {
  // Permission first, before any network round-trip: Safari spends the
  // gesture's transient activation across awaits, and requestPermission
  // outside an activation auto-resolves 'denied' without a prompt.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');

  const { publicKey } = await notificationApi.pushPublicKey();
  if (!publicKey) throw new Error('Push notifications are not configured on the server');

  const reg = await getRegistration();
  await navigator.serviceWorker.ready;

  // A leftover subscription under a different VAPID key makes subscribe()
  // throw InvalidStateError — drop it and start fresh.
  const existing = await reg.pushManager.getSubscription();
  if (existing && !keyMatches(existing.options?.applicationServerKey ?? null, publicKey)) {
    await existing.unsubscribe();
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Browser returned an incomplete push subscription');
  }
  await notificationApi.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

export async function unsubscribeFromPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await notificationApi.pushUnsubscribe({ endpoint: sub.endpoint });
  await sub.unsubscribe();
}
