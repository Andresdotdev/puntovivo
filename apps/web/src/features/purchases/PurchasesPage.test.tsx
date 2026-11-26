import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { render } from '@/test/utils';
import { PurchasesPage } from './PurchasesPage';

const { createPurchaseAsync, attachDocumentAsync, invalidate } = vi.hoisted(() => ({
  createPurchaseAsync: vi.fn(),
  attachDocumentAsync: vi.fn(),
  invalidate: vi.fn(async () => undefined),
}));

// Every nested tRPC query leaf the page invalidates after a receipt.
const utilsProxy: unknown = new Proxy(
  {},
  {
    get: () => new Proxy({}, { get: () => ({ invalidate }) }),
  }
);

const emptyQuery = { isLoading: false, error: null, refetch: vi.fn() };

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => utilsProxy,
    purchases: {
      list: {
        useQuery: () => ({
          ...emptyQuery,
          data: { items: [], page: 1, perPage: 50, totalItems: 0, totalPages: 0 },
        }),
      },
      attachDocument: {
        useMutation: () => ({ mutateAsync: attachDocumentAsync, isPending: false }),
      },
    },
    providers: {
      list: {
        useQuery: () => ({
          ...emptyQuery,
          data: {
            items: [{ id: 'provider-1', name: 'Proveedor Uno', isActive: true }],
            page: 1,
            perPage: 100,
            totalItems: 1,
            totalPages: 1,
          },
        }),
      },
    },
    categories: { tree: { useQuery: () => ({ ...emptyQuery, data: { items: [] } }) } },
  },
}));

// Mirrors react-query: `onSuccess` runs once the command resolves, so the
// page's post-receipt bookkeeping stays part of the exercised flow.
vi.mock('@/lib/useCriticalMutation', () => ({
  useCriticalMutation: (
    _path: string,
    options?: { onSuccess?: (data: unknown, variables: unknown) => Promise<void> }
  ) => ({
    isPending: false,
    mutateAsync: async (input: unknown) => {
      const data = await createPurchaseAsync(input);
      await options?.onSuccess?.(data, input);
      return data;
    },
  }),
}));

vi.mock('@/components/feedback/ToastProvider', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: 'admin' } }),
}));

vi.mock('@/features/tenant/TenantProvider', () => ({
  useTenant: () => ({ currentSite: { id: 'site-1', name: 'Principal' } }),
}));

vi.mock('@/features/ai-shared', () => ({
  useAiFeatureFlag: () => ({ enabled: false }),
}));

vi.mock('@/lib/taskMeasurement', () => ({
  isTaskActivationKey: () => false,
  useTaskMeasurementController: () => ({
    ensure: vi.fn(),
    markUsableControl: vi.fn(),
    markFirstProgress: vi.fn(),
    recordInteraction: vi.fn(),
    recordBacktrack: vi.fn(),
    recordValidationError: vi.fn(),
    finish: vi.fn(),
  }),
}));

// The catalog search, the details modal and the remisión panel have their own
// suites; here only the delivery note attached at receipt matters.
vi.mock('@/components/dialogs/ProductSearchDialog', () => ({
  ProductSearchDialog: ({
    isOpen,
    onSelect,
  }: {
    isOpen: boolean;
    onSelect: (selection: unknown) => void;
  }) =>
    isOpen ? (
      <button
        type="button"
        onClick={() =>
          onSelect({
            price: 1000,
            product: {
              id: 'product-1',
              name: 'Resma de papel',
              sku: 'PAP-1',
              cost: 1000,
              stock: 5,
              tracksLots: false,
              tracksSerials: false,
              baseUnitId: 'unit-1',
              baseUnitAbbreviation: 'und',
            },
            unit: {
              id: 'product-unit-1',
              unitId: 'unit-1',
              unitName: 'Unidad',
              unitAbbreviation: 'und',
              equivalence: 1,
              price: 1000,
              isBase: true,
            },
          })
        }
      >
        stub-pick-product
      </button>
    ) : null,
}));

vi.mock('@/features/purchases/PurchaseDetailsModal', () => ({
  PurchaseDetailsModal: () => null,
}));

