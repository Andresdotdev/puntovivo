/**
 * What backs a direct purchase (no order) and how it moves the flow step.
 *
 * In Colombia the purchase is accrued when the goods arrive, and the paper
 * that backs that entry decides whether the receipt is already invoiced:
 *
 * - the supplier's invoice (`invoice`) — the normal case, art. 618 ET;
 * - the support document the business itself issues and numbers when the
 *   supplier is not obliged to invoice (`support_document`);
 * - the remisión that travelled with the goods (`remision`), which has no
 *   fiscal value and therefore leaves the purchase pending until the supplier
 *   invoice covers it.
 *
 * These tests exercise the public tRPC surface only: the purchase command
 * records the paper, the purchases list reports the step, and the pending
 * remisiones queue plus the invoice command close the remisión path.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { createServer, type PuntovivoServer } from '../index.js';
import { getDatabase } from '../db/index.js';
import {
  orderItems,
  orders,
  products,
  providers,
  purchases,
  sites,
  unitXProduct,
  units,
  users,
} from '../db/schema.js';
import { appRouter } from '../trpc/router.js';
import { getProductStockTotal } from '../services/inventory-balances.js';
import { registerDevice as registerDeviceService } from '../services/devices/devicesService.js';
import { freshCriticalContext } from './utils/criticalCommandFixture.js';

let server: PuntovivoServer;
let tenantId: string;
let userId: string;
let siteId: string;
let baseUnitId: string;
let testDeviceId: string;
let testDatabaseDirectory: string;

const ISSUED_AT = '2026-11-20';
const DUE_AT = '2026-12-20';

type DirectDocumentType = 'invoice' | 'remision' | 'support_document' | 'other';

interface DirectDocumentInput {
  documentType?: DirectDocumentType;
  documentNumber?: string;
}

function callerFor(site: string = siteId) {
  return appRouter.createCaller(
    freshCriticalContext({
      db: getDatabase(),
      serverApp: server.app,
      tenantId,
      userId,
      email: 'admin@localhost',
      role: 'admin',
      siteId: site,
      deviceId: testDeviceId,
      envelope: {
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
        clientCreatedAt: new Date().toISOString(),
      },
    })
  );
}

async function seedProviderAndProduct() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const providerId = nanoid();
  const productId = nanoid();

  await db.insert(providers).values({
    id: providerId,
    tenantId,
    name: `Direct Document Supplier ${nanoid(6)}`,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(products).values({
    id: productId,
    tenantId,
    name: `Direct Document Product ${nanoid(6)}`,
    sku: `DIRDOC-${nanoid(8)}`,
    price: 10,
    price2: 10,
    price3: 10,
    cost: 10,
    marginPercent1: 0,
    marginPercent2: 0,
    marginPercent3: 0,
    marginAmount1: 0,
    marginAmount2: 0,
    marginAmount3: 0,
    taxRate: 0,
    initialCost: 10,
    minStock: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(unitXProduct).values({
    id: nanoid(),
    productId,
    unitId: baseUnitId,
    equivalence: 1,
    price: 10,
    isBase: true,
    createdAt: now,
    updatedAt: now,
  });

  return { providerId, productId };
}

/** A direct purchase: no order, the goods arrive with their paper. */
function createDirectPurchase(
  providerId: string,
  productId: string,
  quantity: number,
  document: DirectDocumentInput = {}
) {
  return callerFor().purchases.create({
    providerId,
    items: [{ productId, unitId: baseUnitId, quantity, costPerUnit: 10 }],
    ...document,
  });
}

async function listFlow(purchaseId: string, providerId: string) {
  const page = await callerFor().purchases.list({ page: 1, perPage: 50, providerId });
  const row = page.items.find(item => item.id === purchaseId);
  if (!row) throw new Error(`Purchase ${purchaseId} was not listed`);
  return row;
}

function countPurchases() {
  return (
    getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(purchases)
      .where(eq(purchases.tenantId, tenantId))
      .get()?.count ?? 0
  );
}

function stockOf(productId: string) {
  return getProductStockTotal(getDatabase(), tenantId, productId);
}

