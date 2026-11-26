import { describe, expect, it, vi } from 'vitest';

import {
  attachPurchaseDocumentFile,
  registerPurchaseWithDocument,
  type AttachPurchaseDocumentPayload,
} from './purchaseRegistration';

/** Four bytes encode to `AQIDBA==`, which pins the payload that reaches the
 * server without asserting on FileReader internals. */
function paperFile(name = 'remision.png', type = 'image/png') {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

describe('registerPurchaseWithDocument', () => {
  it('creates the purchase first and attaches the paper to the purchase that now exists', async () => {
    const created = { id: 'purchase-1', purchaseNumber: 'COM-000001' };
    const order: string[] = [];
    const createPurchase = vi.fn(async () => {
      order.push('create');
      return created;
    });
    const attachDocument = vi.fn(async (_payload: AttachPurchaseDocumentPayload) => {
      order.push('attach');
      return { id: 'document-1' };
    });

    const result = await registerPurchaseWithDocument(
      { createPurchase, attachDocument },
      { file: paperFile() }
    );

    expect(result.purchase).toBe(created);
    expect(result.document).toEqual({ status: 'attached' });
    // The paper cannot be uploaded before the receipt it belongs to exists.
    expect(order).toEqual(['create', 'attach']);
    expect(attachDocument).toHaveBeenCalledTimes(1);
    expect(attachDocument).toHaveBeenCalledWith({
      purchaseId: 'purchase-1',
      fileName: 'remision.png',
      mimeType: 'image/png',
      documentBase64: 'AQIDBA==',
    });
  });

  it('keeps the registered purchase when the attachment fails', async () => {
    const created = { id: 'purchase-1' };
    const failure = new Error('upload failed');
    const createPurchase = vi.fn(async () => created);
    const attachDocument = vi.fn(async () => {
      throw failure;
    });

    const result = await registerPurchaseWithDocument(
      { createPurchase, attachDocument },
      { file: paperFile() }
    );

    // The receipt is committed: only the paper is missing.
    expect(result.purchase).toBe(created);
    expect(result.document).toEqual({ status: 'failed', error: failure });
    expect(createPurchase).toHaveBeenCalledTimes(1);
  });

  it('never uploads anything when the operator has no paper at hand', async () => {
    const created = { id: 'purchase-1' };
    const createPurchase = vi.fn(async () => created);
    const attachDocument = vi.fn(async () => ({ id: 'document-1' }));

    const result = await registerPurchaseWithDocument(
      { createPurchase, attachDocument },
      { file: null }
    );

    expect(result.purchase).toBe(created);
    expect(result.document).toEqual({ status: 'skipped' });
    expect(attachDocument).not.toHaveBeenCalled();
  });

  it('reports a rejected purchase without attempting the attachment', async () => {
    const createPurchase = vi.fn(async () => {
      throw new Error('stock locked');
    });
    const attachDocument = vi.fn(async () => ({ id: 'document-1' }));

    await expect(
      registerPurchaseWithDocument({ createPurchase, attachDocument }, { file: paperFile() })
    ).rejects.toThrow('stock locked');
    expect(attachDocument).not.toHaveBeenCalled();
  });
});

describe('attachPurchaseDocumentFile', () => {
  it('retries the attachment against the purchase that is already registered', async () => {
    const attachDocument = vi.fn(async (_payload: AttachPurchaseDocumentPayload) => ({
      id: 'document-1',
    }));

    const result = await attachPurchaseDocumentFile(
      attachDocument,
      'purchase-9',
      paperFile('factura.pdf', 'application/pdf')
    );

    expect(result).toEqual({ status: 'attached' });
    expect(attachDocument).toHaveBeenCalledWith({
      purchaseId: 'purchase-9',
      fileName: 'factura.pdf',
      mimeType: 'application/pdf',
      documentBase64: 'AQIDBA==',
    });
  });

  it('reports a failed retry so the operator can try again', async () => {
    const failure = new Error('offline');
    const attachDocument = vi.fn(async () => {
      throw failure;
    });

    const result = await attachPurchaseDocumentFile(attachDocument, 'purchase-9', paperFile());

    expect(result).toEqual({ status: 'failed', error: failure });
  });
});