vi.mock('@/features/purchases/PendingRemisionsPanel', () => ({
  PendingRemisionsPanel: () => null,
}));

vi.mock('@/features/ai-invoice-ocr', () => ({
  InvoiceOcrDialog: () => null,
}));

function paperFile() {
  return new File([new Uint8Array([1, 2, 3, 4])], 'remision.png', { type: 'image/png' });
}

async function openReceiptFormWithOneItem(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Agregar producto' }));
  await user.click(await screen.findByRole('button', { name: 'stub-pick-product' }));
  // The page header and the checkout panel share the same CTA label; either
  // one opens the receipt form.
  await user.click(screen.getAllByRole('button', { name: 'Registrar compra' })[0]!);
  return screen.getByRole('dialog');
}

beforeAll(async () => {
  await i18next.changeLanguage('es');
});

beforeEach(() => {
  createPurchaseAsync.mockReset();
  attachDocumentAsync.mockReset();
  invalidate.mockClear();
  createPurchaseAsync.mockResolvedValue({ id: 'purchase-1', purchaseNumber: 'COM-N-000001' });
  attachDocumentAsync.mockResolvedValue({ id: 'document-1' });
});

describe('PurchasesPage receipt document', () => {
  it('attaches the paper chosen in the form once the purchase exists', async () => {
    const user = userEvent.setup();
    render(<PurchasesPage />);

    const dialog = await openReceiptFormWithOneItem(user);
    await user.selectOptions(within(dialog).getByLabelText('Proveedor'), 'provider-1');
    await user.upload(
      dialog.querySelector('input[type="file"]') as HTMLInputElement,
      paperFile()
    );
    expect(within(dialog).getByText('Archivo: remision.png')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Registrar compra' }));

    await waitFor(() =>
      expect(attachDocumentAsync).toHaveBeenCalledWith({
        purchaseId: 'purchase-1',
        fileName: 'remision.png',
        mimeType: 'image/png',
        documentBase64: 'AQIDBA==',
      })
    );
    expect(createPurchaseAsync).toHaveBeenCalledTimes(1);
    expect(createPurchaseAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'provider-1',
        items: [expect.objectContaining({ productId: 'product-1' })],
      })
    );
    // The id used for the upload only exists after the receipt is committed.
    expect(createPurchaseAsync.mock.invocationCallOrder[0]).toBeLessThan(
      attachDocumentAsync.mock.invocationCallOrder[0]!
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the purchase when the attachment fails and retries only the paper', async () => {
    const user = userEvent.setup();
    attachDocumentAsync.mockRejectedValueOnce(new Error('sin red'));
    render(<PurchasesPage />);

    const dialog = await openReceiptFormWithOneItem(user);
    await user.selectOptions(within(dialog).getByLabelText('Proveedor'), 'provider-1');
    await user.upload(
      dialog.querySelector('input[type="file"]') as HTMLInputElement,
      paperFile()
    );
    await user.click(within(dialog).getByRole('button', { name: 'Registrar compra' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La compra quedó registrada, pero el documento no se pudo adjuntar'
    );
    expect(createPurchaseAsync).toHaveBeenCalledTimes(1);
    expect(attachDocumentAsync).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Reintentar adjunto' }));

    await waitFor(() => expect(attachDocumentAsync).toHaveBeenCalledTimes(2));
    // The retry reuses the receipt that already exists instead of booking a
    // second entry of stock.
    expect(createPurchaseAsync).toHaveBeenCalledTimes(1);
    expect(attachDocumentAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ purchaseId: 'purchase-1', fileName: 'remision.png' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('registers a purchase without any paper exactly as before', async () => {
    const user = userEvent.setup();
    render(<PurchasesPage />);

    const dialog = await openReceiptFormWithOneItem(user);
    await user.selectOptions(within(dialog).getByLabelText('Proveedor'), 'provider-1');
    await user.click(within(dialog).getByRole('button', { name: 'Registrar compra' }));

    await waitFor(() => expect(createPurchaseAsync).toHaveBeenCalledTimes(1));
    expect(createPurchaseAsync).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'provider-1', documentType: undefined })
    );
    expect(attachDocumentAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
