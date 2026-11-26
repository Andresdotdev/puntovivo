import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { render } from '@/test/utils';
import type { Provider } from '@/types';
import { PurchaseFinalizeModal } from './PurchaseFinalizeModal';
import type { PurchaseCartItem } from './purchaseCart';

beforeAll(async () => {
  await i18next.changeLanguage('en');
});

const provider: Provider = {
  id: 'provider-1',
  tenantId: 'tenant-1',
  name: 'Provider One',
  isActive: true,
  version: 0,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const lotItem: PurchaseCartItem = {
  key: 'product-lot:case',
  productId: 'product-lot',
  productName: 'Cold medicine',
  productSku: 'MED-LOT',
  unitId: 'case',
  unitName: 'Case',
  unitEquivalence: 2,
  quantity: 3,
  costPerUnit: 50,
  currentStock: 0,
  tracksLots: true,
  tracksSerials: false,
  serialNumbers: '',
};

/** A four-byte paper: only the File identity matters to the form. */
function paperFile() {
  return new File([new Uint8Array([1, 2, 3, 4])], 'remision.png', { type: 'image/png' });
}

function paperInput() {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

describe('PurchaseFinalizeModal', () => {
  it('reports an invalid attempt and exposes the provider error as an alert', async () => {
    const user = userEvent.setup();
    const onInvalid = vi.fn();
    const onSubmit = vi.fn(async () => undefined);

    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onInvalid={onInvalid}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Provider is required');
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits after provider selection and exposes bounded server feedback', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);

    const { rerender } = render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        providerId: provider.id,
        notes: '',
        documentType: '',
        documentNumber: '',
        documentFile: null,
        lotReceiptsByItemKey: {},
      })
    );

    rerender(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error="Unable to register purchase"
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to register purchase');
  });

  it('carries the receiving document identity when the operator records one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);

    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    await user.selectOptions(screen.getByLabelText('Document type'), 'remision');
    await user.type(screen.getByLabelText('Document number'), 'RM-0042');
    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ documentType: 'remision', documentNumber: 'RM-0042' })
      )
    );
  });

  it('requires the remisión number before submitting a direct purchase', async () => {
    const user = userEvent.setup();
    const onInvalid = vi.fn();
    const onSubmit = vi.fn(async () => undefined);

    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onInvalid={onInvalid}
      />
    );

    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    await user.selectOptions(screen.getByLabelText('Document type'), 'remision');
    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the delivery note number printed on the paper.'
    );
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('records the documento soporte the business issues', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);

    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    await user.selectOptions(screen.getByLabelText('Document type'), 'support_document');
    await user.type(screen.getByLabelText('Document number'), 'DS-0007');
    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ documentType: 'support_document', documentNumber: 'DS-0007' })
      )
    );
  });

  it('requires exact lot identity and submits base-unit receipt provenance', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <PurchaseFinalizeModal
        isOpen
        total={150}
        providers={[provider]}
        items={[lotItem]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    await user.type(screen.getByLabelText('Lot number'), 'LOT-2026-09');
    expect(screen.getByLabelText('Base quantity')).toHaveValue(6);
    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        providerId: provider.id,
        notes: '',
        documentType: '',
        documentNumber: '',
        documentFile: null,
        lotReceiptsByItemKey: {
          [lotItem.key]: [{ lotNumber: 'LOT-2026-09', baseQuantity: 6 }],
        },
      })
    );
  });

  it('carries the paper chosen in the form so it is attached right after registration', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    const paper = paperFile();
    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    await user.upload(paperInput(), paper);

    expect(await screen.findByText('Selected file: remision.png')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ documentFile: paper }))
    );
  });

  it('refuses a file that is neither a photo nor a PDF', async () => {
    const user = userEvent.setup();
    const onInvalid = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onInvalid={onInvalid}
      />
    );

    await user.selectOptions(screen.getByLabelText('Provider'), provider.id);
    // `user.upload` honours the input's accept filter; a file the operator
    // picked by hand (or a camera roll export) still has to be refused here.
    fireEvent.change(paperInput(), {
      target: { files: [new File([new Uint8Array([1])], 'notas.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use a JPG, PNG or WebP photo, or a PDF, up to 10 MB.'
    );
    expect(screen.queryByText(/Selected file/)).not.toBeInTheDocument();
    expect(onInvalid).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Register Purchase' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ documentFile: null }))
    );
  });

  it('shows a purchase registered without its paper and offers the attachment retry', async () => {
    const user = userEvent.setup();
    const onRetryDocument = vi.fn(async () => undefined);
    const onSubmit = vi.fn(async () => undefined);

    render(
      <PurchaseFinalizeModal
        isOpen
        total={125_000}
        providers={[provider]}
        items={[]}
        isSaving={false}
        error={null}
        pendingDocument={{ fileName: 'remision.png' }}
        onClose={vi.fn()}
        onRetryDocument={onRetryDocument}
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The purchase was recorded, but its document could not be attached'
    );
    // The receipt already exists: nothing on this screen may create it again.
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry attachment' }));

    expect(onRetryDocument).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
