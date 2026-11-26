/**
 * What the covered deliveries actually left in the store, per product.
 *
 * Both the reconciliation of a supplier invoice and the lines derived from the
 * remisiones an invoice groups read the same numbers: received base units and
 * value minus what was sent back to the provider. Sharing the read keeps the
 * two paths from disagreeing about what "received" means.
 *
 * @module application/provider-payables/received-lines
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { roundQuantity } from '@puntovivo/shared/unit-math';

import type { DatabaseInstance } from '../../db/index.js';
import { purchaseItems, purchaseReturnItems, purchaseReturns } from '../../db/schema.js';
import { roundMoney } from '../../lib/money.js';

export interface ReceivedNetLine {
  productId: string;
  receivedQuantity: number;
  returnedQuantity: number;
  netQuantity: number;
  receivedTotal: number;
  returnedTotal: number;
  netTotal: number;
}

export interface DerivedInvoiceLine {
  productId: string;
  quantity: number;
  unitCost: number;
}

/** Received minus returned, per product, across the given purchases. */
export function readReceivedNetLines(
  db: DatabaseInstance,
  tenantId: string,
  purchaseIds: readonly string[]
): ReceivedNetLine[] {
  if (purchaseIds.length === 0) return [];
  const received = db
    .select({
      productId: purchaseItems.productId,
      baseQuantity: sql<number>`sum(${purchaseItems.quantity} * ${purchaseItems.unitEquivalence})`,
      lineTotal: sql<number>`sum(${purchaseItems.total})`,
    })
    .from(purchaseItems)
    .where(inArray(purchaseItems.purchaseId, purchaseIds))
    .groupBy(purchaseItems.productId)
    .all();
  // Goods sent back to the provider leave the store, so they cannot be
  // invoiced: what reconciles is received minus returned, in base units and in
  // value. Without this netting, a partially returned delivery reconciled as
  // if nothing had come back.
  const returned = db
    .select({
      productId: purchaseReturnItems.productId,
      baseQuantity: sql<number>`sum(${purchaseReturnItems.quantity} * ${purchaseReturnItems.unitEquivalence})`,
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
    .groupBy(purchaseReturnItems.productId)
    .all();
  const receivedByProduct = new Map(received.map(row => [row.productId, row] as const));
  const returnedByProduct = new Map(returned.map(row => [row.productId, row] as const));

  const productIds = new Set([...receivedByProduct.keys(), ...returnedByProduct.keys()]);
  return [...productIds].sort().map(productId => {
    const receivedRow = receivedByProduct.get(productId);
    const returnedRow = returnedByProduct.get(productId);
    const receivedQuantity = receivedRow ? Number(receivedRow.baseQuantity) : 0;
    const returnedQuantity = returnedRow ? Number(returnedRow.baseQuantity) : 0;
    const receivedTotal = receivedRow ? roundMoney(Number(receivedRow.lineTotal)) : 0;
    const returnedTotal = returnedRow ? roundMoney(Number(returnedRow.lineTotal)) : 0;
    return {
      productId,
      receivedQuantity,
      returnedQuantity,
      netQuantity: roundQuantity(receivedQuantity - returnedQuantity, 12),
      receivedTotal,
      returnedTotal,
      netTotal: roundMoney(receivedTotal - returnedTotal),
    };
  });
}

/**
 * The invoice lines a grouped invoice must carry: one per product the covered
 * remisiones still hold, at the base-unit rate that reproduces its net value.
 * Products that went back entirely leave no line.
 */
export function deriveInvoiceLinesFromReceived(
  lines: readonly ReceivedNetLine[]
): DerivedInvoiceLine[] {
  return lines
    .filter(line => line.netQuantity > 0)
    .map(line => ({
      productId: line.productId,
      quantity: line.netQuantity,
      unitCost: line.netTotal / line.netQuantity,
    }));
}
