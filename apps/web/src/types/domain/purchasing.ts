// purchasing / order domain shapes ( slice 28).

import type { OrderStatus, PurchaseStatus, SyncStatus } from '../ui';

/**
 * Step of the Colombian purchase flow a receipt is standing in.
 *
 * `pending` = nothing entered stock yet, `partial` = less arrived than the
 * order asked for, `received` = the goods are in and the supplier invoice is
 * missing, `invoiced` = the remisión that documents them is already covered by
 * an invoice. The server reads it from the ordered lines, the lines that
 * entered stock and the remisión's invoicing status, never from a guess.
 */
export type PurchaseFlowStage = 'pending' | 'partial' | 'received' | 'invoiced';

export interface PurchaseFlowProgress {
  stage: PurchaseFlowStage;
  /** Quantity the order asked for, in base units (own lines for a direct purchase). */
  orderedQuantity: number;
  /** Quantity that actually entered stock, in base units. */
  receivedQuantity: number;
}

export interface Purchase {
  id: string;
  tenantId: string;
  purchaseNumber: string;
  providerId: string;
  providerName?: string | null;
  orderId?: string | null;
  sourceOrderNumber?: string | null;
  siteId: string;
  siteName?: string | null;
  status: PurchaseStatus;
  items?: PurchaseItem[];
  returnedAmount?: number | null;
  returnedAt?: string | null;
  latestReturnReason?: string | null;
  latestReturnCreatedByName?: string | null;
  returnCount?: number;
  returns?: PurchaseReturn[];
  subtotal: number;
  total: number;
  notes?: string | null;
  /**
   * Paper that backs the receipt. `invoice` is the supplier's invoice;
   * `support_document` is the documento soporte the business issues and
   * numbers when the provider is not obliged to invoice; `remision` is the
   * delivery note, which has no fiscal value and waits for the invoice.
   */
  documentType?: 'invoice' | 'support_document' | 'remision' | 'other' | null;
  documentNumber?: string | null;
  /**
   * Delivery note that arrived with the goods. It is an entity of its own, not
   * a label on the purchase: it carries its number, the date printed on the
   * paper and whether the supplier invoice already covers it.
   */
  remision?: PurchaseRemision | null;
  /**
   * Which step of the flow this receipt is in and what is still missing, so the
   * employee never has to guess what comes next. Absent on records read before
   * the server exposed it.
   */
  flow?: PurchaseFlowProgress | null;
  document?: {
    fileName: string | null;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
  } | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  syncStatus?: SyncStatus | null;
  syncVersion?: number | null;
}

export interface PurchaseRemision {
  id: string;
  tenantId: string;
  providerId: string;
  siteId: string;
  /** Receipt that delivered this note's goods: one receipt, one remisión. */
  purchaseId: string;
  /** Null when the goods arrived as a direct purchase without an order. */
  purchaseOrderId?: string | null;
  number: string;
  /** Issue date on the paper (`YYYY-MM-DD`). */
  issuedAt: string;
  invoicingStatus: 'pending' | 'invoiced';
  payableInvoiceId?: string | null;
  receivedBy: string;
  receivedAt: string;
  notes?: string | null;
}

/**
 * A delivery note waiting for the supplier invoice that covers it.
 *
 * The grouping screen reads the paper, the delivery it documents and what it
 * is still worth after any return, because that value is what the invoice must
 * reconcile against.
 */
export interface PendingPurchaseRemision {
  id: string;
  number: string;
  /** Issue date printed on the paper (`YYYY-MM-DD`). */
  issuedAt: string;
  invoicingStatus: 'pending' | 'invoiced';
  payableInvoiceId?: string | null;
  providerId: string;
  siteId: string;
  siteName?: string | null;
  purchaseId: string;
  purchaseNumber: string;
  purchaseStatus: PurchaseStatus;
  purchaseOrderId?: string | null;
  receivedAt: string;
  notes?: string | null;
  /** Value still held: received minus returned. */
  netTotal: number;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  productId: string;
  sourceOrderItemId?: string | null;
  productName?: string | null;
  productSku?: string | null;
  tracksLots?: boolean;
  tracksSerials?: boolean;
  quantity: number;
  unitId: string;
  unitEquivalence: number;
  unitName?: string | null;
  unitAbbreviation?: string | null;
  costPerUnit: number;
  baseUnitCost: number;
  total: number;
  returnedQuantity?: number;
  remainingQuantity?: number;
  /**
   * Maximum purchase-unit quantity physically returnable at the receiving
   * site when this record was read. Writes still revalidate inside the
   * server transaction because stock can change after this snapshot.
   */
  returnableQuantity: number;
  serials?: Array<{
    id: string;
    serialNumber: string;
    status:
      | 'in_stock'
      | 'in_transit'
      | 'reserved'
      | 'sold'
      | 'returned'
      | 'returned_to_supplier'
      | 'defective'
      | 'missing';
    currentSiteId: string;
  }>;
  lots?: Array<{
    id: string;
    purchaseItemId: string;
    inventoryLotId: string;
    lotNumber: string;
    expiresAt: string | null;
    baseQuantity: number;
    unitCost: number;
    currentOnHand: number;
    currentStatus: string;
    returnedBaseQuantity: number;
    remainingBaseQuantity: number;
    availableBaseQuantity: number;
  }>;
}

export interface PurchaseReturn {
  id: string;
  purchaseId: string;
  returnAmount: number;
  reason?: string | null;
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: PurchaseReturnItem[];
}

export interface PurchaseReturnItem {
  id: string;
  purchaseReturnId: string;
  purchaseItemId: string;
  productId: string;
  productName?: string | null;
  productSku?: string | null;
  quantity: number;
  unitId: string;
  unitEquivalence: number;
  unitName?: string | null;
  unitAbbreviation?: string | null;
  costPerUnit: number;
  baseUnitCost: number;
  total: number;
  lots?: Array<{
    id: string;
    purchaseItemLotId: string;
    inventoryLotId: string;
    lotNumber: string;
    expiresAt: string | null;
    baseQuantity: number;
    unitCost: number;
  }>;
}

export interface Order {
  id: string;
  tenantId: string;
  orderNumber: string;
  providerId: string;
  providerName?: string | null;
  linkedPurchaseCount?: number;
  linkedPurchases?: LinkedOrderPurchase[];
  receivedPurchaseId?: string | null;
  receivedPurchaseNumber?: string | null;
  siteId: string;
  siteName?: string | null;
  status: OrderStatus;
  items?: OrderItem[];
  subtotal: number;
  total: number;
  notes?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  syncStatus?: SyncStatus | null;
  syncVersion?: number | null;
}

export interface LinkedOrderPurchase {
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  total: number;
  createdAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName?: string | null;
  productSku?: string | null;
  tracksLots?: boolean;
  tracksSerials?: boolean;
  quantity: number;
  unitId: string;
  unitEquivalence: number;
  unitName?: string | null;
  unitAbbreviation?: string | null;
  costPerUnit: number;
  baseUnitCost: number;
  total: number;
  receivedQuantity?: number;
  remainingQuantity?: number;
}
