/**
 * T-045 verification — GET /api/cleaning-jobs
 *                    + PATCH /api/cleaning-jobs/:id
 *                    + PATCH /api/cleaning-jobs/:id/dismiss-damage
 *
 * AC1  GET returns jobs with property, cleaner, and next_booking data.
 * AC2  ?supply_alerts=true -> supply_alert_sent=true AND supply_alert_dismissed=false filter.
 * AC3  ?damage_reports=true -> damage_fyi_sent=true, damage_report_dismissed=false, work_orders:none.
 * AC4  Manual close PATCH: status='completed' + properties.property_status='guest_ready' in single transaction.
 * AC5  dismiss-damage PATCH sets damage_report_dismissed=true.
 * AC6  Account isolation enforced on all three endpoints.
 *
 * Run: npx ts-node src/routes/t045.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t045';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import cleaningJobsRouter from './cleaningJobs';

// ── Minimal test app ──────────────────────────────────────────────────────────

const testApp = express();
testApp.use(express.json());
testApp.use('/api/cleaning-jobs', cleaningJobsRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET    = 'test-secret-t045';
const ACCOUNT_ID    = 'acc-t045-001';
const OTHER_ACCOUNT = 'acc-t045-OTHER';
const JOB_ID        = 'job-t045-001';
const PROPERTY_ID   = 'prop-t045-001';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeJob(overrides: Record<string, unknown> = {}) {
  return {
    id:                      JOB_ID,
    account_id:              ACCOUNT_ID,
    property_id:             PROPERTY_ID,
    booking_id:              'bk-001',
    cleaner_id:              'cleaner-001',
    status:                  'scheduled',
    scheduled_start:         new Date('2026-07-15T11:00:00Z'),
    deadline:                null,
    job_notification_sent:   false,
    job_notification_sent_at: null,
    cleaner_confirmed_at:    null,
    checklist_sent:          false,
    completed_at:            null,
    closed_by:               null,
    supply_flags:            null,
    supply_alert_sent:       false,
    supply_alert_dismissed:  false,
    supply_alert_permanently_failed: false,
    damage_fyi_sent:         false,
    damage_report_dismissed: false,
    no_response_alert_sent:  false,
    inbound_sms_sids:        [],
    created_at:              new Date('2026-07-14T12:00:00Z'),
    updated_at:              new Date('2026-07-14T12:00:00Z'),
    property: { id: PROPERTY_ID, name: 'The Beach House', address: '123 Ocean Dr' },
    cleaner:  { id: 'cleaner-001', name: 'Maria Garcia', phone: '+15557776666' },
    next_booking: null,
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
  // AC1 — GET returns jobs with property, cleaner, and next_booking data
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — GET returns 200 with data array');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    (prisma.cleaning_jobs as any).findMany = async () => [fakeJob()];

    const res = await request(testApp)
      .get('/api/cleaning-jobs')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC1a: status 200',           res.status === 200);
    assert('AC1a: data is an array',     Array.isArray(res.body?.data));
    assert('AC1a: array has 1 item',     res.body?.data?.length === 1);
  }

  console.log('\nAC1b — GET result has property, cleaner, next_booking');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    const jobWithRelations = fakeJob({
      next_booking: { id: 'bk-next', checkin_datetime: new Date('2026-07-16T15:00:00Z'), guest_first_name: 'Alice', guest_last_name: 'Smith' },
    });
    (prisma.cleaning_jobs as any).findMany = async () => [jobWithRelations];

    const res = await request(testApp)
      .get('/api/cleaning-jobs')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    const job = res.body?.data?.[0];
    assert('AC1b: property.name present',      job?.property?.name === 'The Beach House');
    assert('AC1b: property.address present',   job?.property?.address === '123 Ocean Dr');
    assert('AC1b: cleaner.name present',       job?.cleaner?.name === 'Maria Garcia');
    assert('AC1b: cleaner.phone present',      job?.cleaner?.phone === '+15557776666');
    assert('AC1b: next_booking.id present',    job?.next_booking?.id === 'bk-next');
  }

  console.log('\nAC1c — GET query uses account_id from JWT');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/cleaning-jobs')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC1c: where.account_id = JWT account',  capturedWhere?.account_id === ACCOUNT_ID);
  }

  console.log('\nAC1d — GET includes property, cleaner, next_booking in Prisma include');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedInclude: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedInclude = args.include;
      return [];
    };

    await request(testApp)
      .get('/api/cleaning-jobs')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC1d: include.property defined',     capturedInclude?.property !== undefined);
    assert('AC1d: include.cleaner defined',      capturedInclude?.cleaner !== undefined);
    assert('AC1d: include.next_booking defined', capturedInclude?.next_booking !== undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — ?supply_alerts=true filter
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2a — ?supply_alerts=true applies supply_alert_sent and supply_alert_dismissed filter');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/cleaning-jobs?supply_alerts=true')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC2a: supply_alert_sent = true',      capturedWhere?.supply_alert_sent === true);
    assert('AC2a: supply_alert_dismissed = false', capturedWhere?.supply_alert_dismissed === false);
    assert('AC2a: account_id still present',       capturedWhere?.account_id === ACCOUNT_ID);
  }

  console.log('\nAC2b — no ?supply_alerts param → no supply filter applied');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/cleaning-jobs')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC2b: no supply_alert_sent filter',       capturedWhere?.supply_alert_sent === undefined);
    assert('AC2b: no supply_alert_dismissed filter',  capturedWhere?.supply_alert_dismissed === undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — ?damage_reports=true filter excludes jobs with work orders
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3a — ?damage_reports=true applies damage filter with work_orders:none');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/cleaning-jobs?damage_reports=true')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC3a: damage_fyi_sent = true',          capturedWhere?.damage_fyi_sent === true);
    assert('AC3a: damage_report_dismissed = false',  capturedWhere?.damage_report_dismissed === false);
    assert('AC3a: work_orders: { none: {} }',
      JSON.stringify(capturedWhere?.work_orders) === JSON.stringify({ none: {} }));
    assert('AC3a: account_id still present',         capturedWhere?.account_id === ACCOUNT_ID);
  }

  console.log('\nAC3b — no ?damage_reports param → no damage filter applied');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/cleaning-jobs')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC3b: no damage_fyi_sent filter',          capturedWhere?.damage_fyi_sent === undefined);
    assert('AC3b: no damage_report_dismissed filter',   capturedWhere?.damage_report_dismissed === undefined);
    assert('AC3b: no work_orders filter',               capturedWhere?.work_orders === undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — Manual close: status + property_status in single transaction
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — manual close calls $transaction (not separate updates)');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: ACCOUNT_ID, property_id: PROPERTY_ID,
    });

    let txCalled = 0;
    const origTx = (prisma as any).$transaction;
    (prisma as any).$transaction = async (ops: Promise<any>[]) => {
      txCalled++;
      return Promise.all(ops);
    };

    let capturedJobUpdate: any  = null;
    let capturedPropUpdate: any = null;

    const origJobUpdate = (prisma.cleaning_jobs as any).update;
    (prisma.cleaning_jobs as any).update = async (args: any) => {
      capturedJobUpdate = args;
      return fakeJob({ status: 'completed', closed_by: 'manager_manual' });
    };

    const origPropUpdate = (prisma.properties as any).update;
    (prisma.properties as any).update = async (args: any) => {
      capturedPropUpdate = args;
      return { id: PROPERTY_ID, property_status: 'guest_ready' };
    };

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ closed_by: 'manager_manual' });

    (prisma.cleaning_jobs as any).update  = origJobUpdate;
    (prisma.properties as any).update     = origPropUpdate;
    (prisma as any).$transaction          = origTx;
    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC4a: status 200',                               res.status === 200);
    assert('AC4a: $transaction was called',                  txCalled === 1);
    assert('AC4a: job update status = completed',            capturedJobUpdate?.data?.status === 'completed');
    assert('AC4a: job update closed_by = manager_manual',   capturedJobUpdate?.data?.closed_by === 'manager_manual');
    assert('AC4a: job update completed_at is a date',
      capturedJobUpdate?.data?.completed_at instanceof Date);
    assert('AC4a: property update property_status = guest_ready',
      capturedPropUpdate?.data?.property_status === 'guest_ready');
    assert('AC4a: property update where.id = job.property_id',
      capturedPropUpdate?.where?.id === PROPERTY_ID);
  }

  console.log('\nAC4b — manual close response contains updated job data');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: ACCOUNT_ID, property_id: PROPERTY_ID,
    });

    const origTx = (prisma as any).$transaction;
    (prisma as any).$transaction = async (ops: Promise<any>[]) => Promise.all(ops);

    const origJobUpdate = (prisma.cleaning_jobs as any).update;
    (prisma.cleaning_jobs as any).update = async () =>
      fakeJob({ status: 'completed', closed_by: 'manager_manual' });

    const origPropUpdate = (prisma.properties as any).update;
    (prisma.properties as any).update = async () => ({ id: PROPERTY_ID, property_status: 'guest_ready' });

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ closed_by: 'manager_manual' });

    (prisma.cleaning_jobs as any).update  = origJobUpdate;
    (prisma.properties as any).update     = origPropUpdate;
    (prisma as any).$transaction          = origTx;
    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC4b: response has data', res.body?.data !== undefined);
    assert('AC4b: data.status = completed',           res.body?.data?.status === 'completed');
    assert('AC4b: data.closed_by = manager_manual',  res.body?.data?.closed_by === 'manager_manual');
  }

  console.log('\nAC4c — supply_alert_dismissed=true does NOT go through $transaction');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: ACCOUNT_ID, property_id: PROPERTY_ID,
    });

    let txCalled = false;
    const origTx = (prisma as any).$transaction;
    (prisma as any).$transaction = async (ops: any) => {
      txCalled = true;
      return Array.isArray(ops) ? Promise.all(ops) : ops(prisma);
    };

    const origJobUpdate = (prisma.cleaning_jobs as any).update;
    (prisma.cleaning_jobs as any).update = async () =>
      fakeJob({ supply_alert_dismissed: true });

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ supply_alert_dismissed: true });

    (prisma.cleaning_jobs as any).update     = origJobUpdate;
    (prisma as any).$transaction             = origTx;
    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC4c: 200 on supply_alert_dismissed update',  res.status === 200);
    assert('AC4c: $transaction NOT called for supply dismiss', txCalled === false);
  }

  console.log('\nAC4d — supply_alert_dismissed update writes only that field');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: ACCOUNT_ID, property_id: PROPERTY_ID,
    });

    let capturedUpdate: any = null;
    const origJobUpdate = (prisma.cleaning_jobs as any).update;
    (prisma.cleaning_jobs as any).update = async (args: any) => {
      capturedUpdate = args;
      return fakeJob({ supply_alert_dismissed: true });
    };

    await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ supply_alert_dismissed: true });

    (prisma.cleaning_jobs as any).update     = origJobUpdate;
    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC4d: update data.supply_alert_dismissed = true',
      capturedUpdate?.data?.supply_alert_dismissed === true);
    assert('AC4d: update data has no status field',
      capturedUpdate?.data?.status === undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — dismiss-damage PATCH sets damage_report_dismissed = true
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — PATCH /:id/dismiss-damage sets damage_report_dismissed = true');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: ACCOUNT_ID,
    });

    let capturedUpdate: any = null;
    const origUpdate = (prisma.cleaning_jobs as any).update;
    (prisma.cleaning_jobs as any).update = async (args: any) => {
      capturedUpdate = args;
      return fakeJob({ damage_report_dismissed: true });
    };

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}/dismiss-damage`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).update     = origUpdate;
    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC5a: status 200',                                    res.status === 200);
    assert('AC5a: update called',                                  capturedUpdate !== null);
    assert('AC5a: update where.id = JOB_ID',                      capturedUpdate?.where?.id === JOB_ID);
    assert('AC5a: update data.damage_report_dismissed = true',
      capturedUpdate?.data?.damage_report_dismissed === true);
    assert('AC5a: response data.damage_report_dismissed = true',
      res.body?.data?.damage_report_dismissed === true);
  }

  console.log('\nAC5b — dismiss-damage does NOT set other fields');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: ACCOUNT_ID,
    });

    let capturedUpdate: any = null;
    const origUpdate = (prisma.cleaning_jobs as any).update;
    (prisma.cleaning_jobs as any).update = async (args: any) => {
      capturedUpdate = args;
      return fakeJob({ damage_report_dismissed: true });
    };

    await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}/dismiss-damage`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaning_jobs as any).update     = origUpdate;
    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC5b: update data has only damage_report_dismissed',
      Object.keys(capturedUpdate?.data ?? {}).length === 1);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — Account isolation
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6a — GET without token → 401');
  {
    const res = await request(testApp).get('/api/cleaning-jobs');
    assert('AC6a: 401 on GET without token', res.status === 401);
  }

  console.log('\nAC6b — PATCH /:id without token → 401');
  {
    const res = await request(testApp).patch(`/api/cleaning-jobs/${JOB_ID}`).send({ closed_by: 'manager_manual' });
    assert('AC6b: 401 on PATCH without token', res.status === 401);
  }

  console.log('\nAC6c — PATCH /:id/dismiss-damage without token → 401');
  {
    const res = await request(testApp).patch(`/api/cleaning-jobs/${JOB_ID}/dismiss-damage`);
    assert('AC6c: 401 on dismiss-damage without token', res.status === 401);
  }

  console.log('\nAC6d — PATCH /:id for job belonging to different account → 404');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: OTHER_ACCOUNT, property_id: PROPERTY_ID,
    });

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ closed_by: 'manager_manual' });

    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC6d: 404 for cross-account PATCH', res.status === 404);
  }

  console.log('\nAC6e — PATCH /:id for nonexistent job → 404');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => null;

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/nonexistent`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ closed_by: 'manager_manual' });

    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC6e: 404 for nonexistent job', res.status === 404);
  }

  console.log('\nAC6f — dismiss-damage for job belonging to different account → 404');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaning_jobs as any).findUnique;
    (prisma.cleaning_jobs as any).findUnique = async () => ({
      id: JOB_ID, account_id: OTHER_ACCOUNT,
    });

    const res = await request(testApp)
      .patch(`/api/cleaning-jobs/${JOB_ID}/dismiss-damage`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.cleaning_jobs as any).findUnique = origFU;
    restore();

    assert('AC6f: 404 for cross-account dismiss-damage', res.status === 404);
  }

  console.log('\nAC6g — GET only queries account from JWT (not request param)');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaning_jobs as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaning_jobs as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    // Send account_id in query string — should be ignored
    await request(testApp)
      .get('/api/cleaning-jobs?account_id=evil-account')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.cleaning_jobs as any).findMany = orig;
    restore();

    assert('AC6g: where.account_id = JWT (not query param)',
      capturedWhere?.account_id === ACCOUNT_ID);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source-level checks
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — verify route structure and index.ts registration');
  {
    const src    = fs.readFileSync(path.join(__dirname, 'cleaningJobs.ts'), 'utf8');
    const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

    assert('src: GET / handler',                    /router\.get\s*\(\s*['"]\/['"]/.test(src));
    assert('src: PATCH /:id handler',               /router\.patch\s*\(\s*['"]\/:\s*id['"]/.test(src));
    assert('src: PATCH /:id/dismiss-damage handler', /router\.patch\s*\(\s*['"]\/:id\/dismiss-damage['"]/.test(src));
    assert('src: $transaction used for manual close', /\$transaction/.test(src));
    assert('src: property_status = guest_ready',    /property_status.*guest_ready|guest_ready.*property_status/.test(src));
    assert('src: damage_report_dismissed = true',   /damage_report_dismissed.*true/.test(src));
    assert('src: supply_alert_dismissed in PATCH',  /supply_alert_dismissed/.test(src));
    assert('src: work_orders.*none filter',          /work_orders.*none/.test(src));
    assert('src: authMiddleware imported',           /authMiddleware/.test(src));
    assert('src: accountIsolationMiddleware used',   /accountIsolationMiddleware/.test(src));

    assert('index: cleaningJobsRouter imported',    /cleaningJobsRouter/.test(idxSrc));
    assert('index: /api/cleaning-jobs mounted',
      /api\/cleaning-jobs/.test(idxSrc) && /cleaningJobsRouter/.test(idxSrc));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
