/**
 * Pending remisiones of a provider and the supplier invoice that groups them.
 *
 * A remisión waits `pending` until the supplier invoice arrives; the invoice
 * then covers one or several pending remisiones of the same provider and every
 * covered remisión becomes `invoiced`, pointing at the invoice that covers it.
 * These tests exercise the public tRPC surface only: the pending list, the
 * grouping command, and the state the two of them leave behind.
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
  auditLogs,
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
    name: `Remision Invoice Supplier ${nanoid(6)}`,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(products).values({
    id: productId,
    tenantId,
    name: `Remision Invoice Product ${nanoid(6)}`,
    sku: `REM-INV-${nanoid(8)}`,
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

async function seedProduct(price: number) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const productId = nanoid();
  await db.insert(products).values({
    id: productId,
    tenantId,
    name: `Remision Invoice Product ${nanoid(6)}`,
    sku: `REM-INV-${nanoid(8)}`,
    price,
    price2: price,
    price3: price,
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
    price,
    isBase: true,
    createdAt: now,
    updatedAt: now,
  });
  return productId;
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

/** Receive stock against a fresh order, which is what records the remisión. */
async function receiveWithRemision(
  providerId: string,
  productId: string,
  quantity: number,
  remisionNumber: string
) {
  const { orderId, orderItemId } = await seedSubmittedOrder(providerId, productId, quantity);
  const receipt = await callerFor().purchases.createFromOrder({
    orderId,
    items: [{ orderItemId, quantity }],
    remisionNumber,
  });
  if (!receipt.remision) throw new Error('Expected the receipt to record a remisión');
  return { purchaseId: receipt.id, remisionId: receipt.remision.id, orderId };
}

function pendingRemisions(providerId: string, extra: Record<string, unknown> = {}) {
  return callerFor().providerPayables.pendingRemisions({ providerId, ...extra });
}

function groupInvoice(input: {
  providerId: string;
  remisionIds: string[];
  amount: number;
  documentNumber?: string;
  lines?: Array<{ productId: string; quantity: number; unitCost: number }>;
}) {
  return callerFor().providerPayables.createInvoice({
    providerId: input.providerId,
    remisionIds: input.remisionIds,
    documentNumber: input.documentNumber ?? `FAC-${nanoid(6)}`,
    issuedAt: ISSUED_AT,
    dueAt: DUE_AT,
    amount: input.amount,
    ...(input.lines ? { lines: input.lines } : {}),
  });
}

