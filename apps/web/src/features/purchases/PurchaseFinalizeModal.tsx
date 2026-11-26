import { useRef, useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Paperclip } from 'lucide-react';
import { Modal, ModalButton } from '@/components/form-controls/Modal';
import { formatCurrency } from '@/lib/utils';
import type { Provider } from '@/types';
import { LotReceiptEditor } from '@/features/inventory/LotEditors';
import {
  createLotReceiptDraft,
  normalizeLotReceipts,
  quantitiesMatch,
  sumLotReceiptQuantity,
  type LotReceiptDraft,
  type LotReceiptPayload,
} from '@/features/inventory/lotForm';
import type { PurchaseCartItem } from './purchaseCart';
import { PURCHASE_DOCUMENT_MIME_TYPES, isAcceptedPurchaseDocument } from './purchaseDocumentFile';
import { useSingleFlightSubmit } from '@/lib/useSingleFlightSubmit';

export interface PurchaseFinalizeValues {
  providerId: string;
  notes: string;
  documentType: '' | 'invoice' | 'support_document' | 'remision' | 'other';
  documentNumber: string;
  /**
   * The paper that backs the receipt when the operator has it in hand.
   * Uploaded once the purchase exists; see `registerPurchaseWithDocument`.
   */
  documentFile: File | null;
  lotReceiptsByItemKey: Record<string, LotReceiptPayload[]>;
}

interface PurchaseFinalizeModalProps {
  isOpen: boolean;
  total: number;
  providers: Provider[];
  items: PurchaseCartItem[];
  isSaving: boolean;
  error: string | null;
  /**
   * Set once the purchase is committed and only its paper is missing. The form
   * is replaced by the pending attachment, so nothing on this screen can
   * register the same delivery twice.
   */
  pendingDocument?: { fileName: string } | null | undefined;
  onClose: () => void;
  onSubmit: (values: PurchaseFinalizeValues) => Promise<void>;
  onRetryDocument?: (() => Promise<void>) | undefined;
  onInvalid?: (() => void) | undefined;
}

