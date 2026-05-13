/**
 * T-046 verification — POST /api/work-orders
 *
 * AC1  POST creates work_orders row with status = "open".
 * AC2  source_cleaning_job_id in body -> reported_by = "cleaner" (server-set).
 * AC3  No source_cleaning_job_id -> reported_by = "manager" (server-set).
 * AC4  req.body.reported_by is ignored.
 * AC5  ai_summary generated from AI; fallback to 100-char truncation on failure.
 * AC6  account_id from JWT only.
 *
 * Run: npx ts-node src/routes/t046.test.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t046';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import workOrdersRouter, { _hooks } from './workOrders';

// ── Minimal test app ──────────────────────────────────────────────────────────

const testApp = express();
testApp.use(express.json());
testApp.use('/api/work-orders', workOrdersRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET        = 'test-secret-t046';
const ACCOUNT_ID        = 'acc-t046-001';
const OTHER_ACCOUNT     = 'acc-t046-OTHER';
const PROPERTY_ID       = 'prop-t046-001';
const CLEANING_JOB_ID   = 'cj-t046-001';
const WORK_ORDER_ID     = 'wo-t046-001';
const AI_SUMMARY        = 'Leaking faucet in the main bathroom.';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeWorkOrder(overrides: Record<string, unknown> = {}) {
  return {
    id:                     WORK_ORDER_ID,
    account_id:             ACCOUNT_ID,
    property_id:            PROPERTY_ID,
    booking_id:             null,
    reported_by:            'manager',
    description:            'The faucet is leaking under the sink.',
    ai_summary:             AI_SUMMARY,
    priority:               'medium',
    status:                 'open',
    source_message_id:      null,
    source_cleaning_job_id: null,
    resolved_at:            null,
    resolved_by:            null,
    manager_notes:          null,
    created_at:             new Date('2026-07-14T12:00:00Z'),
    updated_at:             new Date('2026-07-14T12:00:00Z'),
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
  // AC1 — POST creates work_orders row with status = "open"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1 — POST creates row with status = "open"');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder();
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, description: 'The faucet is leaking.', priority: 'medium' });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC1: status 201',                   res.status === 201);
    assert('AC1: data in response',             !!res.body?.data);
    assert('AC1: create called',                capturedData !== null);
    assert('AC1: status = open',                capturedData?.status === 'open');
    assert('AC1: description passed through',   capturedData?.description === 'The faucet is leaking.');
    assert('AC1: priority passed through',      capturedData?.priority === 'medium');
    assert('AC1: property_id passed through',   capturedData?.property_id === PROPERTY_ID);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — source_cleaning_job_id in body -> reported_by = "cleaner"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2 — source_cleaning_job_id present -> reported_by = "cleaner"');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder({ reported_by: 'cleaner', source_cleaning_job_id: CLEANING_JOB_ID });
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        property_id:            PROPERTY_ID,
        description:            'Damage found during cleaning.',
        priority:               'high',
        source_cleaning_job_id: CLEANING_JOB_ID,
      });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC2: status 201',                          res.status === 201);
    assert('AC2: reported_by = cleaner (server-set)',  capturedData?.reported_by === 'cleaner');
    assert('AC2: source_cleaning_job_id stored',       capturedData?.source_cleaning_job_id === CLEANING_JOB_ID);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — No source_cleaning_job_id -> reported_by = "manager"
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3 — no source_cleaning_job_id -> reported_by = "manager"');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder();
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, description: 'Pool needs cleaning.', priority: 'low' });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC3: status 201',                          res.status === 201);
    assert('AC3: reported_by = manager (server-set)',  capturedData?.reported_by === 'manager');
    assert('AC3: source_cleaning_job_id is null',      capturedData?.source_cleaning_job_id === null);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — req.body.reported_by is IGNORED
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — body.reported_by ignored when source_cleaning_job_id absent (should stay "manager")');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder();
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        property_id:  PROPERTY_ID,
        description:  'Broken light switch.',
        priority:     'low',
        reported_by:  'cleaner',   // client attempts to override — must be ignored
      });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC4a: status 201',                                          res.status === 201);
    assert('AC4a: reported_by = manager (not cleaner from body)',       capturedData?.reported_by === 'manager');
  }

  console.log('\nAC4b — body.reported_by ignored when source_cleaning_job_id present (should stay "cleaner")');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder({ reported_by: 'cleaner' });
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        property_id:            PROPERTY_ID,
        description:            'Cracked tile in bathroom.',
        priority:               'medium',
        source_cleaning_job_id: CLEANING_JOB_ID,
        reported_by:            'manager',   // client attempts to override — must be ignored
      });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC4b: status 201',                                        res.status === 201);
    assert('AC4b: reported_by = cleaner (not manager from body)',     capturedData?.reported_by === 'cleaner');
  }

  // Source check: confirm req.body.reported_by is never read
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'workOrders.ts'), 'utf8',
    );
    assert('AC4 src: reported_by never read from body',
      !/reported_by\s*=\s*(body\.|req\.body)/.test(src) && !src.includes('body.reported_by'));
    assert('AC4 src: reported_by set from source_cleaning_job_id logic',
      /source_cleaning_job_id.*cleaner|cleaner.*source_cleaning_job_id/.test(src));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — ai_summary generated from AI; fallback to 100-char truncation
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — ai_summary set from AI call result');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => 'A single-sentence AI summary.';

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder({ ai_summary: 'A single-sentence AI summary.' });
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, description: 'Dishwasher is broken.', priority: 'medium' });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC5a: status 201',                                  res.status === 201);
    assert('AC5a: ai_summary = AI result',                      capturedData?.ai_summary === 'A single-sentence AI summary.');
  }

  console.log('\nAC5b — ai_summary falls back to 100-char truncation on AI failure');
  {
    const restore = stubAuth();
    // Simulate AI failure — generateAiSummary catches this and falls back
    _hooks.aiCall = async () => { throw new Error('AI timeout'); };

    const longDesc = 'A'.repeat(150);

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder({ ai_summary: args.data.ai_summary, description: longDesc });
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, description: longDesc, priority: 'low' });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC5b: status 201 even on AI failure',         res.status === 201);
    assert('AC5b: ai_summary is 100-char truncation',     capturedData?.ai_summary === longDesc.slice(0, 100));
    assert('AC5b: ai_summary length = 100',               capturedData?.ai_summary?.length === 100);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — account_id from JWT only
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6a — account_id comes from JWT, not from request body');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    let capturedData: any = null;
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async (args: any) => {
      capturedData = args.data;
      return fakeWorkOrder();
    };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({
        property_id:  PROPERTY_ID,
        description:  'Broken chair.',
        priority:     'low',
        account_id:   OTHER_ACCOUNT,   // client attempts to inject different account — must be ignored
      });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC6a: status 201',                                        res.status === 201);
    assert('AC6a: account_id = JWT (not body value)',                 capturedData?.account_id === ACCOUNT_ID);
  }

  console.log('\nAC6b — 401 without auth token');
  {
    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async () => { throw new Error('should not be called'); };

    const res = await request(testApp)
      .post('/api/work-orders')
      .send({ property_id: PROPERTY_ID, description: 'Test.', priority: 'low' });

    (prisma.work_orders as any).create = origCreate;

    assert('AC6b: 401 without token',   res.status === 401);
  }

  console.log('\nAC6c — 400 on missing required fields');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async () => { throw new Error('should not be called'); };

    const resMissingDesc = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, priority: 'low' });

    const resMissingProp = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ description: 'Test.', priority: 'low' });

    const resMissingPriority = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, description: 'Test.' });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC6c: 400 missing description',   resMissingDesc.status     === 400);
    assert('AC6c: 400 missing property_id',   resMissingProp.status     === 400);
    assert('AC6c: 400 missing priority',      resMissingPriority.status === 400);
  }

  console.log('\nAC6d — 400 on invalid priority value');
  {
    const restore = stubAuth();
    _hooks.aiCall = async () => AI_SUMMARY;

    const origCreate = (prisma.work_orders as any).create;
    (prisma.work_orders as any).create = async () => { throw new Error('should not be called'); };

    const res = await request(testApp)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ property_id: PROPERTY_ID, description: 'Test.', priority: 'critical' });

    (prisma.work_orders as any).create = origCreate;
    _hooks.aiCall = undefined;
    restore();

    assert('AC6d: 400 on invalid priority',   res.status === 400);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source checks — verify structure of workOrders.ts and index.ts registration
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — route structure and index.ts registration');
  {
    const src    = require('fs').readFileSync(require('path').join(__dirname, 'workOrders.ts'), 'utf8');
    const idxSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8');

    assert('src: POST / handler registered',         src.includes("router.post(") && (src.includes("'/'") || src.includes('"/"')));
    assert('src: authMiddleware imported',            /authMiddleware/.test(src));
    assert('src: accountIsolationMiddleware used',    /accountIsolationMiddleware/.test(src));
    assert('src: status open hardcoded',             /status.*[\'"]open[\'"]/.test(src));
    assert('src: reported_by never from body',       !/reported_by\s*=\s*(body\.|req\.body)/.test(src) && !src.includes('body.reported_by'));
    assert('src: generateAiSummary imported',        /generateAiSummary/.test(src));
    assert('src: _hooks exported',                   /export.*_hooks/.test(src));
    assert('index: workOrdersRouter imported',       /workOrdersRouter/.test(idxSrc));
    assert('index: /api/work-orders mounted',        /api\/work-orders/.test(idxSrc) && /workOrdersRouter/.test(idxSrc));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
