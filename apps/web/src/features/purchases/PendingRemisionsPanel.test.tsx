import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import i18n from '@/i18n';
import { render } from '@/test/utils';
import type { Provider } from '@/types';
import { PendingRemisionsPanel } from './PendingRemisionsPanel';

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(async () => undefined),
  createInvoice: vi.fn(),
  refetch: vi.fn(),
  onError: null as null | ((error: unknown) => void),
}));

const pendingRemisions = [
  {
    id: 'remision-1',
    number: 'REM-0001',
    issuedAt: '2026-11-20',
    invoicingStatus: 'pending' as const,
    payableInvoiceId: null,
    providerId: 'provider-1',
    siteId: 'site-1',
    siteName: 'Principal',
    purchaseId: 'purchase-1',
    purchaseNumber: 'COM-000001',
    purchaseStatus: 'completed' as const,
    purchaseOrderId: 'order-1',
    receivedAt: '2026-11-20T12:00:00.000Z',
    notes: null,
    netTotal: 50,
  },
  {
    id: 'remision-2',
    number: 'REM-0002',
    issuedAt: '2026-11-21',
    invoicingStatus: 'pending' as const,
    payableInvoiceId: null,
    providerId: 'provider-1',
    siteId: 'site-1',
    siteName: 'Principal',
    purchaseId: 'purchase-2',
    purchaseNumber: 'COM-000002',
    purchaseStatus: 'completed' as const,
    purchaseOrderId: 'order-2',
    receivedAt: '2026-11-21T12:00:00.000Z',
    notes: null,
    netTotal: 30,
  },
];

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      providerPayables: {
        pendingRemisions: { invalidate: mocks.invalidate },
        availablePurchases: { invalidate: mocks.invalidate },
        overview: { invalidate: mocks.invalidate },
      },
      purchases: { list: { invalidate: mocks.invalidate } },
    }),
    providerPayables: {
      pendingRemisions: {
        useQuery: () => ({
          data: { items: pendingRemisions, total: 2, page: 1, perPage: 50, pageCount: 1 },
          isLoading: false,
          error: null,
          refetch: mocks.refetch,
        }),
      },
    },
  },
}));

vi.mock('@/lib/useCriticalMutation', () => ({
  useCriticalMutation: (
    _path: string,
    options: { onError?: (error: unknown) => void; onSuccess?: () => Promise<void> }
  ) => {
    mocks.onError = options?.onError ?? null;
    return { mutate: mocks.createInvoice, isPending: false };
  },
}));

vi.mock('@/components/feedback/ToastProvider', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const providers = [
  { id: 'provider-1', name: 'ACME Supplier' },
  { id: 'provider-2', name: 'Other Supplier' },
] as Provider[];

describe('PendingRemisionsPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
  });

  it('groups the selected remisiones into one invoice with their net total', async () => {
    const user = userEvent.setup();
    render(<PendingRemisionsPanel providers={providers} />);

    await user.selectOptions(screen.getByTestId('pending-remisions-provider'), 'provider-1');
    expect(await screen.findByText('REM-0001')).toBeInTheDocument();
    expect(screen.getByText('REM-0002')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /group into one invoice/i });
    expect(submit).toBeDisabled();

    await user.click(screen.getByLabelText('Include delivery note REM-0001 in the invoice'));
    await user.click(screen.getByLabelText('Include delivery note REM-0002 in the invoice'));

    // The amount defaults to what the two papers are still worth.
    expect(screen.getByLabelText('Invoice total')).toHaveValue(80);

    await user.type(screen.getByLabelText('Invoice number'), 'FAC-9001');
    await user.click(submit);

    expect(mocks.createInvoice).toHaveBeenCalledWith({
      providerId: 'provider-1',
      remisionIds: ['remision-1', 'remision-2'],
      documentNumber: 'FAC-9001',
      issuedAt: expect.any(String),
      dueAt: expect.any(String),
      amount: 80,
    });
  });

  it('keeps the refusal next to the form when the grouping is rejected', async () => {
    const user = userEvent.setup();
    render(<PendingRemisionsPanel providers={providers} />);

    await user.selectOptions(screen.getByTestId('pending-remisions-provider'), 'provider-1');
    await user.click(await screen.findByLabelText('Include delivery note REM-0001 in the invoice'));
    await user.type(screen.getByLabelText('Invoice number'), 'FAC-9002');

    // A remisión the supplier already invoiced cannot be grouped again.
    await act(async () => {
      mocks.onError?.(new Error('Remisión REM-0001 is already covered by a supplier invoice'));
    });

    await waitFor(() => {
      expect(
        screen.getByText(/already covered by a supplier invoice/i)
      ).toBeInTheDocument();
    });
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });
});
