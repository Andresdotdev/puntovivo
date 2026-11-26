/**
 * Remisión (delivery note) captured at goods reception.
 *
 * The delivery note is the paper that travels with the goods and it is
 * captured when the operator receives, not when the purchase order is
 * registered. These tests exercise the public tRPC surface only: the
 * reception command records the remisión, its number is mandatory and unique
 * per provider, and the stored identity carries an invoicing status.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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

let operationCounter = 0;

function callerFor(site: string = siteId) {
  operationCounter += 1;
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
    name: `Remision Supplier ${nanoid(6)}`,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(products).values({
    id: productId,
    tenantId,
    name: `Remision Product ${nanoid(6)}`,
    sku: `REM-${nanoid(8)}`,
    price: 10,
    price2: 10,
    price3: 10,
    cost: 3,
    marginPercent1: 0,
    marginPercent2: 0,
    marginPercent3: 0,
    marginAmount1: 0,
    marginAmount2: 0,
    marginAmount3: 0,
    taxRate: 0,
    initialCost: 3,
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

async function seedSubmittedOrder(providerId: string, productId: string, quantity = 2) {
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

function countPurchases() {
  return getDatabase().select().from(purchases).where(eq(purchases.tenantId, tenantId)).all()
    .length;
}

describe('Purchase remisions', () => {
  beforeAll(async () => {
    testDatabaseDirectory = mkdtempSync(join(tmpdir(), 'puntovivo-purchase-remisions-'));
    server = await createServer({
      dbPath: join(testDatabaseDirectory, 'purchase-remisions.db'),
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
      name: 'purchase-remisions.test',
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

  it('records the remisión captured at reception as its own document', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId);
    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 2 }],
      remisionNumber: 'REM-0001',
    });

    expect(receipt.remision).toMatchObject({
      number: 'REM-0001',
      providerId,
      siteId,
      purchaseId: receipt.id,
      purchaseOrderId: orderId,
      invoicingStatus: 'pending',
      payableInvoiceId: null,
    });
    expect(receipt.remision?.receivedAt).toBeTruthy();
    expect(receipt.remision?.issuedAt).toBeTruthy();

    // The remisión is an entity of its own, no longer a label on the purchase.
    const purchaseRow = getDatabase()
      .select({ documentType: purchases.documentType, documentNumber: purchases.documentNumber })
      .from(purchases)
      .where(eq(purchases.id, receipt.id))
      .get();
    expect(purchaseRow).toMatchObject({ documentType: null, documentNumber: null });
  });

  it('keeps the remisión date the operator read on the paper', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId);
    const receipt = await callerFor().purchases.createFromOrder({
      orderId,
      items: [{ orderItemId, quantity: 1 }],
      remisionNumber: 'REM-DATED-1',
      remisionDate: '2026-11-20',
    });

    expect(receipt.remision).toMatchObject({
      number: 'REM-DATED-1',
      issuedAt: '2026-11-20',
      invoicingStatus: 'pending',
    });
  });

  it('rejects a receipt without a remisión number and writes nothing', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId);
    const purchasesBefore = countPurchases();
    const stockBefore = getProductStockTotal(getDatabase(), tenantId, productId);

    await expect(
      // @ts-expect-error Intentional: the remisión number is the one mandatory
      // field of the reception step, so a call without it cannot type-check.
      callerFor().purchases.createFromOrder({
        orderId,
        items: [{ orderItemId, quantity: 2 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      callerFor().purchases.createFromOrder({
        orderId,
        items: [{ orderItemId, quantity: 2 }],
        remisionNumber: '   ',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(countPurchases()).toBe(purchasesBefore);
    expect(getProductStockTotal(getDatabase(), tenantId, productId)).toBe(stockBefore);
    const orderRow = getDatabase()
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();
    expect(orderRow?.status).toBe('submitted');
  });

  it('rejects a remisión number already recorded for the same provider', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const first = await seedSubmittedOrder(providerId, productId);
    const second = await seedSubmittedOrder(providerId, productId);
    await callerFor().purchases.createFromOrder({
      orderId: first.orderId,
      items: [{ orderItemId: first.orderItemId, quantity: 2 }],
      remisionNumber: 'REM-DUPLICATE',
    });
    const purchasesAfterFirst = countPurchases();
    const stockAfterFirst = getProductStockTotal(getDatabase(), tenantId, productId);

    await expect(
      callerFor().purchases.createFromOrder({
        orderId: second.orderId,
        items: [{ orderItemId: second.orderItemId, quantity: 2 }],
        remisionNumber: 'REM-DUPLICATE',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A rejected duplicate cannot enter stock twice nor leave a stray receipt.
    expect(countPurchases()).toBe(purchasesAfterFirst);
    expect(getProductStockTotal(getDatabase(), tenantId, productId)).toBe(stockAfterFirst);
    const secondOrder = getDatabase()
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, second.orderId))
      .get();
    expect(secondOrder?.status).toBe('submitted');
  });

  it('accepts the same remisión number from a different provider', async () => {
    const first = await seedProviderAndProduct();
    const second = await seedProviderAndProduct();
    const firstOrder = await seedSubmittedOrder(first.providerId, first.productId);
    const secondOrder = await seedSubmittedOrder(second.providerId, second.productId);
    const firstReceipt = await callerFor().purchases.createFromOrder({
      orderId: firstOrder.orderId,
      items: [{ orderItemId: firstOrder.orderItemId, quantity: 1 }],
      remisionNumber: 'REM-SHARED-1',
    });
    const secondReceipt = await callerFor().purchases.createFromOrder({
      orderId: secondOrder.orderId,
      items: [{ orderItemId: secondOrder.orderItemId, quantity: 1 }],
      remisionNumber: 'REM-SHARED-1',
    });

    expect(firstReceipt.remision).toMatchObject({
      number: 'REM-SHARED-1',
      providerId: first.providerId,
    });
    expect(secondReceipt.remision).toMatchObject({
      number: 'REM-SHARED-1',
      providerId: second.providerId,
    });
  });
});