describe('pending remisiones and the invoice that groups them', () => {
  beforeAll(async () => {
    testDatabaseDirectory = mkdtempSync(join(tmpdir(), 'puntovivo-remision-invoicing-'));
    server = await createServer({
      dbPath: join(testDatabaseDirectory, 'remision-invoicing.db'),
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
      name: 'purchase-remisions-invoicing.test',
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

  it('lists the pending remisiones of one provider only', async () => {
    const mine = await seedProviderAndProduct();
    const other = await seedProviderAndProduct();
    const first = await receiveWithRemision(mine.providerId, mine.productId, 5, 'REM-PEND-1');
    const second = await receiveWithRemision(mine.providerId, mine.productId, 3, 'REM-PEND-2');
    const foreign = await receiveWithRemision(other.providerId, other.productId, 2, 'REM-PEND-1');

    const page = await pendingRemisions(mine.providerId);

    expect(page.total).toBe(2);
    expect(page.items.map(item => item.number)).toEqual(['REM-PEND-1', 'REM-PEND-2']);
    expect(page.items.map(item => item.id)).toEqual([first.remisionId, second.remisionId]);
    expect(page.items[0]).toMatchObject({
      providerId: mine.providerId,
      siteId,
      siteName: expect.any(String),
      purchaseId: first.purchaseId,
      purchaseOrderId: first.orderId,
      invoicingStatus: 'pending',
      payableInvoiceId: null,
    });
    // The grouping needs the money of each paper: what it arrived with, net of
    // whatever went back, in the same terms the invoice reconciles against.
    expect(page.items[0]).toMatchObject({ netTotal: 50 });
    expect(page.items[1]).toMatchObject({ netTotal: 30 });

    // Another provider's pending paper never leaks into this list.
    const otherPage = await pendingRemisions(other.providerId);
    expect(otherPage.total).toBe(1);
    expect(otherPage.items[0]?.id).toBe(foreign.remisionId);
  });

  it('searches pending remisiones by remisión and purchase number', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const first = await receiveWithRemision(providerId, productId, 2, 'REM-SEARCH-AAA');
    const second = await receiveWithRemision(providerId, productId, 2, 'REM-SEARCH-BBB');

    const byRemision = await pendingRemisions(providerId, { search: 'search-bbb' });
    expect(byRemision.items.map(item => item.id)).toEqual([second.remisionId]);

    const purchaseNumber = (
      await callerFor().purchases.getById({ id: first.purchaseId })
    ).purchaseNumber;
    const byPurchase = await pendingRemisions(providerId, { search: purchaseNumber });
    expect(byPurchase.items.map(item => item.id)).toEqual([first.remisionId]);

    // A literal '%' is a character, never a wildcard.
    const wildcard = await pendingRemisions(providerId, { search: '%' });
    expect(wildcard.items).toEqual([]);

    const bounded = await pendingRemisions(providerId, { perPage: 1 });
    expect(bounded).toMatchObject({ perPage: 1, page: 1, total: 2, pageCount: 2 });
    expect(bounded.items).toHaveLength(1);
  });

  it('groups pending remisiones into one invoice that covers them all', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const first = await receiveWithRemision(providerId, productId, 5, 'REM-GROUP-1');
    const second = await receiveWithRemision(providerId, productId, 5, 'REM-GROUP-2');

    const invoice = await groupInvoice({
      providerId,
      remisionIds: [first.remisionId, second.remisionId],
      amount: 100,
    });

    // Every covered remisión says so, and says which invoice covers it.
    for (const [purchaseId, remisionId] of [
      [first.purchaseId, first.remisionId],
      [second.purchaseId, second.remisionId],
    ] as const) {
      const purchase = await callerFor().purchases.getById({ id: purchaseId });
      expect(purchase.remision).toMatchObject({
        id: remisionId,
        invoicingStatus: 'invoiced',
        payableInvoiceId: invoice.id,
      });
    }

    // The invoice records which remisiones it covers, and the payable is born.
    const audit = getDatabase()
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, invoice.id),
          eq(auditLogs.action, 'provider_payable.invoice.create')
        )
      )
      .get();
    expect(audit?.after).toMatchObject({
      remisionIds: [first.remisionId, second.remisionId],
      amount: 100,
    });

    const overview = await callerFor().providerPayables.overview({ providerId });
    expect(overview.invoices.map(row => row.id)).toEqual([invoice.id]);
    expect(overview.totals.invoices).toBe(100);
    expect(overview.invoices[0]).toMatchObject({ amount: 100, outstanding: 100, status: 'open' });

    // Nothing pending is left for this provider, and no purchase remains
    // offerable for a second invoice.
    expect((await pendingRemisions(providerId)).items).toEqual([]);
    expect((await pendingRemisions(providerId)).total).toBe(0);
    const available = await callerFor().providerPayables.availablePurchases({ providerId });
    expect(available.items).toEqual([]);
  });

  it('refuses to group a remisión that is already invoiced', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const first = await receiveWithRemision(providerId, productId, 4, 'REM-TWICE-1');
    const second = await receiveWithRemision(providerId, productId, 4, 'REM-TWICE-2');
    await groupInvoice({
      providerId,
      remisionIds: [first.remisionId],
      amount: 40,
      documentNumber: `FAC-${nanoid(6)}`,
    });
    const invoicesBefore = (
      await callerFor().providerPayables.overview({ providerId })
    ).invoices.length;

    await expect(
      groupInvoice({
        providerId,
        remisionIds: [first.remisionId, second.remisionId],
        amount: 80,
      })
    ).rejects.toMatchObject({
      cause: { errorCode: 'PROVIDER_PAYABLE_PURCHASE_ALREADY_INVOICED' },
    });

    // The rejected grouping changed nothing: same invoices, same pending paper.
    const overview = await callerFor().providerPayables.overview({ providerId });
    expect(overview.invoices).toHaveLength(invoicesBefore);
    const pending = await pendingRemisions(providerId);
    expect(pending.items.map(item => item.id)).toEqual([second.remisionId]);
    const stillPending = await callerFor().purchases.getById({ id: second.purchaseId });
    expect(stillPending.remision).toMatchObject({
      invoicingStatus: 'pending',
      payableInvoiceId: null,
    });
  });

  it('refuses a foreign remisión, an unknown one and a duplicated one', async () => {
    const mine = await seedProviderAndProduct();
    const other = await seedProviderAndProduct();
    const own = await receiveWithRemision(mine.providerId, mine.productId, 2, 'REM-GUARD-1');
    const foreign = await receiveWithRemision(other.providerId, other.productId, 2, 'REM-GUARD-2');

    await expect(
      groupInvoice({
        providerId: mine.providerId,
        remisionIds: [own.remisionId, foreign.remisionId],
        amount: 40,
      })
    ).rejects.toMatchObject({
      cause: { errorCode: 'PROVIDER_PAYABLE_PURCHASE_MISMATCH' },
    });

    await expect(
      groupInvoice({
        providerId: mine.providerId,
        remisionIds: [own.remisionId, nanoid()],
        amount: 40,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      groupInvoice({
        providerId: mine.providerId,
        remisionIds: [own.remisionId, own.remisionId],
        amount: 40,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // No rejected attempt left an invoice or touched the paper.
    const overview = await callerFor().providerPayables.overview({ providerId: mine.providerId });
    expect(overview.invoices).toEqual([]);
    const pending = await pendingRemisions(mine.providerId);
    expect(pending.items.map(item => item.id)).toEqual([own.remisionId]);
    const untouched = await callerFor().purchases.getById({ id: own.purchaseId });
    expect(untouched.remision).toMatchObject({
      invoicingStatus: 'pending',
      payableInvoiceId: null,
    });
  });

  it('reconciles the grouped invoice against what the store kept', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const receipt = await receiveWithRemision(providerId, productId, 10, 'REM-NET-1');
    const purchase = await callerFor().purchases.getById({ id: receipt.purchaseId });
    const line = purchase.items?.[0];
    if (!line) throw new Error('Expected the receipt line');
    await callerFor().purchases.returnPurchase({
      id: receipt.purchaseId,
      items: [{ purchaseItemId: line.id, quantity: 4 }],
      reason: 'Sacos rotos',
    });

    // 10 arrived but 4 went back: the invoice covers what stayed.
    expect((await pendingRemisions(providerId)).items[0]).toMatchObject({ netTotal: 60 });

    await expect(
      groupInvoice({
        providerId,
        remisionIds: [receipt.remisionId],
        amount: 100,
      })
    ).rejects.toMatchObject({
      cause: { errorCode: 'PROVIDER_PAYABLE_INVOICE_AMOUNT_MISMATCH' },
    });

    const stillPending = await callerFor().purchases.getById({ id: receipt.purchaseId });
    expect(stillPending.remision).toMatchObject({ invoicingStatus: 'pending' });

    const invoice = await groupInvoice({
      providerId,
      remisionIds: [receipt.remisionId],
      amount: 60,
    });
    const paid = await callerFor().purchases.getById({ id: receipt.purchaseId });
    expect(paid.remision).toMatchObject({
      invoicingStatus: 'invoiced',
      payableInvoiceId: invoice.id,
    });
  });

  it('still accepts explicit lines that match the covered remisiones', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const first = await receiveWithRemision(providerId, productId, 3, 'REM-LINES-1');
    const second = await receiveWithRemision(providerId, productId, 3, 'REM-LINES-2');

    await expect(
      groupInvoice({
        providerId,
        remisionIds: [first.remisionId, second.remisionId],
        amount: 60,
        lines: [{ productId, quantity: 6, unitCost: 10 }],
      })
    ).resolves.toMatchObject({ providerId, amount: 60 });

    // An explicit line that contradicts the paper is still refused.
    const another = await seedProviderAndProduct();
    const third = await receiveWithRemision(another.providerId, another.productId, 3, 'REM-LINES-3');
    await expect(
      groupInvoice({
        providerId: another.providerId,
        remisionIds: [third.remisionId],
        amount: 60,
        lines: [{ productId: another.productId, quantity: 3, unitCost: 20 }],
      })
    ).rejects.toMatchObject({
      cause: { errorCode: 'PROVIDER_PAYABLE_INVOICE_LINES_MISMATCH' },
    });
  });

  it('derives one line per product when the grouped remisiones carry different goods', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const otherProductId = await seedProduct(15);
    const first = await receiveWithRemision(providerId, productId, 4, 'REM-MULTI-1');
    const secondRemision = await receiveWithRemision(
      providerId,
      otherProductId,
      2,
      'REM-MULTI-2'
    );

    // 4 x 10 plus 2 x 10 = 60 across two products: one invoice, two lines.
    const invoice = await groupInvoice({
      providerId,
      remisionIds: [first.remisionId, secondRemision.remisionId],
      amount: 60,
    });

    for (const purchaseId of [first.purchaseId, secondRemision.purchaseId]) {
      const purchase = await callerFor().purchases.getById({ id: purchaseId });
      expect(purchase.remision).toMatchObject({
        invoicingStatus: 'invoiced',
        payableInvoiceId: invoice.id,
      });
    }

    // One amount that describes neither product alone is still refused.
    const third = await receiveWithRemision(providerId, otherProductId, 1, 'REM-MULTI-3');
    await expect(
      groupInvoice({ providerId, remisionIds: [third.remisionId], amount: 99 })
    ).rejects.toMatchObject({
      cause: { errorCode: 'PROVIDER_PAYABLE_INVOICE_AMOUNT_MISMATCH' },
    });
  });

  it('closes the remisión when the invoice is created through the purchase picker', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const receipt = await receiveWithRemision(providerId, productId, 5, 'REM-PICKER-1');

    const invoice = await callerFor().providerPayables.createInvoice({
      providerId,
      purchaseId: receipt.purchaseId,
      documentNumber: `FAC-${nanoid(6)}`,
      issuedAt: ISSUED_AT,
      dueAt: DUE_AT,
      amount: 50,
    });

    // The legacy picker covers the same delivery, so its paper cannot stay in
    // the waiting queue and be paid a second time.
    const purchase = await callerFor().purchases.getById({ id: receipt.purchaseId });
    expect(purchase.remision).toMatchObject({
      invoicingStatus: 'invoiced',
      payableInvoiceId: invoice.id,
    });
    expect((await pendingRemisions(providerId)).items).toEqual([]);
  });

  it('refuses to mix remisión ids with purchase ids', async () => {
    const { providerId, productId } = await seedProviderAndProduct();
    const receipt = await receiveWithRemision(providerId, productId, 2, 'REM-MIX-1');

    await expect(
      callerFor().providerPayables.createInvoice({
        providerId,
        remisionIds: [receipt.remisionId],
        purchaseIds: [receipt.purchaseId],
        documentNumber: `FAC-${nanoid(6)}`,
        issuedAt: ISSUED_AT,
        dueAt: DUE_AT,
        amount: 20,
      })
    ).rejects.toThrow(/remisionIds/i);

    expect((await pendingRemisions(providerId)).items.map(item => item.id)).toEqual([
      receipt.remisionId,
    ]);
    // The purchase path is untouched, so the store count never grows.
    expect(
      getDatabase()
        .select({ count: sql<number>`count(*)` })
        .from(purchases)
        .where(eq(purchases.providerId, providerId))
        .get()?.count
    ).toBe(1);
  });
});
