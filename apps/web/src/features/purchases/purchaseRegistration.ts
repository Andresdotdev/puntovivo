/**
 * Registering a purchase together with the paper that backs it.
 *
 * The purchase id only exists once the receipt is committed, so the document
 * cannot be part of the same request: it is uploaded immediately after, in the
 * same flow, with the id the server just assigned.
 *
 * The two steps fail independently on purpose. A rejected receipt is a real
 * failure and propagates. A receipt that landed but whose paper did not upload
 * is *not* lost: it comes back as `failed`, so the caller can offer the
 * attachment again against the purchase that already exists instead of
 * booking a second entry of stock.
 *
 * @module features/purchases/purchaseRegistration
 */

import {
  isPurchaseDocumentMimeType,
  readPurchaseDocumentBase64,
  type PurchaseDocumentMimeType,
} from './purchaseDocumentFile';

export interface AttachPurchaseDocumentPayload {
  purchaseId: string;
  fileName: string;
  mimeType: PurchaseDocumentMimeType;
  documentBase64: string;
}

export type AttachPurchaseDocument = (payload: AttachPurchaseDocumentPayload) => Promise<unknown>;

export type PurchaseDocumentAttachment =
  | { status: 'attached' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown };

export interface PurchaseRegistrationDeps<TCreated extends { id: string }> {
  createPurchase: () => Promise<TCreated>;
  attachDocument: AttachPurchaseDocument;
}

export interface PurchaseRegistrationResult<TCreated extends { id: string }> {
  purchase: TCreated;
  document: PurchaseDocumentAttachment;
}

/** Upload the paper of a purchase that already exists. */
export async function attachPurchaseDocumentFile(
  attachDocument: AttachPurchaseDocument,
  purchaseId: string,
  file: File
): Promise<PurchaseDocumentAttachment> {
  if (!isPurchaseDocumentMimeType(file.type)) {
    return { status: 'failed', error: new Error('Unsupported purchase document type') };
  }
  try {
    await attachDocument({
      purchaseId,
      fileName: file.name,
      mimeType: file.type,
      documentBase64: await readPurchaseDocumentBase64(file),
    });
    return { status: 'attached' };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * Create the receipt, then attach the paper the operator had in hand.
 * Resolves with the committed purchase even when only the upload failed.
 */
export async function registerPurchaseWithDocument<TCreated extends { id: string }>(
  deps: PurchaseRegistrationDeps<TCreated>,
  params: { file: File | null }
): Promise<PurchaseRegistrationResult<TCreated>> {
  const purchase = await deps.createPurchase();
  if (!params.file) {
    return { purchase, document: { status: 'skipped' } };
  }
  return {
    purchase,
    document: await attachPurchaseDocumentFile(deps.attachDocument, purchase.id, params.file),
  };
}