describe('the document that backs a direct purchase', () => {
  beforeAll(async () => {
    testDatabaseDirectory = mkdtempSync(join(tmpdir(), 'puntovivo-purchase-direct-doc-'));
    server = await createServer({
      dbPath: join(testDatabaseDirectory, 'purchase-direct-doc.db'),
      verbose: false,
    });

    const db = getDatabase();
    const seededUser = await db
      .select()
      .from(users)
      .where(eq(users.email, 'admin@localhost'))
      .get();
    if (!seededUser) throw new Error('Expected seeded admin user');
    tenantId = seededUser.tenantId;
    userId = seededUser.id;

    const seededSite = await db
      .select()
      .from(sites)
      .where(and(eq(sites.tenantId, tenantId), eq(sites.isActive, true)))
      .get();
    if (!seededSite) throw new Error('Expected seeded site');
    siteId = seededSite.id;

    const registration = await registerDeviceService(db, {
      tenantId,
      userId,
      kind: 'web',
      name: 'purchase-direct-document.test',
    });
    testDeviceId = registration.deviceId;

    const seededUnits = await db.select().from(units).where(eq(units.tenantId, tenantId)).all();
    const baseUnit = seededUnits.find(unit => unit.abbreviation === 'UND');
    if (!baseUnit) throw new Error('Expected seeded base unit');
    baseUnitId = baseUnit.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(testDatabaseDirectory, { recursive: true, force: true });
  });

  it('closes a direct purchase with the supplier invoice as facturado', async () => {
    const { providerId, productId } = await seedProviderAndProduct();

    const purchase = await createDirectPurchase(providerId, productId, 3, {
      documentType: 'invoice',
      documentNumber: 'FAC-1001',
    });

    const record = await callerFor().purchases.getById({ id: purchase.id });
    expect(record).toMatchObject({ documentType: 'invoice', documentNumber: 'FAC-1001' });
    expect(record.remision).toBeNull();
    expect(stockOf(productId)).toBe(3);

    expect((await listFlow(purchase.id, providerId)).flow).toEqual({
      stage: 'invoiced',
      orderedQuantity: 3,
      receivedQuantity: 3,
    });
  });

  it('closes a direct purchase with the support document the business issues', async () => {
    const { providerId, productId } = await seedProviderAndProduct();

    const purchase = await createDirectPurchase(providerId, productId, 4, {
      documentType: 'support_document',
      documentNumber: 'DS-0007',
    });

    const record = await callerFor().purchases.getById({ id: purchase.id });
    expect(record).toMatchObject({ documentType: 'support_document', documentNumber: 'DS-0007' });
    expect(record.remision).toBeNull();
    expect(stockOf(productId)).toBe(4);

    expect((await listFlow(purchase.id, providerId)).flow).toEqual({
      stage: 'invoiced',
      orderedQuantity: 4,
      receivedQuantity: 4,
    });
  });

  it('keeps a direct purchase with a remisión pending until the invoice covers it', async () => {
    const { providerId, productId } = await seedProviderAndProduct();

    const purchase = await createDirectPurchase(providerId, productId, 6, {
      documentType: 'remision',
      documentNumber: 'REM-DIRECT-1',
    });

    const record = await callerFor().purchases.getById({ id: purchase.id });
    expect(record.documentType).toBe('remision');
    expect(record.documentNumber).toBe('REM-DIRECT-1');
    if (!record.remision) throw new Error('Expected the direct purchase to record a remisión');
    expect(record.remision).toMatchObject({
      number: 'REM-DIRECT-1',
      purchaseOrderId: null,
      invoicingStatus: 'pending',
      payableInvoiceId: null,
    });

    // Goods in, invoice missing: the paper waits in the pending queue.
    expect((await listFlow(purchase.id, providerId)).flow).toEqual({
      stage: 'received',
      orderedQuantity: 6,
      receivedQuantity: 6,
    });
    const pending = await callerFor().providerPayables.pendingRemisions({ providerId });
    expect(pending.items.map(item => item.id)).toContain(record.remision.id);

    await callerFor().providerPayables.createInvoice({
      providerId,
      remisionIds: [record.remision.id],
      documentNumber: `FAC-${nanoid(6)}`,
      issuedAt: ISSUED_AT,
      dueAt: DUE_AT,
      amount: 60,
    });

    expect((await listFlow(purchase.id, providerId)).flow).toEqual({
      stage: 'invoiced',
      orderedQuantity: 6,
      receivedQuantity: 6,
    });
  });

  it('refuses to enter the same remisión twice for one provider', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    await createDirectPurchase(providerId, productId, 2, {
      documentType: 'remision',
      documentNumber: 'REM-DIRECT-DUP',
    });
    const purchasesAfterFirst = countPurchases();
    const stockAfterFirst = stockOf(productId);

    await expect(
      createDirectPurchase(providerId, productId, 2, {
        documentType: 'remision',
        documentNumber: 'REM-DIRECT-DUP',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A rejected duplicate cannot enter stock twice nor leave a stray purchase.
    expect(countPurchases()).toBe(purchasesAfterFirst);
    expect(stockOf(productId)).toBe(stockAfterFirst);
  });

  it('refuses a remisión without its number and writes nothing', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const purchasesBefore = countPurchases();
    const stockBefore = stockOf(productId);

    await expect(
      createDirectPurchase(providerId, productId, 2, { documentType: 'remision' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      createDirectPurchase(providerId, productId, 2, {
        documentType: 'remision',
        documentNumber: '   ',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(countPurchases()).toBe(purchasesBefore);
    expect(stockOf(productId)).toBe(stockBefore);
  });

  it('keeps a direct purchase with an unclassified paper waiting for its invoice', async () => {
    const { providerId, productId } = await seedProviderAndProduct();

    const purchase = await createDirectPurchase(providerId, productId, 5, {
      documentType: 'other',
      documentNumber: 'OTRO-0001',
    });

    expect((await listFlow(purchase.id, providerId)).flow).toEqual({
      stage: 'received',
      orderedQuantity: 5,
      receivedQuantity: 5,
    });
  });

  it('keeps the ordered flow unchanged when the receipt carries the remisión', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const db = getDatabase();
    const now = new Date().toISOString();
    const orderId = nanoid();
    const orderItemId = nanoid();

    await db.insert(orders).values({
      id: orderId,
      tenantId,
      orderNumber: `PED-${orderId.slice(0, 8)}`,
      providerId,
      siteId,
      status: 'submitted',
      subtotal: 40,
      total: 40,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(orderItems).values({
      id: orderItemId,
      orderId,
      productId,
      quantity: 4,
      unitId: baseUnitId,
      unitEquivalence: 1,
      costPerUnit: 10,
      baseUnitCost: 10,
      total: 40,
    });

    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 4 }],
      remisionNumber: 'REM-DIRECT-ORDER',
    });

    // The order path records its remisión at reception and stays pendiente de
    // facturar, exactly as before this change.
    expect(receipt.remision).toMatchObject({
      number: 'REM-DIRECT-ORDER',
      invoicingStatus: 'pending',
    });
    expect(receipt.documentType).toBeNull();
    expect((await listFlow(receipt.id, providerId)).flow).toEqual({
      stage: 'received',
      orderedQuantity: 4,
      receivedQuantity: 4,
    });
  });
});
