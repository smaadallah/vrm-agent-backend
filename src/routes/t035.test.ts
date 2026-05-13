/**
 * T-035 verification — PATCH /api/properties/:id
 *
 * AC1  PATCH updates properties fields for the authenticated account only.
 * AC2  checklist_body in body -> turnover_checklists row updated in same call.
 * AC3  auto_schedule_cleaner_enabled = true with no primary cleaner -> 400.
 * AC4  Cross-account property ID -> 404.
 * AC5  primary_cleaner_id update -> clears old primary, sets new one in a transaction.
 *
 * Run: npx ts-node src/routes/t035.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t035';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import propertiesRouter from './properties';

// ── Minimal test app ──────────────────────────────────────────────────────────
const testApp = express();
testApp.use(express.json());
testApp.use('/api/properties', propertiesRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────
const JWT_SECRET    = 'test-secret-t035';
const ACCOUNT_ID    = 'acc-t035-001';
const OTHER_ACCOUNT = 'acc-t035-OTHER';
const PROP_ID       = 'prop-t035-001';
const CLEANER_A     = 'cleaner-a-001';
const CLEANER_B     = 'cleaner-b-002';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeProperty(overrides: Record<string, unknown> = {}) {
  return {
    id:                                  PROP_ID,
    account_id:                          ACCOUNT_ID,
    name:                                'Ocean View',
    address:                             '1 Shore Rd',
    checkin_time:                        '15:00',
    checkout_time:                       '11:00',
    door_access_instructions:            null,
    parking_instructions:                null,
    wifi_name:                           null,
    wifi_password:                       null,
    house_rules:                         null,
    amenities:                           null,
    local_recommendations:               null,
    special_instructions:                null,
    checkout_steps:                      null,
    checkin_message_template:            null,
    checkout_reminder_template:          null,
    review_request_template:             null,
    checkin_message_enabled:             true,
    checkout_reminder_enabled:           true,
    review_request_enabled:              true,
    checkin_message_hours_before:        24,
    checkout_reminder_send_time:         '20:00',
    review_request_hours_after:          2,
    airbnb_listing_id:                   null,
    vrbo_listing_id:                     null,
    property_status:                     'unknown',
    auto_schedule_cleaner_enabled:       false,
    cleaner_confirmation_window_minutes: 60,
    pre_checkin_alert_minutes:           30,
    created_at:                          new Date('2026-01-01T00:00:00Z'),
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

// Stub accounts.findUnique so authMiddleware passes
function stubAuth(tokenVersion = 1): () => void {
  const orig = (prisma.accounts as any).findUnique;
  (prisma.accounts as any).findUnique = async () => ({ token_version: tokenVersion });
  return () => { (prisma.accounts as any).findUnique = orig; };
}

// ── Transaction mock factory ──────────────────────────────────────────────────
// Returns a mock $transaction that captures all calls inside it.
interface TxCapture {
  called: boolean;
  propertiesUpdate: { called: boolean; args: any };
  checklistFindFirst: { called: boolean; args: any };
  checklistUpdate: { called: boolean; args: any };
  checklistCreate: { called: boolean; args: any };
  cleanersUpdateMany: { called: boolean; args: any };
  cleanerRowFindFirst: { called: boolean; args: any };
  cleanerRowUpdate: { called: boolean; args: any };
  cleanerRowCreate: { called: boolean; args: any };
}

function makeTransactionMock(opts: {
  existingChecklist?: { id: string; checklist_body: string } | null;
  existingCleanerRow?: { id: string; cleaner_id: string } | null;
} = {}): { capture: TxCapture; restore: () => void } {
  const orig = (prisma as any).$transaction;
  const capture: TxCapture = {
    called: false,
    propertiesUpdate:  { called: false, args: null },
    checklistFindFirst:{ called: false, args: null },
    checklistUpdate:   { called: false, args: null },
    checklistCreate:   { called: false, args: null },
    cleanersUpdateMany:{ called: false, args: null },
    cleanerRowFindFirst: { called: false, args: null },
    cleanerRowUpdate:  { called: false, args: null },
    cleanerRowCreate:  { called: false, args: null },
  };

  const mockTx = {
    properties: {
      update: async (args: any) => {
        capture.propertiesUpdate.called = true;
        capture.propertiesUpdate.args   = args;
        return fakeProperty();
      },
    },
    turnover_checklists: {
      findFirst: async (args: any) => {
        capture.checklistFindFirst.called = true;
        capture.checklistFindFirst.args   = args;
        return opts.existingChecklist ?? null;
      },
      update: async (args: any) => {
        capture.checklistUpdate.called = true;
        capture.checklistUpdate.args   = args;
        return {};
      },
      create: async (args: any) => {
        capture.checklistCreate.called = true;
        capture.checklistCreate.args   = args;
        return {};
      },
    },
    property_cleaners: {
      updateMany: async (args: any) => {
        capture.cleanersUpdateMany.called = true;
        capture.cleanersUpdateMany.args   = args;
        return { count: 1 };
      },
      findFirst: async (args: any) => {
        capture.cleanerRowFindFirst.called = true;
        capture.cleanerRowFindFirst.args   = args;
        return opts.existingCleanerRow ?? null;
      },
      update: async (args: any) => {
        capture.cleanerRowUpdate.called = true;
        capture.cleanerRowUpdate.args   = args;
        return {};
      },
      create: async (args: any) => {
        capture.cleanerRowCreate.called = true;
        capture.cleanerRowCreate.args   = args;
        return {};
      },
    },
  };

  (prisma as any).$transaction = async (fn: any) => {
    capture.called = true;
    return fn(mockTx);
  };

  return {
    capture,
    restore: () => { (prisma as any).$transaction = orig; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
(async () => {

  // ════════════════════════════════════════════════════════════════════════════
  // AC1 — PATCH updates properties fields for the authenticated account only
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — PATCH /api/properties/:id without token → 401');
  {
    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .send({ name: 'New Name' });
    assert('AC1a: 401 with no token', res.status === 401);
  }

  console.log('\nAC1b — PATCH updates property fields and returns updated row');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    let   fuCount = 0;
    (prisma.properties as any).findUnique = async () =>
      fuCount++ === 0 ? fakeProperty() : fakeProperty({ name: 'Sunset Retreat' });

    const { capture, restore } = makeTransactionMock();

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Sunset Retreat', wifi_password: 'secret123' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC1b: response 200', res.status === 200);
    assert('AC1b: $transaction called', capture.called);
    assert('AC1b: tx.properties.update called', capture.propertiesUpdate.called);
    assert('AC1b: update.where.id = PROP_ID',
      capture.propertiesUpdate.args?.where?.id === PROP_ID);
    assert('AC1b: update.data includes name',
      capture.propertiesUpdate.args?.data?.name === 'Sunset Retreat');
    assert('AC1b: update.data includes wifi_password',
      capture.propertiesUpdate.args?.data?.wifi_password === 'secret123');
    assert('AC1b: data.name in response', res.body?.data?.name === 'Sunset Retreat');
  }

  console.log('\nAC1c — account_id is never read from request body');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const { capture, restore } = makeTransactionMock();

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ name: 'Injected', account_id: 'evil-account' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC1c: response 200', res.status === 200);
    assert('AC1c: update data does not contain injected account_id',
      capture.propertiesUpdate.args?.data?.account_id === undefined);
    assert('AC1c: update where.id is the URL param',
      capture.propertiesUpdate.args?.where?.id === PROP_ID);
  }

  console.log('\nAC1d — empty body → 200 with no property update called');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const { capture, restore } = makeTransactionMock();

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC1d: response 200 on empty body', res.status === 200);
    // properties.update should NOT be called if no updatable fields provided
    assert('AC1d: tx.properties.update not called when no fields provided',
      capture.propertiesUpdate.called === false);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — checklist_body in body → turnover_checklists updated in same call
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2a — checklist_body triggers checklist UPDATE when row already exists');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const existingChecklist = { id: 'chk-001', checklist_body: 'Old steps' };
    const { capture, restore } = makeTransactionMock({ existingChecklist });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ checklist_body: 'New steps\nStep two' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC2a: response 200', res.status === 200);
    assert('AC2a: checklist findFirst called', capture.checklistFindFirst.called);
    assert('AC2a: checklist findFirst where.property_id = PROP_ID',
      capture.checklistFindFirst.args?.where?.property_id === PROP_ID);
    assert('AC2a: checklist UPDATE called (not create)', capture.checklistUpdate.called);
    assert('AC2a: checklist create NOT called', !capture.checklistCreate.called);
    assert('AC2a: checklist update where.id = existing row id',
      capture.checklistUpdate.args?.where?.id === 'chk-001');
    assert('AC2a: checklist update data.checklist_body correct',
      capture.checklistUpdate.args?.data?.checklist_body === 'New steps\nStep two');
    assert('AC2a: all in same $transaction', capture.called);
  }

  console.log('\nAC2b — checklist_body triggers checklist CREATE when no row exists');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const { capture, restore } = makeTransactionMock({ existingChecklist: null });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ checklist_body: 'First checklist' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC2b: response 200', res.status === 200);
    assert('AC2b: checklist CREATE called', capture.checklistCreate.called);
    assert('AC2b: checklist update NOT called', !capture.checklistUpdate.called);
    assert('AC2b: create data.property_id = PROP_ID',
      capture.checklistCreate.args?.data?.property_id === PROP_ID);
    assert('AC2b: create data.account_id from JWT',
      capture.checklistCreate.args?.data?.account_id === ACCOUNT_ID);
    assert('AC2b: create data.checklist_body correct',
      capture.checklistCreate.args?.data?.checklist_body === 'First checklist');
  }

  console.log('\nAC2c — no checklist_body in body → checklist NOT touched');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const { capture, restore } = makeTransactionMock();

    await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Just renaming' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC2c: checklist findFirst not called',  !capture.checklistFindFirst.called);
    assert('AC2c: checklist update not called',     !capture.checklistUpdate.called);
    assert('AC2c: checklist create not called',     !capture.checklistCreate.called);
  }

  console.log('\nAC2d — empty string checklist_body is valid (allowed)');
  {
    const restoreAuth = stubAuth();
    const origFU  = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const existingChecklist = { id: 'chk-002', checklist_body: 'Some steps' };
    const { capture, restore } = makeTransactionMock({ existingChecklist });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ checklist_body: '' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC2d: response 200 for empty checklist_body', res.status === 200);
    assert('AC2d: checklist update called with empty string',
      capture.checklistUpdate.called &&
      capture.checklistUpdate.args?.data?.checklist_body === '');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — auto_schedule_cleaner_enabled = true with no primary cleaner → 400
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3a — enabling auto_schedule with no existing primary and no primary_cleaner_id → 400');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () =>
      fakeProperty({ auto_schedule_cleaner_enabled: false });

    // No existing primary cleaner
    const origPC = (prisma.property_cleaners as any).findFirst;
    (prisma.property_cleaners as any).findFirst = async () => null;

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ auto_schedule_cleaner_enabled: true });

    (prisma.property_cleaners as any).findFirst = origPC;
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC3a: 400 when enabling auto_schedule with no primary', res.status === 400);
    assert('AC3a: error message mentions primary cleaner',
      /primary.*cleaner|auto.*schedule/i.test(res.body?.error ?? ''));
  }

  console.log('\nAC3b — enabling auto_schedule with existing active primary → 200');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () =>
      fakeProperty({ auto_schedule_cleaner_enabled: false });

    // Has an active primary cleaner
    const origPC = (prisma.property_cleaners as any).findFirst;
    (prisma.property_cleaners as any).findFirst = async () => ({
      id: 'pc-001', property_id: PROP_ID, cleaner_id: CLEANER_A, is_primary: true,
      cleaner: { is_active: true },
    });

    const { capture, restore } = makeTransactionMock();

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ auto_schedule_cleaner_enabled: true });

    restore();
    (prisma.property_cleaners as any).findFirst = origPC;
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC3b: 200 when active primary exists', res.status === 200);
    assert('AC3b: transaction still ran', capture.called);
  }

  console.log('\nAC3c — enabling auto_schedule AND providing primary_cleaner_id in same request → 200');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () =>
      fakeProperty({ auto_schedule_cleaner_enabled: false });

    // No need to check existing primary because primary_cleaner_id satisfies constraint
    const origPC = (prisma.property_cleaners as any).findFirst;
    let pcCallCount = 0;
    (prisma.property_cleaners as any).findFirst = async () => {
      pcCallCount++;
      return null; // even with no existing primary, constraint is satisfied by primary_cleaner_id
    };

    const { capture, restore } = makeTransactionMock();

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ auto_schedule_cleaner_enabled: true, primary_cleaner_id: CLEANER_A });

    restore();
    (prisma.property_cleaners as any).findFirst = origPC;
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC3c: 200 when primary_cleaner_id provided alongside auto_schedule=true',
      res.status === 200);
    // The constraint check should be skipped because primary_cleaner_id bypasses it
    assert('AC3c: property_cleaners.findFirst not called for constraint check',
      pcCallCount === 0);
    assert('AC3c: transaction ran', capture.called);
  }

  console.log('\nAC3d — property already has auto_schedule=true, request omits it; no primary → 400');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    // Property already has auto_schedule enabled
    (prisma.properties as any).findUnique = async () =>
      fakeProperty({ auto_schedule_cleaner_enabled: true });

    const origPC = (prisma.property_cleaners as any).findFirst;
    (prisma.property_cleaners as any).findFirst = async () => null; // no active primary

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Just renaming' }); // doesn't touch auto_schedule, but it stays true

    (prisma.property_cleaners as any).findFirst = origPC;
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC3d: 400 when auto_schedule already true and no active primary',
      res.status === 400);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — Cross-account property ID → 404
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — property belongs to a different account → 404');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () =>
      fakeProperty({ account_id: OTHER_ACCOUNT });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ name: 'Attempted update' });

    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC4a: 404 when property belongs to other account', res.status === 404);
  }

  console.log('\nAC4b — property does not exist → 404');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => null;

    const res = await request(testApp)
      .patch(`/api/properties/nonexistent-id`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Ghost property' });

    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC4b: 404 when property not found', res.status === 404);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — primary_cleaner_id update → clears old primary, sets new one in transaction
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — primary_cleaner_id clears old primary and promotes new one (existing row)');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    // Cleaner B already has a non-primary property_cleaners row
    const existingCleanerRow = {
      id:         'pc-002',
      property_id: PROP_ID,
      cleaner_id: CLEANER_B,
      is_primary: false,
    };
    const { capture, restore } = makeTransactionMock({ existingCleanerRow });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ primary_cleaner_id: CLEANER_B });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC5a: response 200', res.status === 200);
    assert('AC5a: all in $transaction', capture.called);

    // Demote old primary
    assert('AC5a: updateMany called to clear old primary', capture.cleanersUpdateMany.called);
    assert('AC5a: updateMany where.property_id = PROP_ID',
      capture.cleanersUpdateMany.args?.where?.property_id === PROP_ID);
    assert('AC5a: updateMany where.is_primary = true',
      capture.cleanersUpdateMany.args?.where?.is_primary === true);
    assert('AC5a: updateMany sets is_primary = false',
      capture.cleanersUpdateMany.args?.data?.is_primary === false);

    // findFirst to check if new cleaner already has a row
    assert('AC5a: cleanerRow findFirst called', capture.cleanerRowFindFirst.called);
    assert('AC5a: cleanerRow findFirst where.cleaner_id = CLEANER_B',
      capture.cleanerRowFindFirst.args?.where?.cleaner_id === CLEANER_B);

    // Promote via UPDATE (row already exists)
    assert('AC5a: cleanerRow UPDATE called (not create)', capture.cleanerRowUpdate.called);
    assert('AC5a: cleanerRow create NOT called', !capture.cleanerRowCreate.called);
    assert('AC5a: update where.id = existing row id',
      capture.cleanerRowUpdate.args?.where?.id === 'pc-002');
    assert('AC5a: update sets is_primary = true',
      capture.cleanerRowUpdate.args?.data?.is_primary === true);
  }

  console.log('\nAC5b — primary_cleaner_id promotes new cleaner via CREATE when no row exists');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    // No existing property_cleaners row for CLEANER_A
    const { capture, restore } = makeTransactionMock({ existingCleanerRow: null });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ primary_cleaner_id: CLEANER_A });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC5b: response 200', res.status === 200);
    assert('AC5b: updateMany still called to clear old primary', capture.cleanersUpdateMany.called);
    assert('AC5b: cleanerRow CREATE called', capture.cleanerRowCreate.called);
    assert('AC5b: update NOT called', !capture.cleanerRowUpdate.called);
    assert('AC5b: create data.property_id = PROP_ID',
      capture.cleanerRowCreate.args?.data?.property_id === PROP_ID);
    assert('AC5b: create data.cleaner_id = CLEANER_A',
      capture.cleanerRowCreate.args?.data?.cleaner_id === CLEANER_A);
    assert('AC5b: create data.is_primary = true',
      capture.cleanerRowCreate.args?.data?.is_primary === true);
    assert('AC5b: create data.account_id from JWT',
      capture.cleanerRowCreate.args?.data?.account_id === ACCOUNT_ID);
  }

  console.log('\nAC5c — no primary_cleaner_id → cleaner tables not touched');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const { capture, restore } = makeTransactionMock();

    await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'No cleaner change' });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC5c: updateMany NOT called', !capture.cleanersUpdateMany.called);
    assert('AC5c: cleanerRow findFirst NOT called', !capture.cleanerRowFindFirst.called);
    assert('AC5c: cleanerRow update NOT called',    !capture.cleanerRowUpdate.called);
    assert('AC5c: cleanerRow create NOT called',    !capture.cleanerRowCreate.called);
  }

  console.log('\nAC5d — combined: checklist_body + primary_cleaner_id + field update all in one transaction');
  {
    const restoreAuth = stubAuth();
    const origFU = (prisma.properties as any).findUnique;
    (prisma.properties as any).findUnique = async () => fakeProperty();

    const { capture, restore } = makeTransactionMock({
      existingChecklist:  { id: 'chk-003', checklist_body: 'Old' },
      existingCleanerRow: null,
    });

    const res = await request(testApp)
      .patch(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'All at once', checklist_body: 'New steps', primary_cleaner_id: CLEANER_A });

    restore();
    (prisma.properties as any).findUnique = origFU;
    restoreAuth();

    assert('AC5d: response 200', res.status === 200);
    assert('AC5d: single $transaction call', capture.called);
    assert('AC5d: property update called',   capture.propertiesUpdate.called);
    assert('AC5d: checklist update called',  capture.checklistUpdate.called);
    assert('AC5d: cleaners updateMany called', capture.cleanersUpdateMany.called);
    assert('AC5d: cleaner create called',    capture.cleanerRowCreate.called);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source-level checks
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — verify PATCH handler structure');
  {
    const src = fs.readFileSync(path.join(__dirname, 'properties.ts'), 'utf8');

    assert('src: PATCH /:id route registered',
      /router\.patch\s*\(\s*['"]\/:id['"]/.test(src));
    assert('src: uses prisma.$transaction',
      /\$transaction/.test(src));
    assert('src: tx.properties.update inside transaction',
      /tx\.properties\.update/.test(src));
    assert('src: tx.turnover_checklists inside transaction',
      /tx\.turnover_checklists/.test(src));
    assert('src: tx.property_cleaners.updateMany (clear old primary)',
      /tx\.property_cleaners\.updateMany/.test(src));
    assert('src: account_id from req.accountId (not req.body)',
      /req\.accountId/.test(src) && !/req\.body\.account_id/.test(src));
    assert('src: 404 check on existing property',
      /404/.test(src) && /account_id/.test(src));
    assert('src: auto_schedule constraint check',
      /auto_schedule_cleaner_enabled/.test(src) && /400/.test(src));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
