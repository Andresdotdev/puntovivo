/**
 * Pending delivery notes of one provider.
 *
 * A remisión waits `pending` from the moment the goods are received until the
 * supplier invoice that covers it arrives. This is that waiting queue: the
 * operator opens the provider, sees the papers the supplier has not invoiced
 * yet, and groups them into one invoice.
 *
 * The money each paper is worth is reported net of whatever came back to the
 * provider, because that is exactly what the invoice is reconciled against.
 *
 * @module application/provider-payables/pending-remisions
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../db/index.js';
import {
  purchaseItems,
  purchaseRemisions,
  purchaseReturnItems,
  purchaseReturns,
  purchases,
  sites,
} from '../../db/schema.js';
import { roundMoney } from '../../lib/money.js';
import type { PendingProviderRemisionsInput } from '../../trpc/schemas/providerPayables.js';

/** Shared bounded projection: the waiting queue the invoice grouping feeds on. */
export function readPendingProviderRemisions(
  db: DatabaseInstance,
  tenantId: string,
  input: PendingProviderRemisionsInput
) {
  const purchaseJoin = and(
    eq(purchases.id, purchaseRemisions.purchaseId),
    eq(purchases.tenantId, tenantId)
  );
  const siteJoin = and(
    eq(sites.id, purchaseRemisions.siteId),
    eq(sites.tenantId, tenantId)
  );
  const conditions = and(
    eq(purchaseRemisions.tenantId, tenantId),
    eq(purchaseRemisions.providerId, input.providerId),
    eq(purchaseRemisions.invoicingStatus, 'pending'),
    input.siteId ? eq(purchaseRemisions.siteId, input.siteId) : undefined,
    // Literal substring matching, like the purchase picker: '%' and '_' in a
    // number are characters, not wildcards.
    input.search
      ? sql`(instr(lower(${purchaseRemisions.number}), lower(${input.search})) > 0 OR instr(lower(${purchases.purchaseNumber}), lower(${input.search})) > 0)`
      : undefined
  );

  // Count and rows describe the same SQLite read snapshot; another terminal
  // may invoice a remisión, but cannot make this response disagree with itself.
  return db.transaction(tx => {
    const total =
      tx
        .select({ count: sql<number>`count(*)` })
        .from(purchaseRemisions)
        .innerJoin(purchases, purchaseJoin)
        .where(conditions)
        .get()?.count ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / input.perPage));
    const page = Math.min(input.page, pageCount);
    const rows = tx
      .select({
        id: purchaseRemisions.id,
        number: purchaseRemisions.number,
        issuedAt: purchaseRemisions.issuedAt,
        invoicingStatus: purchaseRemisions.invoicingStatus,
        payableInvoiceId: purchaseRemisions.payableInvoiceId,
        providerId: purchaseRemisions.providerId,
        siteId: purchaseRemisions.siteId,
        siteName: sites.name,
        purchaseId: purchaseRemisions.purchaseId,
        purchaseNumber: purchases.purchaseNumber,
        purchaseStatus: purchases.status,
        purchaseOrderId: purchaseRemisions.purchaseOrderId,
        receivedAt: purchaseRemisions.receivedAt,
        notes: purchaseRemisions.notes,
      })
      .from(purchaseRemisions)
      .innerJoin(purchases, purchaseJoin)
      .innerJoin(sites, siteJoin)
      .where(conditions)
      .orderBy(
        asc(purchaseRemisions.issuedAt),
        asc(purchaseRemisions.createdAt),
        asc(purchaseRemisions.id)
      )
      .limit(input.perPage)
      .offset((page - 1) * input.perPage)
      .all();

    const purchaseIds = rows.map(row => row.purchaseId);
    const netTotals = readNetTotalsByPurchase(tx, tenantId, purchaseIds);
    const items = rows.map(row => ({
      ...row,
      /** What this paper is worth today: received minus returned. */
      netTotal: netTotals.get(row.purchaseId) ?? 0,
    }));
    return { items, total, page, perPage: input.perPage, pageCount };
  });
}

/**
 * Value still held by each delivery, net of the goods sent back.
 *
 * Read in one pair of grouped queries instead of per row: the queue is bounded
 * by `perPage`, but a page of remisiones should never fan out into two reads
 * per paper.
 */
export function readNetTotalsByPurchase(
  db: DatabaseInstance,
  tenantId: string,
  purchaseIds: readonly string[]
): Map<string, number> {
  if (purchaseIds.length === 0) return new Map();
  const received = db
    .select({
      purchaseId: purchaseItems.purchaseId,
      lineTotal: sql<number>`sum(${purchaseItems.total})`,
    })
    .from(purchaseItems)
    .where(inArray(purchaseItems.purchaseId, purchaseIds))
    .groupBy(purchaseItems.purchaseId)
    .all();
  const returned = db
    .select({
      purchaseId: purchaseReturns.purchaseId,
      lineTotal: sql<number>`sum(${purchaseReturnItems.total})`,
    })
    .from(purchaseReturnItems)
    .innerJoin(purchaseReturns, eq(purchaseReturnItems.purchaseReturnId, purchaseReturns.id))
    .where(
      and(
        eq(purchaseReturns.tenantId, tenantId),
        inArray(purchaseReturns.purchaseId, purchaseIds)
      )
    )
    .groupBy(purchaseReturns.purchaseId)
    .all();
  const returnedByPurchase = new Map(
    returned.map(row => [row.purchaseId, roundMoney(Number(row.lineTotal))] as const)
  );
  return new Map(
    received.map(row => [
      row.purchaseId,
      roundMoney(
        roundMoney(Number(row.lineTotal)) - (returnedByPurchase.get(row.purchaseId) ?? 0)
      ),
    ] as const)
  );
}
