/**
 * Remisión (delivery note) captured when the goods are received.
 *
 * The delivery note is the paper the transport hands over with the goods and
 * it belongs to the reception step, not to the purchase-order registration.
 * It is logistics evidence, never a fiscal document: it carries its own
 * identity and waits, `pending`, until the supplier invoice that covers it
 * consolidates it.
 *
 * @module application/purchases/remisions
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { DatabaseInstance } from '../../db/index.js';
import { purchaseRemisions } from '../../db/schema.js';

export interface RecordPurchaseRemisionInput {
  tenantId: string;
  providerId: string;
  siteId: string;
  /** Receipt that delivered this note's goods. One receipt, one remisión. */
  purchaseId: string;
  /** Null for a direct purchase received without an order. */
  purchaseOrderId: string | null;
  /** Supplier-side number printed on the paper. Unique per provider. */
  number: string;
  /** Issue date on the paper (calendar day). */
  issuedAt: string;
  receivedBy: string;
  receivedAt: string;
  notes?: string | null;
}

/**
 * Record the delivery note of one receipt and return its id.
 *
 * Must run inside the receipt transaction: the uniqueness read is only
 * authoritative while SQLite holds the writer, and the unique index
 * `idx_purchase_remisions_provider_number` is the backstop. Rejecting a
 * duplicate here is what stops the same paper from entering stock twice.
 */
export function recordPurchaseRemision(
  db: DatabaseInstance,
  input: RecordPurchaseRemisionInput
): string {
  const number = input.number.trim();
  if (number.length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The remision number cannot be empty',
    });
  }

  const existing = db
    .select({ id: purchaseRemisions.id, purchaseId: purchaseRemisions.purchaseId })
    .from(purchaseRemisions)
    .where(
      and(
        eq(purchaseRemisions.tenantId, input.tenantId),
        eq(purchaseRemisions.providerId, input.providerId),
        eq(purchaseRemisions.number, number)
      )
    )
    .get();

  if (existing) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Remision ${number} was already received from this provider`,
    });
  }

  const id = nanoid();
  db.insert(purchaseRemisions)
    .values({
      id,
      tenantId: input.tenantId,
      providerId: input.providerId,
      siteId: input.siteId,
      purchaseId: input.purchaseId,
      purchaseOrderId: input.purchaseOrderId,
      number,
      issuedAt: input.issuedAt,
      invoicingStatus: 'pending',
      payableInvoiceId: null,
      receivedBy: input.receivedBy,
      receivedAt: input.receivedAt,
      notes: input.notes ?? null,
      syncStatus: 'pending',
      syncVersion: 1,
      createdAt: input.receivedAt,
      updatedAt: input.receivedAt,
    })
    .run();

  return id;
}
