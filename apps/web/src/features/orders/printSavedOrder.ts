import { OrderPrintError, printOrderDocument } from '@/features/orders/orderPrinter';
import type { Order } from '@/types';

/**
 * Reads the stored order for printing.
 *
 * The list only knows an id, and its rows carry no lines, so the document is
 * always built from this read — never from a draft or from a row snapshot.
 */
export type SavedOrderReader = (orderId: string) => Promise<Order | null | undefined>;

function isNotFound(error: unknown): boolean {
  return (error as { data?: { code?: string } }).data?.code === 'NOT_FOUND';
}

/**
 * Print an order that is already saved.
 *
 * The record is read back immediately before printing because another register
 * may have voided or edited the order since the list was loaded. A missing
 * order is reported instead of printing a blank sheet.
 */
export async function printSavedOrder(orderId: string, readOrder: SavedOrderReader): Promise<void> {
  if (!orderId) {
    throw new OrderPrintError('notFound', 'No order was selected to print');
  }

  let order: Order | null | undefined;
  try {
    order = await readOrder(orderId);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    throw new OrderPrintError('notFound', `Order ${orderId} was not found`);
  }

  if (!order) {
    throw new OrderPrintError('notFound', `Order ${orderId} was not found`);
  }

  await printOrderDocument(order);
}
