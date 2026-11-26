/**
 * The paper that backs a purchase receipt: one photo or one PDF of the
 * document the supplier left with the goods.
 *
 * The accepted types and the size cap mirror what `purchases.attachDocument`
 * accepts, so the form can refuse a file before the receipt is created instead
 * of discovering it afterwards, when the purchase already exists.
 *
 * @module features/purchases/purchaseDocumentFile
 */

export const PURCHASE_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type PurchaseDocumentMimeType = (typeof PURCHASE_DOCUMENT_MIME_TYPES)[number];

export const PURCHASE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const dataUrlPrefix = /^data:[^;]+;base64,/;

export function isPurchaseDocumentMimeType(value: string): value is PurchaseDocumentMimeType {
  return (PURCHASE_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}

/** A file the server will keep: one of the known papers, inside the size cap.
 * Narrowing the type keeps the API payload honest at the call site. */
export function isAcceptedPurchaseDocument<T extends { type: string; size: number }>(
  file: T
): file is T & { type: PurchaseDocumentMimeType } {
  return isPurchaseDocumentMimeType(file.type) && file.size <= PURCHASE_DOCUMENT_MAX_BYTES;
}

/** Read the paper as base64, without the data-URL prefix the API expects. */
export async function readPurchaseDocumentBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return dataUrl.replace(dataUrlPrefix, '');
}
