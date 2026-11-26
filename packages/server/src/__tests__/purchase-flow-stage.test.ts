/**
 * The step each purchase is standing in, as the purchases screen reads it.
 *
 * The employee must not have to guess what is left: a receipt that has not
 * arrived is `pending`, a delivery shorter than the order is `partial` with the
 * real quantities, goods that arrived without their supplier invoice are
 * `received`, and only a receipt whose remisión is already `invoiced` is
 * `facturado`. Every step is derived from stored data (ordered lines vs the
 * lines that entered stock, plus the remisión invoicing status), never from a
 * guess. These tests exercise the public tRPC surface only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { createServer, type PuntovivoServer } from '../index.js';
import { getDatabase } from '../db/index.js';
import {
  orderItems,
  orders,
  products,
  providers,
  purchaseItems,
  purchases,
  sites,
  unitXProduct,
  units,
  users,
} from '../db/schema.js';
import { appRouter } from '../trpc/router.js';
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
    name: `Flow Stage Supplier ${nanoid(6)}`,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(products).values({
    id: productId,
    tenantId,
    name: `Flow Stage Product ${nanoid(6)}`,
    sku: `FLOW-${nanoid(8)}`,
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

async function seedSubmittedOrder(providerId: string, productId: string, quantity: number) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const orderId = nanoid();
  const orderItemId = nanoid();
  const total = quantity * 10;

  await db.insert(orders).values({
    id: orderId,
    tenantId,
    orderNumber: `PED-${orderId.slice(0, 8)}`,
    providerId,
    siteId,
    status: 'submitted',
    subtotal: total,
    total,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(orderItems).values({
    id: orderItemId,
    orderId,
    productId,
    quantity,
    unitId: baseUnitId,
    unitEquivalence: 1,
    costPerUnit: 10,
    baseUnitCost: 10,
    total,
  });

  return { orderId, orderItemId };
}

/** A purchase registered from an OCR invoice that never entered stock. */
async function seedDraftPurchase(providerId: string, productId: string, quantity: number) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const purchaseId = nanoid();

  await db.insert(purchases).values({
    id: purchaseId,
    tenantId,
    purchaseNumber: `COM-D-${purchaseId.slice(0, 8)}`,
    providerId,
    siteId,
    status: 'draft',
    subtotal: quantity * 10,
    total: quantity * 10,
    notes: 'OCR invoice draft',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(purchaseItems).values({
    id: nanoid(),
    purchaseId,
    productId,
    quantity,
    unitId: baseUnitId,
    unitEquivalence: 1,
    costPerUnit: 10,
    baseUnitCost: 10,
    total: quantity * 10,
  });

  return { purchaseId };
}

async function listFlow(purchaseId: string, providerId?: string) {
  const page = await callerFor().purchases.list({
    page: 1,
    perPage: 50,
    ...(providerId ? { providerId } : {}),
  });
  const row = page.items.find(item => item.id === purchaseId);
  if (!row) throw new Error(`Purchase ${purchaseId} was not listed`);
  return row;
}

describe('purchase flow step on the purchases screen', () => {
  beforeAll(async () => {
    testDatabaseDirectory = mkdtempSync(join(tmpdir(), 'puntovivo-purchase-flow-'));
    server = await createServer({
      dbPath: join(testDatabaseDirectory, 'purchase-flow.db'),
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
      .where(eq(sites.tenantId, tenantId))
      .get();
    if (!seededSite) throw new Error('Expected seeded site');
    siteId = seededSite.id;

    const registration = await registerDeviceService(db, {
      tenantId,
      userId,
      kind: 'web',
      name: 'purchase-flow-stage.test',
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

  it('marks a short delivery as partial with the real quantities (Parcial 6/10)', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId, 10);
    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 6 }],
      remisionNumber: 'REM-FLOW-PARTIAL',
    });

    const row = await listFlow(receipt.id, providerId);

    expect(row.flow).toEqual({
      stage: 'partial',
      orderedQuantity: 10,
      receivedQuantity: 6,
    });
  });

  it('says received when the goods arrived and the invoice has not', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId, 10);
    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 10 }],
      remisionNumber: 'REM-FLOW-RECEIVED',
    });

    const row = await listFlow(receipt.id, providerId);

    expect(row.flow).toEqual({
      stage: 'received',
      orderedQuantity: 10,
      receivedQuantity: 10,
    });
  });

  it('only says facturado once the remisión is invoiced', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId, 10);
    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 10 }],
      remisionNumber: 'REM-FLOW-INVOICED',
    });
    if (!receipt.remision) throw new Error('Expected the receipt to record a remisión');

    // Goods in, invoice missing: still "recibido", never "facturado".
    expect((await listFlow(receipt.id, providerId)).flow?.stage).toBe('received');

    await callerFor().providerPayables.createInvoice({
      providerId,
      remisionIds: [receipt.remision.id],
      documentNumber: `FAC-FLOW-${nanoid(6)}`,
      issuedAt: ISSUED_AT,
      dueAt: DUE_AT,
      amount: 100,
    });

    expect((await listFlow(receipt.id, providerId)).flow).toEqual({
      stage: 'invoiced',
      orderedQuantity: 10,
      receivedQuantity: 10,
    });
  });

  it('says pending while nothing has entered stock', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { purchaseId } = await seedDraftPurchase(providerId, productId, 4);

    const row = await listFlow(purchaseId, providerId);

    expect(row.flow).toEqual({
      stage: 'pending',
      orderedQuantity: 4,
      receivedQuantity: 0,
    });
  });

  it('counts every receipt of the same order, so the last one closes the step', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId, 10);
    const first = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 6 }],
      remisionNumber: 'REM-FLOW-SPLIT-1',
    });

    expect((await listFlow(first.id, providerId)).flow).toEqual({
      stage: 'partial',
      orderedQuantity: 10,
      receivedQuantity: 6,
    });

    const second = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 4 }],
      remisionNumber: 'REM-FLOW-SPLIT-2',
    });

    // The order is complete now, so neither receipt is still short.
    expect((await listFlow(first.id, providerId)).flow).toEqual({
      stage: 'received',
      orderedQuantity: 10,
      receivedQuantity: 10,
    });
    expect((await listFlow(second.id, providerId)).flow).toEqual({
      stage: 'received',
      orderedQuantity: 10,
      receivedQuantity: 10,
    });
  });

  it('treats a direct purchase without an order as received from its own lines', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const purchase = await callerFor().purchases.create({
      providerId,
      items: [{ productId, unitId: baseUnitId, quantity: 3, costPerUnit: 10 }],
    });

    expect((await listFlow(purchase.id, providerId)).flow).toEqual({
      stage: 'received',
      orderedQuantity: 3,
      receivedQuantity: 3,
    });
  });

  it('keeps the purchase list it already returned besides the new step', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId, 5);
    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 5 }],
      remisionNumber: 'REM-FLOW-PRESERVE',
    });

    const page = await callerFor().purchases.list({ page: 1, perPage: 50, providerId });

    expect(page).toMatchObject({ page: 1, perPage: 50, totalItems: 1, totalPages: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: receipt.id,
      purchaseNumber: receipt.purchaseNumber,
      providerId,
      providerName: expect.any(String),
      siteId,
      siteName: expect.any(String),
      orderId,
      status: 'completed',
      subtotal: 50,
      total: 50,
      returnedAmount: 0,
      returnCount: 0,
      createdBy: userId,
    });
    expect(page.items[0]?.createdAt).toBeTruthy();
    // The step travels beside the record, it does not replace it.
    expect(page.items[0]?.flow).toMatchObject({ stage: 'received' });
  });
});
