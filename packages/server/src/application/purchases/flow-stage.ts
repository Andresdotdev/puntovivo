/**
 * The step of the Colombian purchase flow a receipt is standing in.
 *
 * The employee must not have to guess what is left. A purchase says which step
 * it is in — `Pendiente`, `Parcial 6/10`, `Recibido`, `Facturado` — and every
 * step is read from stored data:
 *
 * - what the order asked for (`order_items`, in base units) against the lines
 *   of every receipt of that order that actually entered stock;
 * - for a direct purchase with no order, its own lines are both the ordered and
 *   the received quantity;
 * - `invoiced` when a fiscal paper backs the goods: either the remisión that
 *   documents them is already covered by a supplier invoice, or the purchase
 *   itself carries the supplier invoice / the support document the business
 *   issued. A remisión alone never closes the step.
 *
 * @module application/purchases/flow-stage
 */
import { roundQuantity } from '@puntovivo/shared/unit-math';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseInstance } from '../../db/index.js';
import {
  orderItems,
  purchaseItems,
  purchaseRemisions,
  purchases,
  type PurchaseDocumentType,
} from '../../db/schema.js';
import { QUANTITY_EPSILON } from '../../lib/quantity.js';

type PurchaseStatus = NonNullable<(typeof purchases.$inferSelect)['status']>;

/** `pending` = nothing entered, `partial` = less than ordered, `received` =
 * the goods are in and the invoice is missing, `invoiced` = the remisión that
 * documents them is already covered by a supplier invoice. */
export type PurchaseFlowStage = 'pending' | 'partial' | 'received' | 'invoiced';

export interface PurchaseFlowProgress {
  stage: PurchaseFlowStage;
  /** Quantity the order asked for, in base units (own lines for a direct purchase). */
  orderedQuantity: number;
  /** Quantity that actually entered stock, in base units. */
  receivedQuantity: number;
}

/**
 * Purchase statuses whose lines entered stock.
 *
 * Mirrors the receipt-progress rule the order record already applies
 * (`getOrderRecord` in `trpc/routers/orders/helpers`), so the step shown on the
 * purchases screen can never disagree with the progress shown on its order.
 * Returns do not subtract from it: the goods did arrive, what went back is a
 * separate fact.
 */
export const RECEIVED_PURCHASE_STATUSES = ['completed', 'partial_returned', 'returned'] as const;
const RECEIVED_PURCHASE_STATUS_SET = new Set<string>(RECEIVED_PURCHASE_STATUSES);

/**
 * Papers that carry fiscal value and therefore close the receipt as
 * `facturado` on their own: the supplier invoice, and the support document the
 * business issues when the provider is not obliged to invoice. The remisión is
 * absent on purpose: it proves delivery, never the tax event.
 */
export const FISCAL_PURCHASE_DOCUMENT_TYPES = ['invoice', 'support_document'] as const;
const FISCAL_PURCHASE_DOCUMENT_TYPE_SET = new Set<string>(FISCAL_PURCHASE_DOCUMENT_TYPES);

export function isFiscalPurchaseDocument(
  documentType: PurchaseDocumentType | null | undefined
): boolean {
  return documentType != null && FISCAL_PURCHASE_DOCUMENT_TYPE_SET.has(documentType);
}

export interface PurchaseFlowInput {
  /** Null when the receipt has no stored remisión yet. */
  invoicingStatus: 'pending' | 'invoiced' | null;
  /** Paper recorded on the purchase itself; null when none was captured. */
  documentType: PurchaseDocumentType | null;
  orderedQuantity: number;
  receivedQuantity: number;
}

/**
 * Resolve the step from the quantities and the documents alone.
 *
 * `facturado` is the last step of a complete flow, so it requires both the full
 * quantity in and an invoice that backs what arrived — either the consolidated
 * supplier invoice that covers the remisión, or the fiscal paper recorded on a
 * direct purchase. A short delivery stays `partial` even when its invoice is
 * already on file.
 */
export function resolvePurchaseFlowStage(input: PurchaseFlowInput): PurchaseFlowStage {
  if (input.receivedQuantity <= QUANTITY_EPSILON) {
    return 'pending';
  }
  if (input.receivedQuantity + QUANTITY_EPSILON < input.orderedQuantity) {
    return 'partial';
  }
  const invoiced =
    input.invoicingStatus === 'invoiced' || isFiscalPurchaseDocument(input.documentType);
  return invoiced ? 'invoiced' : 'received';
}

/** Base-unit quantity of one grouped line, canonicalised across float residue. */
function toBaseQuantity(sum: number | null): number {
  return roundQuantity(sum ?? 0, 12);
}

