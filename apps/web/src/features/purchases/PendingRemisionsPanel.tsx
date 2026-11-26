import { useMemo, useState, type FormEvent } from 'react';
import { FilePlus2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useToast } from '@/components/feedback/ToastProvider';
import { invalidateGroups } from '@/lib/invalidateGroups';
import { onErrorToast } from '@/lib/mutationHelpers';
import { trpc } from '@/lib/trpc';
import { translateServerError } from '@/lib/translateServerError';
import { useCriticalMutation } from '@/lib/useCriticalMutation';
import { formatCalendarDay, formatCurrency } from '@/lib/utils';
import type { PendingPurchaseRemision, Provider } from '@/types';

function todayCalendarDay(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calendarDayFromNow(days: number, now: Date = new Date()): string {
  return todayCalendarDay(new Date(now.getTime() + days * 86_400_000));
}

function sumMoney(values: number[]): number {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(2));
}

/**
 * Remisiones pendientes de facturar, por proveedor.
 *
 * When the supplier's invoice arrives it covers one or several of the papers
 * that came with the goods. The operator picks those papers here, writes the
 * invoice's own identity and amount, and the invoice closes every selected
 * remisión at once. The lines are derived server-side from what those
 * deliveries still hold, so the total can only be the one the store kept.
 */
