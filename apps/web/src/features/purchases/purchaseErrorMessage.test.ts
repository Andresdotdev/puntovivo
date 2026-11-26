import { describe, expect, it } from 'vitest';

import { purchaseErrorKey } from './purchaseErrorMessage';

describe('purchaseErrorKey', () => {
  it('names the device when the cashier registers the purchase from an unregistered device', () => {
    const error = Object.assign(new Error('Device registration is required'), {
      errorCode: 'DEVICE_NOT_REGISTERED',
    });

    expect(purchaseErrorKey(error)).toBe('toast.deviceNotRegistered');
  });

  it('falls back to the generic message for any other failure', () => {
    expect(purchaseErrorKey(Object.assign(new Error('boom'), { errorCode: 'INTERNAL' }))).toBe(
      'toast.error'
    );
    expect(purchaseErrorKey(new Error('network'))).toBe('toast.error');
    expect(purchaseErrorKey(null)).toBe('toast.error');
    expect(purchaseErrorKey(undefined)).toBe('toast.error');
  });
});
