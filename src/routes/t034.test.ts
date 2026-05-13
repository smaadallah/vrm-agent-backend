/**
 * T-034 verification — GET /api/properties + POST /api/properties + GET /api/properties/:id
 *
 * AC1  GET /api/properties returns all properties for authenticated account only.
 * AC2  POST /api/properties with missing required field -> 400.
 * AC3  POST /api/properties success -> properties AND turnover_checklists rows both created
 *      in the same transaction.
 * AC4  account_id on both rows is from JWT, not request body.
 * AC5  GET /api/properties/:id returns property with checklist_body and assigned cleaners.
 *
 * Run: npx ts-node src/routes/t034.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t034';
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const JWT_SECRET    = 'test-secret-t034';
const ACCOUNT_ID    = 'acc-t034-001';
const OTHER_ACCOUNT = 'acc-t034-OTHER';
const PROP_ID       = 'prop-t034-001';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeProperty(overrides: Record<string, unknown> = {}) {
  return {
    id:                                  PROP_ID,
    account_id:                          ACCOUNT_ID,
    name:                                'Beach House',
    address:                             '1 Ocean Dr',
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
    auto_schedule_cleaner_enabled:       true,
    cleaner_confirmation_window_minutes: 60,
    pre_checkin_alert_minutes:           30,
    created_at:                          new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fakePropertyWithRelations(overrides: Record<string, unknown> = {}) {
  return {
    ...fakeProperty(),
    turnover_checklists: [{ checklist_body: 'Wipe counters\nVacuum floors' }],
    property_cleaners: [
      {
        id:         'pc-001',
        account_id: ACCOUNT_ID,
        property_id: PROP_ID,
        cleaner_id: 'cleaner-001',
        is_primary: true,
        created_at: new Date(),
        cleaner: {
          id:         'cleaner-001',
          account_id: ACCOUNT_ID,
          name:       'Maria Lopez',
          phone:      '+13055550001',
          email:      null,
          is_active:  true,
          created_at: new Date(),
        },
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

// Stub accounts.findUnique so authMiddleware passes without a real DB call.
function stubAuth(tokenVersion = 1): () => void {
  const orig = (prisma.accounts as any).findUnique;
  (prisma.accounts as any).findUnique = async () => ({ token_version: tokenVersion });
  return () => { (prisma.accounts as any).findUnique = orig; };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
(async () => {

  // ════════════════════════════════════════════════════════════════════════════
  // AC1 — GET /api/properties returns properties for authenticated account only
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — GET /api/properties without token → 401');
  {
    const res = await request(testApp).get('/api/properties');
    assert('AC1a: 401 with no token', res.status === 401);
  }

  console.log('\nAC1b — GET /api/properties returns properties for JWT account');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findMany;

    let capturedArgs: any = null;
    (prisma.properties as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [fakeProperty(), fakeProperty({ id: 'prop-002', name: 'Mountain Cabin' })];
    };

    const res = await request(testApp)
      .get('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.properties as any).findMany = orig;
    restore();

    assert('AC1b: response 200', res.status === 200);
    assert('AC1b: where.account_id from JWT', capturedArgs?.where?.account_id === ACCOUNT_ID);
    assert('AC1b: orderBy name asc', capturedArgs?.orderBy?.name === 'asc');
    assert('AC1b: data is an array', Array.isArray(res.body?.data));
    assert('AC1b: data has 2 properties', res.body?.data?.length === 2);
  }

  console.log('\nAC1c — account_id cannot be injected via query string');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findMany;

    let capturedWhere: any = null;
    (prisma.properties as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/properties?account_id=injected-other')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.properties as any).findMany = orig;
    restore();

    assert('AC1c: where.account_id = JWT account', capturedWhere?.account_id === ACCOUNT_ID);
    assert('AC1c: injected account_id ignored',    capturedWhere?.account_id !== 'injected-other');
  }

  console.log('\nAC1d — different JWT account → different where.account_id');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findMany;

    let capturedWhere: any = null;
    (prisma.properties as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/properties')
      .set('Authorization', `Bearer ${makeToken(OTHER_ACCOUNT)}`);

    (prisma.properties as any).findMany = orig;
    restore();

    assert('AC1d: where.account_id = OTHER_ACCOUNT', capturedWhere?.account_id === OTHER_ACCOUNT);
    assert('AC1d: not equal to ACCOUNT_ID',           capturedWhere?.account_id !== ACCOUNT_ID);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — POST /api/properties with missing required field → 400
  // ════════════════════════════════════════════════════════════════════════════

  const validBody = {
    name: 'Ocean View',
    address: '2 Beach Rd',
    checkin_time: '15:00',
    checkout_time: '11:00',
  };

  console.log('\nAC2a — missing name → 400');
  {
    const restore = stubAuth();
    const { name: _n, ...noName } = validBody;
    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(noName);
    restore();
    assert('AC2a: 400 when name missing', res.status === 400);
    assert('AC2a: error mentions name', /name/i.test(res.body?.error ?? ''));
  }

  console.log('\nAC2b — missing address → 400');
  {
    const restore = stubAuth();
    const { address: _a, ...noAddress } = validBody;
    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(noAddress);
    restore();
    assert('AC2b: 400 when address missing', res.status === 400);
    assert('AC2b: error mentions address', /address/i.test(res.body?.error ?? ''));
  }

  console.log('\nAC2c — missing checkin_time → 400');
  {
    const restore = stubAuth();
    const { checkin_time: _c, ...noCheckin } = validBody;
    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(noCheckin);
    restore();
    assert('AC2c: 400 when checkin_time missing', res.status === 400);
    assert('AC2c: error mentions checkin_time', /checkin_time/i.test(res.body?.error ?? ''));
  }

  console.log('\nAC2d — missing checkout_time → 400');
  {
    const restore = stubAuth();
    const { checkout_time: _co, ...noCheckout } = validBody;
    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(noCheckout);
    restore();
    assert('AC2d: 400 when checkout_time missing', res.status === 400);
    assert('AC2d: error mentions checkout_time', /checkout_time/i.test(res.body?.error ?? ''));
  }

  console.log('\nAC2e — empty string for required field → 400');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...validBody, name: '   ' });
    restore();
    assert('AC2e: 400 when name is whitespace', res.status === 400);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — POST success: both property AND turnover_checklists created in transaction
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3 — POST /api/properties creates property + checklist in one transaction');
  {
    const restore = stubAuth();
    const origTransaction = (prisma as any).$transaction;

    let transactionCalled = false;
    let propertiesCreateArgs: any = null;
    let checklistCreateArgs: any = null;

    // Mock $transaction to call the callback with a mock tx object
    const mockTx = {
      properties: {
        create: async (args: any) => {
          propertiesCreateArgs = args;
          return { ...fakeProperty(), id: 'new-prop-001' };
        },
      },
      turnover_checklists: {
        create: async (args: any) => {
          checklistCreateArgs = args;
          return { id: 'chk-001', account_id: ACCOUNT_ID, property_id: 'new-prop-001', checklist_body: '' };
        },
      },
    };

    (prisma as any).$transaction = async (fn: any) => {
      transactionCalled = true;
      return fn(mockTx);
    };

    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(validBody);

    (prisma as any).$transaction = origTransaction;
    restore();

    assert('AC3: response 201', res.status === 201);
    assert('AC3: $transaction was called', transactionCalled);
    assert('AC3: properties.create was called', propertiesCreateArgs !== null);
    assert('AC3: turnover_checklists.create was called', checklistCreateArgs !== null);
    assert('AC3: checklist property_id matches created property',
      checklistCreateArgs?.data?.property_id === 'new-prop-001');
    assert('AC3: checklist_body is empty string',
      checklistCreateArgs?.data?.checklist_body === '');
    assert('AC3: response contains data.id', typeof res.body?.data?.id === 'string');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — account_id on both rows from JWT, never from request body
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4 — account_id comes from JWT, not request body');
  {
    const restore = stubAuth();
    const origTransaction = (prisma as any).$transaction;

    let propertiesCreateArgs: any = null;
    let checklistCreateArgs: any = null;

    const mockTx = {
      properties: {
        create: async (args: any) => {
          propertiesCreateArgs = args;
          return { ...fakeProperty(), id: 'new-prop-002' };
        },
      },
      turnover_checklists: {
        create: async (args: any) => {
          checklistCreateArgs = args;
          return { id: 'chk-002' };
        },
      },
    };

    (prisma as any).$transaction = async (fn: any) => fn(mockTx);

    // Attempt to inject a different account_id in the request body
    const res = await request(testApp)
      .post('/api/properties')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ ...validBody, account_id: 'evil-account-id' });

    (prisma as any).$transaction = origTransaction;
    restore();

    assert('AC4: response 201', res.status === 201);
    assert('AC4: properties.create uses JWT account_id',
      propertiesCreateArgs?.data?.account_id === ACCOUNT_ID);
    assert('AC4: properties.create ignores injected account_id',
      propertiesCreateArgs?.data?.account_id !== 'evil-account-id');
    assert('AC4: turnover_checklists.create uses JWT account_id',
      checklistCreateArgs?.data?.account_id === ACCOUNT_ID);
    assert('AC4: turnover_checklists.create ignores injected account_id',
      checklistCreateArgs?.data?.account_id !== 'evil-account-id');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — GET /api/properties/:id returns property with checklist_body + cleaners
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — GET /api/properties/:id returns property with checklist_body and cleaners');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findUnique;

    let capturedArgs: any = null;
    (prisma.properties as any).findUnique = async (args: any) => {
      capturedArgs = args;
      return fakePropertyWithRelations();
    };

    const res = await request(testApp)
      .get(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.properties as any).findUnique = orig;
    restore();

    assert('AC5a: response 200', res.status === 200);
    assert('AC5a: findUnique where.id = PROP_ID', capturedArgs?.where?.id === PROP_ID);
    assert('AC5a: includes turnover_checklists in query', capturedArgs?.include?.turnover_checklists !== undefined);
    assert('AC5a: includes property_cleaners in query',   capturedArgs?.include?.property_cleaners !== undefined);

    const data = res.body?.data;
    assert('AC5a: data.id present',              data?.id === PROP_ID);
    assert('AC5a: data.name present',            data?.name === 'Beach House');
    assert('AC5a: checklist_body is a string',   typeof data?.checklist_body === 'string');
    assert('AC5a: checklist_body = checklist',   data?.checklist_body === 'Wipe counters\nVacuum floors');
    assert('AC5a: cleaners array present',       Array.isArray(data?.cleaners));
    assert('AC5a: cleaners has 1 entry',         data?.cleaners?.length === 1);
    assert('AC5a: cleaner name correct',         data?.cleaners?.[0]?.name === 'Maria Lopez');
    assert('AC5a: cleaner.is_primary = true',    data?.cleaners?.[0]?.is_primary === true);
    // Relation arrays not leaked in response
    assert('AC5a: no turnover_checklists array in response', data?.turnover_checklists === undefined);
    assert('AC5a: no property_cleaners array in response',   data?.property_cleaners === undefined);
  }

  console.log('\nAC5b — GET /api/properties/:id with no checklist row → checklist_body = ""');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findUnique;

    (prisma.properties as any).findUnique = async () =>
      fakePropertyWithRelations({ turnover_checklists: [] });

    const res = await request(testApp)
      .get(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.properties as any).findUnique = orig;
    restore();

    assert('AC5b: 200 even when no checklist row', res.status === 200);
    assert('AC5b: checklist_body = ""', res.body?.data?.checklist_body === '');
  }

  console.log('\nAC5c — GET /api/properties/:id with no cleaners → cleaners = []');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findUnique;

    (prisma.properties as any).findUnique = async () =>
      fakePropertyWithRelations({ property_cleaners: [] });

    const res = await request(testApp)
      .get(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.properties as any).findUnique = orig;
    restore();

    assert('AC5c: 200 when no cleaners', res.status === 200);
    assert('AC5c: cleaners = []', Array.isArray(res.body?.data?.cleaners) && res.body.data.cleaners.length === 0);
  }

  console.log('\nAC5d — GET /api/properties/:id for different account → 404');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findUnique;

    (prisma.properties as any).findUnique = async () =>
      // Property belongs to a different account
      fakePropertyWithRelations({ account_id: OTHER_ACCOUNT });

    const res = await request(testApp)
      .get(`/api/properties/${PROP_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.properties as any).findUnique = orig;
    restore();

    assert('AC5d: 404 when property belongs to other account', res.status === 404);
  }

  console.log('\nAC5e — GET /api/properties/:id for non-existent property → 404');
  {
    const restore = stubAuth();
    const orig = (prisma.properties as any).findUnique;

    (prisma.properties as any).findUnique = async () => null;

    const res = await request(testApp)
      .get(`/api/properties/nonexistent-id`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.properties as any).findUnique = orig;
    restore();

    assert('AC5e: 404 when property not found', res.status === 404);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source-level checks — verify structural constraints in the implementation
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — verify route structure and registration');
  {
    const propSrc = fs.readFileSync(path.join(__dirname, 'properties.ts'), 'utf8');
    const idxSrc  = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

    // Route handlers registered
    assert('src: GET / handler on properties router',
      /router\.get\s*\(\s*['"]\/['"]/.test(propSrc));
    assert('src: POST / handler on properties router',
      /router\.post\s*\(\s*['"]\/['"]/.test(propSrc));
    assert('src: GET /:id handler on properties router',
      /router\.get\s*\(\s*['"]\/:id['"]/.test(propSrc));

    // Account isolation — account_id never read from body
    assert('src: GET / uses req.accountId (not body)',
      /req\.accountId/.test(propSrc));
    assert('src: no req\.body\.account_id in POST',
      !/req\.body\.account_id/.test(propSrc));

    // Transaction usage in POST
    assert('src: POST uses prisma.$transaction',
      /\$transaction/.test(propSrc));

    // Both creates inside the transaction
    assert('src: tx.properties.create inside transaction',
      /tx\.properties\.create/.test(propSrc));
    assert('src: tx.turnover_checklists.create inside transaction',
      /tx\.turnover_checklists\.create/.test(propSrc));

    // GET / orderBy name asc
    assert('src: GET / orderBy name asc',
      /orderBy.*name.*asc/s.test(propSrc));

    // GET /:id includes turnover_checklists and property_cleaners
    assert('src: GET /:id includes turnover_checklists',
      /turnover_checklists/.test(propSrc));
    assert('src: GET /:id includes property_cleaners',
      /property_cleaners/.test(propSrc));

    // index.ts registration
    assert('src: index.ts imports propertiesRouter',
      /propertiesRouter/.test(idxSrc));
    assert('src: index.ts mounts propertiesRouter under /api/properties',
      /app\.use\(['"]\/api\/properties['"].*propertiesRouter\)/.test(idxSrc));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