/**
 * Read the flow step of every listed purchase.
 *
 * Batched on purpose: the purchases list is a page, so the ordered lines of its
 * orders, the lines of all their receipts and their remisiones are read with
 * one grouped query each instead of one per row.
 */
export function readPurchaseFlowProgress(
  db: DatabaseInstance,
  tenantId: string,
  rows: ReadonlyArray<{
    id: string;
    orderId: string | null;
    status: PurchaseStatus;
    documentType: PurchaseDocumentType | null;
  }>
): Map<string, PurchaseFlowProgress> {
  const progressByPurchaseId = new Map<string, PurchaseFlowProgress>();
  if (rows.length === 0) {
    return progressByPurchaseId;
  }

  const purchaseIds = rows.map(row => row.id);
  const orderIds = [
    ...new Set(
      rows.map(row => row.orderId).filter((orderId): orderId is string => orderId !== null)
    ),
  ];

  const orderedBaseByOrderId = new Map<string, number>();
  const receivedBaseByOrderId = new Map<string, number>();
  if (orderIds.length > 0) {
    const orderedRows = db
      .select({
        orderId: orderItems.orderId,
        baseQuantity: sql<number>`sum(${orderItems.quantity} * ${orderItems.unitEquivalence})`,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .groupBy(orderItems.orderId)
      .all();
    for (const row of orderedRows) {
      orderedBaseByOrderId.set(row.orderId, toBaseQuantity(row.baseQuantity));
    }

    const receivedRows = db
      .select({
        orderId: purchases.orderId,
        baseQuantity: sql<number>`sum(${purchaseItems.quantity} * ${purchaseItems.unitEquivalence})`,
      })
      .from(purchaseItems)
      .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
      .where(
        and(
          eq(purchases.tenantId, tenantId),
          inArray(purchases.orderId, orderIds),
          inArray(purchases.status, [...RECEIVED_PURCHASE_STATUSES])
        )
      )
      .groupBy(purchases.orderId)
      .all();
    for (const row of receivedRows) {
      if (row.orderId) {
        receivedBaseByOrderId.set(row.orderId, toBaseQuantity(row.baseQuantity));
      }
    }
  }

  // Own lines answer two questions: what a direct purchase asked for, and what
  // a receipt holds that never entered stock (a draft, or a voided receipt).
  const ownBaseByPurchaseId = new Map<string, number>();
  const ownRows = db
    .select({
      purchaseId: purchaseItems.purchaseId,
      baseQuantity: sql<number>`sum(${purchaseItems.quantity} * ${purchaseItems.unitEquivalence})`,
    })
    .from(purchaseItems)
    .where(inArray(purchaseItems.purchaseId, purchaseIds))
    .groupBy(purchaseItems.purchaseId)
    .all();
  for (const row of ownRows) {
    ownBaseByPurchaseId.set(row.purchaseId, toBaseQuantity(row.baseQuantity));
  }

  const invoicingStatusByPurchaseId = new Map<string, 'pending' | 'invoiced'>();
  const remisionRows = db
    .select({
      purchaseId: purchaseRemisions.purchaseId,
      invoicingStatus: purchaseRemisions.invoicingStatus,
    })
    .from(purchaseRemisions)
    .where(
      and(
        eq(purchaseRemisions.tenantId, tenantId),
        inArray(purchaseRemisions.purchaseId, purchaseIds)
      )
    )
    .all();
  for (const row of remisionRows) {
    if (row.invoicingStatus) {
      invoicingStatusByPurchaseId.set(row.purchaseId, row.invoicingStatus);
    }
  }

  for (const row of rows) {
    const ownBaseQuantity = ownBaseByPurchaseId.get(row.id) ?? 0;
    const enteredStock = RECEIVED_PURCHASE_STATUS_SET.has(row.status);
    const orderedQuantity = row.orderId
      ? (orderedBaseByOrderId.get(row.orderId) ?? 0)
      : ownBaseQuantity;
    const receivedQuantity = row.orderId
      ? (receivedBaseByOrderId.get(row.orderId) ?? 0)
      : enteredStock
        ? ownBaseQuantity
        : 0;

    progressByPurchaseId.set(row.id, {
      stage: resolvePurchaseFlowStage({
        invoicingStatus: invoicingStatusByPurchaseId.get(row.id) ?? null,
        documentType: row.documentType,
        orderedQuantity,
        receivedQuantity,
      }),
      orderedQuantity,
      receivedQuantity,
    });
  }

  return progressByPurchaseId;
}