export function PendingRemisionsPanel({
  providers,
  onGrouped,
}: {
  providers: Provider[];
  onGrouped?: () => void;
}) {
  const { t } = useTranslation(['purchases', 'errors']);
  const utils = trpc.useUtils();
  const toast = useToast();
  const [providerId, setProviderId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [documentNumber, setDocumentNumber] = useState('');
  const [issuedAt, setIssuedAt] = useState(() => todayCalendarDay());
  const [dueAt, setDueAt] = useState(() => calendarDayFromNow(30));
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const remisionsQuery = trpc.providerPayables.pendingRemisions.useQuery(
    { providerId, page: 1, perPage: 50 },
    { enabled: providerId.length > 0 }
  );
  const remisions = useMemo(
    () => ((remisionsQuery.data?.items ?? []) as PendingPurchaseRemision[]),
    [remisionsQuery.data]
  );
  const selectedRemisions = remisions.filter(remision => selectedIds.includes(remision.id));
  const selectedTotal = sumMoney(selectedRemisions.map(remision => remision.netTotal));
  const effectiveAmount = amountTouched ? amount : selectedTotal > 0 ? String(selectedTotal) : '';
  const amountValue = Number(effectiveAmount);
  const datesValid = issuedAt.length > 0 && dueAt.length > 0 && dueAt >= issuedAt;

  const createInvoice = useCriticalMutation('providerPayables.createInvoice', {
    onSuccess: async () => {
      await invalidateGroups(utils, [
        u => u.providerPayables.pendingRemisions,
        u => u.providerPayables.availablePurchases,
        u => u.providerPayables.overview,
        u => u.purchases.list,
      ]);
      setSelectedIds([]);
      setDocumentNumber('');
      setAmount('');
      setAmountTouched(false);
      setFormError(null);
      toast.success({
        title: t('purchases:pendingRemisions.toast.success'),
        description: t('purchases:pendingRemisions.toast.successDetail'),
      });
      onGrouped?.();
    },
    onError: onErrorToast(toast, t, {
      titleKey: 'purchases:pendingRemisions.toast.error',
      // The refusal explains itself (lines, amount, an already invoiced
      // remisión), so the form keeps the reason next to the button.
      extra: description => setFormError(description),
    }),
  });

  const canSubmit =
    providerId.length > 0 &&
    selectedRemisions.length > 0 &&
    documentNumber.trim().length > 0 &&
    datesValid &&
    Number.isFinite(amountValue) &&
    amountValue > 0 &&
    !createInvoice.isPending;

  const handleProviderChange = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setSelectedIds([]);
    setAmount('');
    setAmountTouched(false);
    setFormError(null);
  };

  const toggleRemision = (remision: PendingPurchaseRemision) => {
    setFormError(null);
    setSelectedIds(current =>
      current.includes(remision.id)
        ? current.filter(id => id !== remision.id)
        : [...current, remision.id]
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    createInvoice.mutate({
      providerId,
      remisionIds: selectedRemisions.map(remision => remision.id),
      documentNumber: documentNumber.trim(),
      issuedAt,
      dueAt,
      amount: amountValue,
    });
  };

  return (
    <section className="card p-6" data-testid="pending-remisions">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-secondary-900">
            {t('purchases:pendingRemisions.title')}
          </h2>
          <p className="text-sm text-secondary-500">
            {t('purchases:pendingRemisions.description')}
          </p>
        </div>
        <label className="text-sm text-secondary-700">
          {t('purchases:pendingRemisions.provider')}
          <select
            className="input mt-1"
            value={providerId}
            onChange={event => handleProviderChange(event.target.value)}
            data-testid="pending-remisions-provider"
          >
            <option value="">{t('purchases:pendingRemisions.selectProvider')}</option>
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!providerId && (
        <p className="mt-4 text-sm text-secondary-500">
          {t('purchases:pendingRemisions.pickProvider')}
        </p>
      )}

      {providerId && remisionsQuery.error && (
        <div role="alert" className="mt-4 space-y-2 text-sm text-danger-700">
          <p>{translateServerError(remisionsQuery.error, t, t('errors:server.unknown'))}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => void remisionsQuery.refetch()}
          >
            {t('purchases:pendingRemisions.retry')}
          </button>
        </div>
      )}

      {providerId && remisionsQuery.isLoading && (
        <p role="status" className="mt-4 text-sm text-secondary-500">
          {t('purchases:pendingRemisions.loading')}
        </p>
      )}

      {providerId && !remisionsQuery.isLoading && !remisionsQuery.error && remisions.length === 0 && (
        <p className="mt-4 text-sm text-secondary-500">
          {t('purchases:pendingRemisions.empty')}
        </p>
      )}

      {remisions.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-secondary-500">
              <tr>
                <th className="px-3 py-2">
                  {t('purchases:pendingRemisions.columns.select')}
                </th>
                <th className="px-3 py-2">{t('purchases:pendingRemisions.columns.number')}</th>
                <th className="px-3 py-2">{t('purchases:pendingRemisions.columns.issuedAt')}</th>
                <th className="px-3 py-2">{t('purchases:pendingRemisions.columns.purchase')}</th>
                <th className="px-3 py-2">{t('purchases:pendingRemisions.columns.site')}</th>
                <th className="px-3 py-2 text-right">
                  {t('purchases:pendingRemisions.columns.netTotal')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {remisions.map(remision => (
                <tr key={remision.id}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(remision.id)}
                      onChange={() => toggleRemision(remision)}
                      aria-label={t('purchases:pendingRemisions.selectRemision', {
                        number: remision.number,
                      })}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">{remision.number}</td>
                  <td className="px-3 py-2">{formatCalendarDay(remision.issuedAt)}</td>
                  <td className="px-3 py-2 font-mono">{remision.purchaseNumber}</td>
                  <td className="px-3 py-2">{remision.siteName}</td>
                  <td className="px-3 py-2 text-right">
                    {formatCurrency(remision.netTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {remisions.length > 0 && (
        <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
          <p className="text-sm text-secondary-700" role="status">
            {t('purchases:pendingRemisions.selectionSummary', {
              count: selectedRemisions.length,
              total: formatCurrency(selectedTotal),
            })}
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-sm text-secondary-700">
              {t('purchases:pendingRemisions.documentNumber')}
              <input
                className="input mt-1"
                value={documentNumber}
                maxLength={80}
                placeholder="FAC-0001"
                onChange={event => {
                  setDocumentNumber(event.target.value);
                  setFormError(null);
                }}
              />
            </label>
            <label className="text-sm text-secondary-700">
              {t('purchases:pendingRemisions.issuedAt')}
              <input
                className="input mt-1"
                type="date"
                value={issuedAt}
                onChange={event => setIssuedAt(event.target.value)}
              />
            </label>
            <label className="text-sm text-secondary-700">
              {t('purchases:pendingRemisions.dueAt')}
              <input
                className="input mt-1"
                type="date"
                value={dueAt}
                onChange={event => setDueAt(event.target.value)}
              />
            </label>
            <label className="text-sm text-secondary-700">
              {t('purchases:pendingRemisions.amount')}
              <input
                className="input mt-1"
                type="number"
                min="0.01"
                step="0.01"
                value={effectiveAmount}
                onChange={event => {
                  setAmountTouched(true);
                  setAmount(event.target.value);
                  setFormError(null);
                }}
              />
            </label>
          </div>
          {!datesValid && (
            <p className="text-sm text-danger-700" role="alert">
              {t('purchases:pendingRemisions.dateInvalid')}
            </p>
          )}
          {formError && (
            <p className="text-sm text-danger-700" role="alert">
              {formError}
            </p>
          )}
          <div className="flex justify-end">
            <button type="submit" className="btn-primary flex items-center gap-2" disabled={!canSubmit}>
              <FilePlus2 className="h-4 w-4" />
              {createInvoice.isPending
                ? t('purchases:pendingRemisions.submitting')
                : t('purchases:pendingRemisions.submit')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
