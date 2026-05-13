/**
 * T-047 verification — GET /api/work-orders + PATCH /api/work-orders/:id
 *
 * AC1  Active list sorted priority-first (urgent->high->medium->low) then created_at ASC.
 * AC2  Resolved archive sorted resolved_at DESC, paginated 50/page.
 * AC3  PATCH status="resolved" -> resolved_at and resolved_by="manager" set server-side.
 * AC4  Stale updated_at_check -> 409.
 * AC5  manager_notes saved as free text.
 * AC6  Account isolation enforced on GET and PATCH.
 *
 * Run: npx ts-node src/routes/t047.test.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t047';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import workOrdersRouter from './workOrders';

// ── Minimal test app ──────────────────────────────────────────────────────────

const testApp = express();
testApp.use(express.json());
testApp.use('/api/work-orders', workOrdersRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET    = 'test-secret-t047';
const ACCOUNT_ID    = 'acc-t047-001';
const OTHER_ACCOUNT = 'acc-t047-OTHER';
const PROPERTY_ID   = 'prop-t047-001';
const WO_ID         = 'wo-t047-001';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeWO(overrides: Record<string, unknown> = {}) {
  return {
    id:                     WO_ID,
    account_id:             ACCOUNT_ID,
    property_id:            PROPERTY_ID,
    booking_id:             null,
    reported_by:            'manager',
    description:            'Test issue',
    ai_summary:             'Test summary',
    priority:               'medium',
    status:                 'open',
    source_message_id:      null,
    source_cleaning_job_id: null,
    resolved_at:            null,
    resolved_by:            null,
    manager_notes:          null,
    created_at:             new Date('2026-07-14T12:00:00Z'),
    updated_at:             new Date('2026-07-14T12:00:00Z'),
    property:               { name: 'Beach House' },
    ...overrides,
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function stubAuth(tokenVersion = 1): () => void {
  const orig = (prisma.accounts as any).findUnique;
  (prisma.accounts as any).findUnique = async () => ({ token_version: tokenVersion });
  return () => { (prisma.accounts as any).findUnique = orig; };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
(async () => {

  // ════════════════════════════════════════════════════════════════════════════
  // AC1 — Active list sorted priority-first (urgent->high->medium->low) then created_at
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — GET active list returns open + in_progress, priority sorted');
  {
    const restore = stubAuth();
    // Four work orders in deliberately wrong priority order
    const woUrgent = fakeWO({ id: 'wo-urgent', priority: 'urgent',  status: 'open',        created_at: new Date('2026-07-14T10:00:00Z') });
    const woHigh   = fakeWO({ id: 'wo-high',   priority: 'high',    status: 'in_progress', created_at: new Date('2026-07-14T09:00:00Z') });
    const woMedium = fakeWO({ id: 'wo-medium', priority: 'medium',  status: 'open',        created_at: new Date('2026-07-14T08:00:00Z') });
    const woLow    = fakeWO({ id: 'wo-low',    priority: 'low',     status: 'open',        created_at: new Date('2026-07-14T07:00:00Z') });

    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    // Return in reverse order to prove sorting happens in route, not just returning DB order
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) return [woLow, woMedium, woHigh, woUrgent]; // reversed
      return []; // resolved
    };
    (prisma.work_orders as any).count = async () => 0;

    const res = await request(testApp)
      .get('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    const active = res.body?.data?.active;
    assert('AC1a: status 200',                              res.status === 200);
    assert('AC1a: data.active is array',                    Array.isArray(active));
    assert('AC1a: 4 active items',                          active?.length === 4);
    assert('AC1a: [0] = urgent',                            active?.[0]?.priority === 'urgent');
    assert('AC1a: [1] = high',                              active?.[1]?.priority === 'high');
    assert('AC1a: [2] = medium',                            active?.[2]?.priority === 'medium');
    assert('AC1a: [3] = low',                               active?.[3]?.priority === 'low');
  }

  console.log('\nAC1b — Within same priority, sorted by created_at ASC');
  {
    const restore = stubAuth();
    const woA = fakeWO({ id: 'wo-A', priority: 'high', status: 'open', created_at: new Date('2026-07-14T12:00:00Z') });
    const woB = fakeWO({ id: 'wo-B', priority: 'high', status: 'open', created_at: new Date('2026-07-14T08:00:00Z') });
    const woC = fakeWO({ id: 'wo-C', priority: 'high', status: 'open', created_at: new Date('2026-07-14T10:00:00Z') });

    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) return [woA, woB, woC]; // out of time order
      return [];
    };
    (prisma.work_orders as any).count = async () => 0;

    const res = await request(testApp)
      .get('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    const active = res.body?.data?.active;
    assert('AC1b: [0] = earliest created_at (wo-B)',   active?.[0]?.id === 'wo-B');
    assert('AC1b: [1] = middle created_at (wo-C)',     active?.[1]?.id === 'wo-C');
    assert('AC1b: [2] = latest created_at (wo-A)',     active?.[2]?.id === 'wo-A');
  }

  console.log('\nAC1c — GET includes property.name');
  {
    const restore = stubAuth();
    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) return [fakeWO({ property: { name: 'Sunset Villa' } })];
      return [];
    };
    (prisma.work_orders as any).count = async () => 0;

    const res = await request(testApp)
      .get('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    assert('AC1c: property.name in active item',   res.body?.data?.active?.[0]?.property?.name === 'Sunset Villa');
  }

  console.log('\nAC1d — GET uses account_id from JWT for where clause');
  {
    const restore = stubAuth();
    let capturedActiveWhere: any = null;
    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) { capturedActiveWhere = args.where; return []; }
      return [];
    };
    (prisma.work_orders as any).count = async () => 0;

    await request(testApp)
      .get('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    assert('AC1d: where.account_id = JWT account',   capturedActiveWhere?.account_id === ACCOUNT_ID);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — Resolved archive sorted resolved_at DESC, paginated 50/page
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2a — GET resolved sorted resolved_at DESC');
  {
    const restore = stubAuth();
    const woOlder  = fakeWO({ id: 'wo-old', status: 'resolved', resolved_at: new Date('2026-06-01T00:00:00Z') });
    const woNewer  = fakeWO({ id: 'wo-new', status: 'resolved', resolved_at: new Date('2026-07-01T00:00:00Z') });

    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) return [];
      // Return already in DESC order as the DB would
      return [woNewer, woOlder];
    };
    (prisma.work_orders as any).count = async () => 2;

    const res = await request(testApp)
      .get('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    const resolved = res.body?.data?.resolved;
    assert('AC2a: resolved is array',              Array.isArray(resolved));
    assert('AC2a: resolved_total = 2',             res.body?.data?.resolved_total === 2);
    assert('AC2a: page = 1 by default',            res.body?.data?.page === 1);
    assert('AC2a: [0] = newer resolved_at',        resolved?.[0]?.id === 'wo-new');
    assert('AC2a: [1] = older resolved_at',        resolved?.[1]?.id === 'wo-old');
  }

  console.log('\nAC2b — Resolved query uses orderBy:resolved_at desc, skip/take for pagination');
  {
    const restore = stubAuth();
    let capturedResolvedArgs: any = null;
    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) return [];
      capturedResolvedArgs = args;
      return [];
    };
    (prisma.work_orders as any).count = async () => 150;

    await request(testApp)
      .get('/api/work-orders?page=3')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    assert('AC2b: orderBy resolved_at desc',   capturedResolvedArgs?.orderBy?.resolved_at === 'desc');
    assert('AC2b: skip = (3-1)*50 = 100',      capturedResolvedArgs?.skip === 100);
    assert('AC2b: take = 50',                  capturedResolvedArgs?.take === 50);
  }

  console.log('\nAC2c — property_id filter applied to both active and resolved queries');
  {
    const restore = stubAuth();
    const capturedWheres: any[] = [];
    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      capturedWheres.push(args.where);
      return [];
    };
    (prisma.work_orders as any).count = async (args: any) => {
      capturedWheres.push(args.where);
      return 0;
    };

    await request(testApp)
      .get(`/api/work-orders?property_id=${PROPERTY_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    assert('AC2c: all queries include property_id filter',
      capturedWheres.every(w => w?.property_id === PROPERTY_ID));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — PATCH status="resolved" -> resolved_at and resolved_by="manager" set
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3a — PATCH to resolved sets resolved_at and resolved_by=manager server-side');
  {
    const restore = stubAuth();
    const existingUpdatedAt = new Date('2026-07-14T12:00:00Z');

    const origFindUnique = (prisma.work_orders as any).findUnique;
    const origUpdate     = (prisma.work_orders as any).update;
    let capturedData: any = null;

    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: ACCOUNT_ID, updated_at: existingUpdatedAt,
    });
    (prisma.work_orders as any).update = async (args: any) => {
      capturedData = args.data;
      return fakeWO({ status: 'resolved', resolved_by: 'manager', resolved_at: new Date() });
    };

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'resolved', updated_at_check: existingUpdatedAt.toISOString() });

    (prisma.work_orders as any).findUnique = origFindUnique;
    (prisma.work_orders as any).update     = origUpdate;
    restore();

    assert('AC3a: status 200',                      res.status === 200);
    assert('AC3a: update data.status = resolved',   capturedData?.status === 'resolved');
    assert('AC3a: resolved_at is a Date',           capturedData?.resolved_at instanceof Date);
    assert('AC3a: resolved_by = manager',           capturedData?.resolved_by === 'manager');
  }

  console.log('\nAC3b — PATCH to non-resolved status does NOT set resolved_at or resolved_by');
  {
    const restore = stubAuth();
    const existingUpdatedAt = new Date('2026-07-14T12:00:00Z');

    const origFindUnique = (prisma.work_orders as any).findUnique;
    const origUpdate     = (prisma.work_orders as any).update;
    let capturedData: any = null;

    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: ACCOUNT_ID, updated_at: existingUpdatedAt,
    });
    (prisma.work_orders as any).update = async (args: any) => {
      capturedData = args.data;
      return fakeWO({ status: 'in_progress' });
    };

    await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'in_progress', updated_at_check: existingUpdatedAt.toISOString() });

    (prisma.work_orders as any).findUnique = origFindUnique;
    (prisma.work_orders as any).update     = origUpdate;
    restore();

    assert('AC3b: resolved_at not set for non-resolved',   capturedData?.resolved_at === undefined);
    assert('AC3b: resolved_by not set for non-resolved',   capturedData?.resolved_by === undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — Stale updated_at_check -> 409
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — Stale updated_at_check returns 409');
  {
    const restore = stubAuth();
    const dbUpdatedAt     = new Date('2026-07-14T12:00:00Z');
    const staleUpdatedAt  = new Date('2026-07-14T11:00:00Z'); // one hour earlier

    const origFindUnique = (prisma.work_orders as any).findUnique;
    const origUpdate     = (prisma.work_orders as any).update;
    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: ACCOUNT_ID, updated_at: dbUpdatedAt,
    });
    (prisma.work_orders as any).update = async () => { throw new Error('should not be called'); };

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'in_progress', updated_at_check: staleUpdatedAt.toISOString() });

    (prisma.work_orders as any).findUnique = origFindUnique;
    (prisma.work_orders as any).update     = origUpdate;
    restore();

    assert('AC4a: 409 on stale updated_at_check',   res.status === 409);
  }

  console.log('\nAC4b — Matching updated_at_check succeeds (200)');
  {
    const restore = stubAuth();
    const dbUpdatedAt = new Date('2026-07-14T12:00:00Z');

    const origFindUnique = (prisma.work_orders as any).findUnique;
    const origUpdate     = (prisma.work_orders as any).update;
    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: ACCOUNT_ID, updated_at: dbUpdatedAt,
    });
    (prisma.work_orders as any).update = async () => fakeWO({ status: 'in_progress' });

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'in_progress', updated_at_check: dbUpdatedAt.toISOString() });

    (prisma.work_orders as any).findUnique = origFindUnique;
    (prisma.work_orders as any).update     = origUpdate;
    restore();

    assert('AC4b: 200 when updated_at_check matches',   res.status === 200);
  }

  console.log('\nAC4c — PATCH succeeds when updated_at_check is omitted (no check)');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.work_orders as any).findUnique;
    const origUpdate     = (prisma.work_orders as any).update;
    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: ACCOUNT_ID, updated_at: new Date(),
    });
    (prisma.work_orders as any).update = async () => fakeWO({ priority: 'high' });

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ priority: 'high' }); // no updated_at_check

    (prisma.work_orders as any).findUnique = origFindUnique;
    (prisma.work_orders as any).update     = origUpdate;
    restore();

    assert('AC4c: 200 when updated_at_check omitted',   res.status === 200);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — manager_notes saved as free text
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5 — manager_notes passed through to update');
  {
    const restore = stubAuth();
    const notes = 'Called plumber — arriving Thursday. Follow up if not resolved by EOD.';
    let capturedData: any = null;

    const origFindUnique = (prisma.work_orders as any).findUnique;
    const origUpdate     = (prisma.work_orders as any).update;
    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: ACCOUNT_ID, updated_at: new Date('2026-07-14T12:00:00Z'),
    });
    (prisma.work_orders as any).update = async (args: any) => {
      capturedData = args.data;
      return fakeWO({ manager_notes: notes });
    };

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ manager_notes: notes });

    (prisma.work_orders as any).findUnique = origFindUnique;
    (prisma.work_orders as any).update     = origUpdate;
    restore();

    assert('AC5: status 200',                               res.status === 200);
    assert('AC5: update data.manager_notes = notes text',   capturedData?.manager_notes === notes);
    assert('AC5: no other fields changed',
      capturedData?.status === undefined && capturedData?.priority === undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — Account isolation enforced
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6a — GET 401 without auth token');
  {
    const res = await request(testApp).get('/api/work-orders');
    assert('AC6a: 401 on GET without token',   res.status === 401);
  }

  console.log('\nAC6b — PATCH 401 without auth token');
  {
    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .send({ status: 'in_progress' });
    assert('AC6b: 401 on PATCH without token',   res.status === 401);
  }

  console.log('\nAC6c — PATCH 404 for work order belonging to different account');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.work_orders as any).findUnique;
    (prisma.work_orders as any).findUnique = async () => ({
      id: WO_ID, account_id: OTHER_ACCOUNT, updated_at: new Date(),
    });

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ status: 'in_progress' });

    (prisma.work_orders as any).findUnique = origFindUnique;
    restore();

    assert('AC6c: 404 for cross-account PATCH',   res.status === 404);
  }

  console.log('\nAC6d — PATCH 404 for nonexistent work order');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.work_orders as any).findUnique;
    (prisma.work_orders as any).findUnique = async () => null;

    const res = await request(testApp)
      .patch(`/api/work-orders/${WO_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'in_progress' });

    (prisma.work_orders as any).findUnique = origFindUnique;
    restore();

    assert('AC6d: 404 for nonexistent work order',   res.status === 404);
  }

  console.log('\nAC6e — GET account_id comes from JWT, not query param');
  {
    const restore = stubAuth();
    let capturedWhere: any = null;
    const origFindMany = (prisma.work_orders as any).findMany;
    const origCount    = (prisma.work_orders as any).count;
    (prisma.work_orders as any).findMany = async (args: any) => {
      if (args.where?.status?.in) { capturedWhere = args.where; return []; }
      return [];
    };
    (prisma.work_orders as any).count = async () => 0;

    await request(testApp)
      .get(`/api/work-orders?account_id=${OTHER_ACCOUNT}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.work_orders as any).findMany = origFindMany;
    (prisma.work_orders as any).count    = origCount;
    restore();

    assert('AC6e: GET account_id = JWT (not injected query param)',
      capturedWhere?.account_id === ACCOUNT_ID && capturedWhere?.account_id !== OTHER_ACCOUNT);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source checks — verify route structure in workOrders.ts
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — route structure');
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'workOrders.ts'), 'utf8',
    );

    assert('src: GET / handler',              src.includes("router.get(") && (src.includes("'/'") || src.includes('"/"')));
    assert('src: PATCH /:id handler',         src.includes("router.patch(") && (src.includes("'/:id'") || src.includes('"/:id"')));
    assert('src: PRIORITY_ORDER defined',     src.includes('PRIORITY_ORDER'));
    assert('src: .sort() called',             src.includes('.sort('));
    assert('src: resolved_at set on resolve', /resolved_at.*new Date|new Date.*resolved_at/.test(src));
    assert('src: resolved_by = manager',      /resolved_by.*[\'"]manager[\'"]/.test(src));
    assert('src: 409 status',                 src.includes('409'));
    assert('src: updated_at_check compared',  src.includes('updated_at_check'));
    assert('src: skip/take for pagination',   src.includes('skip') && src.includes('take'));
    assert('src: RESOLVED_PAGE_SIZE = 50',    src.includes('50'));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
