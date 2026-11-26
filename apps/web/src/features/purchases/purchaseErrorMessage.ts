/**
 * Which message a failed purchase registration shows.
 *
 * The critical-command client refuses to send anything when the device was
 * never registered, so nothing reaches the server and no tRPC error arrives.
 * Telling the cashier "the purchase could not be registered" hides the one
 * thing they can act on: signing in again so the device registers.
 */
export type PurchaseErrorKey = 'toast.deviceNotRegistered' | 'toast.error';

const DEVICE_NOT_REGISTERED = 'DEVICE_NOT_REGISTERED';

export function purchaseErrorKey(error: unknown): PurchaseErrorKey {
  if (typeof error !== 'object' || error === null) return 'toast.error';
  const code = (error as { errorCode?: unknown }).errorCode;
  return code === DEVICE_NOT_REGISTERED ? 'toast.deviceNotRegistered' : 'toast.error';
}
