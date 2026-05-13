/**
 * T-036 verification — POST /api/cleaners + GET /api/cleaners + PATCH /api/cleaners/:id
 *
 * AC1  POST /api/cleaners with valid E.164 phone -> creates cleaner row.
 * AC2  POST /api/cleaners with non-E.164 phone -> 400 with format guidance.
 * AC3  GET /api/cleaners returns all cleaners with property assignments.
 * AC4  PATCH deactivation with primary assignments -> 400 with property list.
 * AC5  PATCH deactivation with no primary assignments -> is_active = false.
 * AC6  Account isolation enforced.
 *
 * Run: npx ts-node src/routes/t036.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t036';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import cleanersRouter from './cleaners';

// ── Minimal test app ──────────────────────────────────────────────────────────
const testApp = express();
testApp.use(express.json());
testApp.use('/api/cleaners', cleanersRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────
const JWT_SECRET    = 'test-secret-t036';
const ACCOUNT_ID    = 'acc-t036-001';
const OTHER_ACCOUNT = 'acc-t036-OTHER';
const CLEANER_ID    = 'cleaner-t036-001';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeCleaner(overrides: Record<string, unknown> = {}) {
  return {
    id:         CLEANER_ID,
    account_id: ACCOUNT_ID,
    name:       'Maria Lopez',
    phone:      '+13055550001',
    email:      'maria@example.com',
    is_active:  true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeCleanerWithAssignments(overrides: Record<string, unknown> = {}) {
  return {
    ...fakeCleaner(),
    property_cleaners: [
      {
        id:          'pc-001',
        account_id:  ACCOUNT_ID,
        property_id: 'prop-001',
        cleaner_id:  CLEANER_ID,
        is_primary:  true,
        created_at:  new Date(),
        property:    { id: 'prop-001', name: 'Beach House' },
      },
    ],
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
  // AC1 — POST with valid E.164 phone creates cleaner row
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — POST with valid E.164 phone → 201 + cleaner created');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaners as any).create;
    let capturedArgs: any = null;
    (prisma.cleaners as any).create = async (args: any) => {
      capturedArgs = args;
      return fakeCleaner();
    };

    const res = await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Maria Lopez', phone: '+13055550001', email: 'maria@example.com' });

    (prisma.cleaners as any).create = orig;
    restore();

    assert('AC1a: status 201',                    res.status === 201);
    assert('AC1a: data.id in response',           typeof res.body?.data?.id === 'string');
    assert('AC1a: create called',                 capturedArgs !== null);
    assert('AC1a: create data.account_id = JWT',  capturedArgs?.data?.account_id === ACCOUNT_ID);
    assert('AC1a: create data.name trimmed',      capturedArgs?.data?.name === 'Maria Lopez');
    assert('AC1a: create data.phone stored',      capturedArgs?.data?.phone === '+13055550001');
    assert('AC1a: create data.email stored',      capturedArgs?.data?.email === 'maria@example.com');
  }

  console.log('\nAC1b — POST without email → email stored as null');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaners as any).create;
    let capturedArgs: any = null;
    (prisma.cleaners as any).create = async (args: any) => { capturedArgs = args; return fakeCleaner({ email: null }); };

    await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Jose', phone: '+13055550002' });

    (prisma.cleaners as any).create = orig;
    restore();

    assert('AC1b: email null when not provided', capturedArgs?.data?.email === null);
  }

  console.log('\nAC1c — POST valid phone variants accepted by E.164 regex');
  {
    const validPhones = [
      '+447911123456',   // UK mobile
      '+12125551234',    // US
      '+5511912345678',  // Brazil
      '+13',             // minimal valid (+ 1 country digit + 1 more digit)
    ];

    for (const phone of validPhones) {
      const restore = stubAuth();
      const orig = (prisma.cleaners as any).create;
      (prisma.cleaners as any).create = async () => fakeCleaner({ phone });

      const res = await request(testApp)
        .post('/api/cleaners')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Test Cleaner', phone });

      (prisma.cleaners as any).create = orig;
      restore();

      assert(`AC1c: ${phone} is accepted (201)`, res.status === 201);
    }
  }

  console.log('\nAC1d — POST trims leading/trailing whitespace from name');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaners as any).create;
    let capturedArgs: any = null;
    (prisma.cleaners as any).create = async (args: any) => { capturedArgs = args; return fakeCleaner(); };

    await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: '  Ana Garcia  ', phone: '+13055550003' });

    (prisma.cleaners as any).create = orig;
    restore();

    assert('AC1d: name trimmed before storage', capturedArgs?.data?.name === 'Ana Garcia');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — POST with non-E.164 phone → 400 with format guidance
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2a — various invalid phone formats → 400');
  {
    const invalidPhones = [
      { phone: '3055550001',      label: 'no leading +' },
      { phone: '+0305555001',     label: 'country code starts with 0' },
      { phone: '+1',              label: 'only one digit after +' },
      { phone: '555-1234',        label: 'formatted domestic number' },
      { phone: '+1 305 555 0001', label: 'spaces in number' },
      { phone: '+1234567890123456', label: '16 digits (too long)' },
      { phone: '',                label: 'empty string' },
    ];

    for (const { phone, label } of invalidPhones) {
      const restore = stubAuth();
      const orig = (prisma.cleaners as any).create;
      let createCalled = false;
      (prisma.cleaners as any).create = async () => { createCalled = true; return fakeCleaner(); };

      const res = await request(testApp)
        .post('/api/cleaners')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ name: 'Test', phone });

      (prisma.cleaners as any).create = orig;
      restore();

      assert(`AC2a: 400 for "${label}"`, res.status === 400);
      assert(`AC2a: error body present for "${label}"`, typeof res.body?.error === 'string');
      assert(`AC2a: DB not called for "${label}"`, createCalled === false);
    }
  }

  console.log('\nAC2b — response error message contains E.164 format guidance');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Test', phone: '3055550001' });
    restore();

    assert('AC2b: error mentions E.164 or example format',
      /E\.164|e\.g\.|format/i.test(res.body?.error ?? ''));
  }

  console.log('\nAC2c — missing phone field → 400');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Test' });
    restore();
    assert('AC2c: 400 when phone missing', res.status === 400);
  }

  console.log('\nAC2d — missing name field → 400');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ phone: '+13055550001' });
    restore();
    assert('AC2d: 400 when name missing', res.status === 400);
    assert('AC2d: error mentions name', /name/i.test(res.body?.error ?? ''));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — GET /api/cleaners returns all cleaners with property assignments
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3a — GET returns cleaners for authenticated account with property assignments');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaners as any).findMany;
    let capturedArgs: any = null;
    (prisma.cleaners as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [
        fakeCleanerWithAssignments(),
        fakeCleanerWithAssignments({
          id: 'cleaner-002', name: 'Jose Reyes',
          property_cleaners: [],
        }),
      ];
    };

    const res = await request(testApp)
      .get('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.cleaners as any).findMany = orig;
    restore();

    assert('AC3a: response 200',                   res.status === 200);
    assert('AC3a: where.account_id from JWT',      capturedArgs?.where?.account_id === ACCOUNT_ID);
    assert('AC3a: ordered by name asc',            capturedArgs?.orderBy?.name === 'asc');
    assert('AC3a: includes property_cleaners',
      capturedArgs?.include?.property_cleaners !== undefined);
    assert('AC3a: property_cleaners includes property',
      capturedArgs?.include?.property_cleaners?.include?.property !== undefined);
    assert('AC3a: data is array',                  Array.isArray(res.body?.data));
    assert('AC3a: 2 cleaners returned',            res.body?.data?.length === 2);
    assert('AC3a: first cleaner has property_cleaners',
      Array.isArray(res.body?.data?.[0]?.property_cleaners));
    assert('AC3a: property_cleaners has property.name',
      res.body?.data?.[0]?.property_cleaners?.[0]?.property?.name === 'Beach House');
    assert('AC3a: second cleaner has empty assignments',
      res.body?.data?.[1]?.property_cleaners?.length === 0);
  }

  console.log('\nAC3b — GET without token → 401');
  {
    const res = await request(testApp).get('/api/cleaners');
    assert('AC3b: 401 without token', res.status === 401);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — PATCH deactivation with primary assignments → 400 with property list
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — deactivation with primary assignment → 400 with property list');
  {
    const restore = stubAuth();

    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner();

    const origFM = (prisma.property_cleaners as any).findMany;
    let capturedFMArgs: any = null;
    (prisma.property_cleaners as any).findMany = async (args: any) => {
      capturedFMArgs = args;
      return [
        { property: { id: 'prop-001', name: 'Beach House' } },
        { property: { id: 'prop-002', name: 'Mountain Cabin' } },
      ];
    };

    const origUpdate = (prisma.cleaners as any).update;
    let updateCalled = false;
    (prisma.cleaners as any).update = async () => { updateCalled = true; return fakeCleaner(); };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ is_active: false });

    (prisma.cleaners as any).update = origUpdate;
    (prisma.property_cleaners as any).findMany = origFM;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC4a: status 400',                     res.status === 400);
    assert('AC4a: error field present',            typeof res.body?.error === 'string');
    assert('AC4a: properties array in response',   Array.isArray(res.body?.properties));
    assert('AC4a: properties list has 2 items',    res.body?.properties?.length === 2);
    assert('AC4a: first property name correct',    res.body?.properties?.[0]?.name === 'Beach House');
    assert('AC4a: second property name correct',   res.body?.properties?.[1]?.name === 'Mountain Cabin');
    assert('AC4a: DB update NOT called',           updateCalled === false);

    // Cascade check queried correct fields
    assert('AC4a: findMany where.cleaner_id = CLEANER_ID',
      capturedFMArgs?.where?.cleaner_id === CLEANER_ID);
    assert('AC4a: findMany where.is_primary = true',
      capturedFMArgs?.where?.is_primary === true);
  }

  console.log('\nAC4b — deactivation with one primary property → 400 with that property in list');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner();

    const origFM = (prisma.property_cleaners as any).findMany;
    (prisma.property_cleaners as any).findMany = async () => [
      { property: { id: 'prop-001', name: 'Beach House' } },
    ];

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ is_active: false });

    (prisma.property_cleaners as any).findMany = origFM;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC4b: 400', res.status === 400);
    assert('AC4b: properties list has 1 item', res.body?.properties?.length === 1);
    assert('AC4b: property id correct', res.body?.properties?.[0]?.id === 'prop-001');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — PATCH deactivation with no primary assignments → is_active = false
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — deactivation with no primary assignments → is_active = false');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner();

    const origFM = (prisma.property_cleaners as any).findMany;
    (prisma.property_cleaners as any).findMany = async () => [];  // no primary assignments

    const origUpdate = (prisma.cleaners as any).update;
    let capturedUpdate: any = null;
    (prisma.cleaners as any).update = async (args: any) => {
      capturedUpdate = args;
      return fakeCleaner({ is_active: false });
    };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ is_active: false });

    (prisma.cleaners as any).update = origUpdate;
    (prisma.property_cleaners as any).findMany = origFM;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC5a: status 200',                    res.status === 200);
    assert('AC5a: update called',                 capturedUpdate !== null);
    assert('AC5a: update where.id = CLEANER_ID',  capturedUpdate?.where?.id === CLEANER_ID);
    assert('AC5a: update data.is_active = false', capturedUpdate?.data?.is_active === false);
    assert('AC5a: data.is_active false in response',
      res.body?.data?.is_active === false);
  }

  console.log('\nAC5b — cascade check only fires on is_active=false, not other field updates');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner();

    const origFM = (prisma.property_cleaners as any).findMany;
    let pcFindManyCalled = false;
    (prisma.property_cleaners as any).findMany = async () => {
      pcFindManyCalled = true;
      return [{ property: { id: 'p1', name: 'Some Property' } }];
    };

    const origUpdate = (prisma.cleaners as any).update;
    let capturedUpdate: any = null;
    (prisma.cleaners as any).update = async (args: any) => { capturedUpdate = args; return fakeCleaner({ name: 'New Name' }); };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'New Name', email: 'new@example.com' }); // no is_active in body

    (prisma.cleaners as any).update = origUpdate;
    (prisma.property_cleaners as any).findMany = origFM;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC5b: 200 when updating name/email without touching is_active', res.status === 200);
    assert('AC5b: cascade check NOT triggered for non-deactivation update',
      pcFindManyCalled === false);
    assert('AC5b: update data.name updated', capturedUpdate?.data?.name === 'New Name');
    assert('AC5b: update data.email updated', capturedUpdate?.data?.email === 'new@example.com');
  }

  console.log('\nAC5c — reactivation (is_active=true) does NOT trigger cascade check');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner({ is_active: false });

    const origFM = (prisma.property_cleaners as any).findMany;
    let pcFindManyCalled = false;
    (prisma.property_cleaners as any).findMany = async () => {
      pcFindManyCalled = true;
      return [];
    };

    const origUpdate = (prisma.cleaners as any).update;
    let capturedUpdate: any = null;
    (prisma.cleaners as any).update = async (args: any) => { capturedUpdate = args; return fakeCleaner({ is_active: true }); };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ is_active: true });

    (prisma.cleaners as any).update = origUpdate;
    (prisma.property_cleaners as any).findMany = origFM;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC5c: 200 on reactivation', res.status === 200);
    assert('AC5c: cascade check NOT triggered for reactivation', pcFindManyCalled === false);
    assert('AC5c: update data.is_active = true', capturedUpdate?.data?.is_active === true);
  }

  console.log('\nAC5d — PATCH with valid phone update (E.164 re-validated)');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner();

    const origUpdate = (prisma.cleaners as any).update;
    let capturedUpdate: any = null;
    (prisma.cleaners as any).update = async (args: any) => { capturedUpdate = args; return fakeCleaner({ phone: '+17865550002' }); };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ phone: '+17865550002' });

    (prisma.cleaners as any).update = origUpdate;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC5d: 200 on valid phone update', res.status === 200);
    assert('AC5d: update data.phone stored', capturedUpdate?.data?.phone === '+17865550002');
  }

  console.log('\nAC5e — PATCH with invalid phone → 400 (re-validates on update)');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner();

    const origUpdate = (prisma.cleaners as any).update;
    let updateCalled = false;
    (prisma.cleaners as any).update = async () => { updateCalled = true; return fakeCleaner(); };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ phone: '786-555-0002' });

    (prisma.cleaners as any).update = origUpdate;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC5e: 400 on invalid phone in PATCH', res.status === 400);
    assert('AC5e: DB update not called',          updateCalled === false);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — Account isolation enforced
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6a — POST /api/cleaners without token → 401');
  {
    const res = await request(testApp).post('/api/cleaners').send({ name: 'X', phone: '+13055550001' });
    assert('AC6a: 401 on POST without token', res.status === 401);
  }

  console.log('\nAC6b — PATCH /api/cleaners/:id without token → 401');
  {
    const res = await request(testApp).patch(`/api/cleaners/${CLEANER_ID}`).send({ name: 'X' });
    assert('AC6b: 401 on PATCH without token', res.status === 401);
  }

  console.log('\nAC6c — POST account_id comes from JWT, never from request body');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaners as any).create;
    let capturedArgs: any = null;
    (prisma.cleaners as any).create = async (args: any) => { capturedArgs = args; return fakeCleaner(); };

    await request(testApp)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ name: 'X', phone: '+13055550001', account_id: 'evil-account' });

    (prisma.cleaners as any).create = orig;
    restore();

    assert('AC6c: create data.account_id = JWT account',
      capturedArgs?.data?.account_id === ACCOUNT_ID);
    assert('AC6c: injected account_id ignored',
      capturedArgs?.data?.account_id !== 'evil-account');
  }

  console.log('\nAC6d — GET account_id filter always from JWT');
  {
    const restore = stubAuth();
    const orig = (prisma.cleaners as any).findMany;
    let capturedWhere: any = null;
    (prisma.cleaners as any).findMany = async (args: any) => { capturedWhere = args.where; return []; };

    await request(testApp)
      .get('/api/cleaners?account_id=injected-other')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.cleaners as any).findMany = orig;
    restore();

    assert('AC6d: GET where.account_id from JWT', capturedWhere?.account_id === ACCOUNT_ID);
    assert('AC6d: injected account_id ignored',    capturedWhere?.account_id !== 'injected-other');
  }

  console.log('\nAC6e — PATCH cleaner from different account → 404');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => fakeCleaner({ account_id: OTHER_ACCOUNT });

    const origUpdate = (prisma.cleaners as any).update;
    let updateCalled = false;
    (prisma.cleaners as any).update = async () => { updateCalled = true; return fakeCleaner(); };

    const res = await request(testApp)
      .patch(`/api/cleaners/${CLEANER_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ name: 'New Name' });

    (prisma.cleaners as any).update = origUpdate;
    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC6e: 404 for cross-account cleaner', res.status === 404);
    assert('AC6e: update NOT called',              updateCalled === false);
  }

  console.log('\nAC6f — PATCH nonexistent cleaner → 404');
  {
    const restore = stubAuth();
    const origFU = (prisma.cleaners as any).findUnique;
    (prisma.cleaners as any).findUnique = async () => null;

    const res = await request(testApp)
      .patch(`/api/cleaners/nonexistent`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'X' });

    (prisma.cleaners as any).findUnique = origFU;
    restore();

    assert('AC6f: 404 for nonexistent cleaner', res.status === 404);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source-level checks
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — verify route structure, E.164 regex, and index registration');
  {
    const src    = fs.readFileSync(path.join(__dirname, 'cleaners.ts'), 'utf8');
    const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

    // Route handlers
    assert('src: POST / handler',              /router\.post\s*\(\s*['"]\/['"]/.test(src));
    assert('src: GET / handler',               /router\.get\s*\(\s*['"]\/['"]/.test(src));
    assert('src: PATCH /:id handler',          /router\.patch\s*\(\s*['"]\/:id['"]/.test(src));

    // E.164 regex present
    assert('src: E.164 regex defined',
      /\+\[1-9\]\\d\{1,14\}/.test(src));

    // account_id isolation
    assert('src: account_id from req.accountId',
      /req\.accountId/.test(src));
    assert('src: no req.body.account_id',
      !/req\.body\.account_id/.test(src));

    // Cascade check fields
    assert('src: checks is_primary in cascade query',
      /is_primary.*true|is_primary:\s*true/.test(src));
    assert('src: returns properties array on 400',
      /properties\s*:/.test(src));

    // include property_cleaners in GET
    assert('src: GET includes property_cleaners',
      /property_cleaners/.test(src));

    // index.ts registration
    assert('src: index.ts imports cleanersRouter',
      /cleanersRouter/.test(idxSrc));
    assert('src: index.ts mounts cleanersRouter under /api/cleaners',
      /app\.use\(['"]\/api\/cleaners['"].*cleanersRouter\)/.test(idxSrc));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
