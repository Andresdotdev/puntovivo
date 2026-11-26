import { afterEach, describe, expect, it, vi } from 'vitest';
import i18next from '@/i18n';
import type { Order } from '@/types';
import { OrderPrintError } from './orderPrinter';
import { printSavedOrder } from './printSavedOrder';

function makeSavedOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    tenantId: 'tenant-1',
    orderNumber: 'PED-000777',
    providerId: 'provider-1',
    providerName: 'Distribuidora & Co',
    siteId: 'site-1',
    siteName: 'Main Site',
    status: 'submitted',
    subtotal: 28,
    total: 28,
    linkedPurchaseCount: 0,
    receivedPurchaseNumber: null,
    createdBy: 'user-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    items: [
      {
        id: 'order-item-1',
        orderId: 'order-1',
        productId: 'product-1',
        productName: 'Rice',
        productSku: 'RICE-1',
        quantity: 7,
        unitId: 'unit-1',
        unitName: 'Cajas',
        unitAbbreviation: 'CJ',
        unitEquivalence: 1,
        costPerUnit: 4,
        baseUnitCost: 4,
        total: 28,
      },
    ],
    ...overrides,
  };
}

/** Stand-in for the popup `openHtmlInPrintWindow` navigates. */
function makePrintWindow(): Window {
  return {
    opener: null,
    location: { replace: vi.fn() },
    close: vi.fn(),
  } as unknown as Window;
}

describe('printSavedOrder', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete window.electron;
    await i18next.changeLanguage('en');
  });

  it('prints the stored order it reads back, not the row that was clicked', async () => {
    const popup = makePrintWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    let printed: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(value => {
      printed = value as Blob;
      return 'blob:saved-order';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    // The stored record differs from anything a list row carries: the row has
    // no lines at all, so a document built from the row would be empty.
    const readOrder = vi.fn(async () => makeSavedOrder());

    await printSavedOrder('order-1', readOrder);

    expect(readOrder).toHaveBeenCalledWith('order-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.location.replace).toHaveBeenCalledWith('blob:saved-order');

    // The printed sheet carries the saved order's supplier, number and line
    // with its quantity and unit.
    expect(printed).toBeDefined();
    const html = await printed!.text();
    expect(html).toContain('PED-000777');
    expect(html).toContain('Distribuidora &amp; Co');
    expect(html).toContain('Rice');
    expect(html).toContain('Cajas');
  });

  it('reports a missing order instead of printing an empty sheet', async () => {
    const open = vi.spyOn(window, 'open');

    await expect(
      printSavedOrder('gone', async () => {
        throw Object.assign(new Error('Order not found'), {
          data: { code: 'NOT_FOUND' },
        });
      })
    ).rejects.toMatchObject({
      name: 'OrderPrintError',
      code: 'notFound',
    } satisfies Partial<OrderPrintError>);

    expect(open).not.toHaveBeenCalled();
  });

  it('reports a missing order when the read comes back empty', async () => {
    const open = vi.spyOn(window, 'open');

    await expect(printSavedOrder('gone', async () => undefined)).rejects.toMatchObject({
      name: 'OrderPrintError',
      code: 'notFound',
    } satisfies Partial<OrderPrintError>);

    expect(open).not.toHaveBeenCalled();
  });

  it('leaves a read failure that is not a missing order to the caller', async () => {
    const failure = new Error('network down');

    await expect(
      printSavedOrder('order-1', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});