export function PurchaseFinalizeModal({
  isOpen,
  total,
  providers,
  items,
  isSaving,
  error,
  pendingDocument = null,
  onClose,
  onSubmit,
  onRetryDocument,
  onInvalid,
}: PurchaseFinalizeModalProps) {
  const { t } = useTranslation(['purchases', 'common', 'inventory']);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const form = useForm<PurchaseFinalizeValues>({
    defaultValues: {
      providerId: '',
      notes: '',
      documentType: '',
      documentNumber: '',
      documentFile: null,
      lotReceiptsByItemKey: {},
    },
  });
  const [lotDraftsByItemKey, setLotDraftsByItemKey] = useState<Record<string, LotReceiptDraft[]>>(
    () =>
      Object.fromEntries(
        items
          .filter(item => item.tracksLots)
          .map(item => [
            item.key,
            [
              createLotReceiptDraft({
                baseQuantity: String(item.quantity * item.unitEquivalence),
              }),
            ],
          ])
      )
  );

  // Mirrors the confirm button's disabled expression, so the Enter path
  // cannot submit what the click path refuses.
  const canSubmit = !isSaving;
  const handleSubmit = form.handleSubmit(
    useSingleFlightSubmit(canSubmit, async values => {
      const lotReceiptsByItemKey: Record<string, LotReceiptPayload[]> = {};
      for (const item of items.filter(candidate => candidate.tracksLots)) {
        const drafts = lotDraftsByItemKey[item.key] ?? [];
        const normalized = normalizeLotReceipts(drafts);
        const expected = item.quantity * item.unitEquivalence;
        if (!normalized || !quantitiesMatch(sumLotReceiptQuantity(drafts), expected)) {
          form.setError('root', {
            type: 'manual',
            message: t('inventory:lots.receipt.invalidExact'),
          });
          onInvalid?.();
          return;
        }
        lotReceiptsByItemKey[item.key] = normalized;
      }
      await onSubmit({ ...values, documentFile, lotReceiptsByItemKey });
    }),
    () => onInvalid?.()
  );

  // A file the server would reject is refused here, while the purchase does not
  // exist yet: discovering it afterwards would leave a registered purchase with
  // no paper to back it.
  const handleDocumentSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!isAcceptedPurchaseDocument(file)) {
      setDocumentFile(null);
      form.setError('root', { type: 'manual', message: t('purchases:document.invalidFile') });
      onInvalid?.();
      return;
    }
    form.clearErrors('root');
    setDocumentFile(file);
  };

  const handleRemoveDocument = () => {
    setDocumentFile(null);
    form.clearErrors('root');
  };

  const footer = pendingDocument ? (
    <>
      <ModalButton onClick={onClose} disabled={isSaving}>
        {t('common:actions.close')}
      </ModalButton>
      <ModalButton
        variant="primary"
        onClick={() => void onRetryDocument?.()}
        disabled={isSaving}
      >
        {isSaving ? t('purchases:document.retryingAttach') : t('purchases:document.retryAttach')}
      </ModalButton>
    </>
  ) : (
    <>
      <ModalButton onClick={onClose} disabled={isSaving}>
        {t('common:actions.cancel')}
      </ModalButton>
      <ModalButton variant="primary" onClick={handleSubmit} disabled={isSaving}>
        {isSaving ? t('purchases:checkout.submitting') : t('purchases:checkout.register')}
      </ModalButton>
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('checkout.register')} footer={footer}>
      {pendingDocument ? (
        <div className="rounded-xl border border-warning-300 bg-warning-50 px-4 py-4">
          <p role="alert" className="text-sm text-warning-800">
            <span className="block">
              {t('purchases:document.registeredWithoutDocument', {
                name: pendingDocument.fileName,
              })}
            </span>
            {error && <span className="mt-1 block text-danger-600">{error}</span>}
          </p>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="rounded-xl border border-primary-200 bg-primary-50 px-4 py-4">
            <p className="text-sm text-primary-700">{t('purchases:checkout.purchaseTotal')}</p>
            <p className="mt-1 text-3xl font-semibold text-primary-900">{formatCurrency(total)}</p>
          </div>

          <div>
            <label htmlFor="purchase-provider" className="label">
              {t('purchases:checkout.provider')}
            </label>
            <select
              id="purchase-provider"
              className="input mt-1"
              {...form.register('providerId', {
                required: t('purchases:checkout.providerRequired'),
              })}
            >
              <option value="">{t('purchases:checkout.selectProvider')}</option>
              {providers.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            {form.formState.errors.providerId && (
              <p className="mt-1 text-sm text-danger-500" role="alert">
                {form.formState.errors.providerId.message}
              </p>
            )}
          </div>

          {items
            .filter(item => item.tracksLots)
            .map(item => (
              <section key={item.key} className="rounded-xl border border-secondary-200 p-4">
                <p className="font-medium text-secondary-900">{item.productName}</p>
                <p className="text-xs text-secondary-500">
                  {item.productSku} · {item.unitName}
                </p>
                <LotReceiptEditor
                  idPrefix={`purchase-${item.key.replaceAll(':', '-')}`}
                  value={lotDraftsByItemKey[item.key] ?? []}
                  expectedBaseQuantity={item.quantity * item.unitEquivalence}
                  disabled={isSaving}
                  onChange={next =>
                    setLotDraftsByItemKey(current => ({ ...current, [item.key]: next }))
                  }
                />
              </section>
            ))}

          <div>
            <label htmlFor="purchase-notes" className="label">
              {t('purchases:details.notes')}
            </label>
            <textarea
              id="purchase-notes"
              className="input mt-1 min-h-[96px]"
              placeholder={t('checkout.notesPlaceholder')}
              {...form.register('notes')}
            />
          </div>

          {/* The paper arrives with the goods, so it is captured here and not in
              a second visit to the purchase afterwards. */}
          <div>
            <p className="label" id="purchase-document-attachment">
              {t('purchases:document.attachmentField')}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={PURCHASE_DOCUMENT_MIME_TYPES.join(',')}
              aria-labelledby="purchase-document-attachment"
              disabled={isSaving}
              onChange={handleDocumentSelected}
            />
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-secondary inline-flex items-center gap-2"
                disabled={isSaving}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" aria-hidden="true" />
                {t('purchases:document.attachLabel')}
              </button>
              {documentFile ? (
                <>
                  <span className="text-sm text-secondary-700">
                    {t('purchases:document.attachmentSelected', { name: documentFile.name })}
                  </span>
                  <button type="button" className="btn-ghost" onClick={handleRemoveDocument}>
                    {t('purchases:document.attachmentRemove')}
                  </button>
                </>
              ) : (
                <span className="text-xs text-secondary-500">
                  {t('purchases:document.attachmentHelp')}
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="purchase-document-type" className="label">
                {t('purchases:document.typeLabel')}
              </label>
              <select
                id="purchase-document-type"
                className="input mt-1"
                aria-label={t('purchases:document.typeLabel')}
                {...form.register('documentType')}
              >
                <option value="">{t('purchases:document.typeNone')}</option>
                <option value="invoice">{t('purchases:document.typeInvoice')}</option>
                <option value="support_document">
                  {t('purchases:document.typeSupportDocument')}
                </option>
                <option value="remision">{t('purchases:document.typeRemision')}</option>
                <option value="other">{t('purchases:document.typeOther')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="purchase-document-number" className="label">
                {t('purchases:document.numberLabel')}
              </label>
              <input
                id="purchase-document-number"
                className="input mt-1"
                maxLength={120}
                placeholder={t('purchases:document.numberPlaceholder')}
                {...form.register('documentNumber', {
                  // A remisión is the paper that waits for the invoice, so its
                  // number is what identifies it: without one the pending queue
                  // could neither list it nor match it to its invoice.
                  validate: value =>
                    form.getValues('documentType') !== 'remision' ||
                    value.trim().length > 0 ||
                    t('purchases:document.numberRequiredForRemision'),
                })}
              />
              {form.formState.errors.documentNumber && (
                <p className="mt-1 text-sm text-danger-500" role="alert">
                  {form.formState.errors.documentNumber.message}
                </p>
              )}
            </div>
          </div>

          {(form.formState.errors.root?.message || error) && (
            <p className="text-sm text-danger-500" role="alert">
              {form.formState.errors.root?.message ?? error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
