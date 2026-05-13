/**
 * T-033 verification — GET /api/messages + GET /api/bookings
 *
 * AC1  GET /api/messages?status=escalated,failed returns only those statuses for authenticated account.
 * AC2  GET /api/messages?booking_id=[id] returns all messages for that booking sorted sent_at ASC.
 * AC3  Response includes property.name; guest_first_name and guest_last_name are at the TOP LEVEL
 *      of each message object (not nested inside a booking sub-object).
 * AC4  GET /api/bookings returns bookings with checkin_message_sent, checkout_reminder_sent,
 *      and review_request_sent explicitly selected.
 * AC5  Both endpoints enforce account_id isolation (queries always filtered by JWT account).
 * AC6  Pagination (page, limit) works on both endpoints.
 *
 * Run: npx ts-node src/routes/t033.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t033';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import messagesRouter from './messages';
import bookingsRouter from './bookings';

// ── Minimal test app ──────────────────────────────────────────────────────────
const testApp = express();
testApp.use(express.json());
testApp.use('/api/messages', messagesRouter);
testApp.use('/api/bookings', bookingsRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const JWT_SECRET    = 'test-secret-t033';
const ACCOUNT_ID    = 'acc-t033-001';
const OTHER_ACCOUNT = 'acc-t033-OTHER';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

// Shape returned by prisma after the select — includes the booking relation
// so the route handler can destructure it.
function fakeMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                    'msg-001',
    account_id:            ACCOUNT_ID,
    property_id:           'prop-001',
    booking_id:            'booking-001',
    platform_message_id:   'plat-001',
    direction:             'inbound',
    channel:               'airbnb',
    sender:                'guest',
    content:               'The AC is broken',
    intent_classification: null,
    status:                'escalated',
    is_urgent:             false,
    escalation_reason:     null,
    maintenance_triggered: false,
    sent_at:               new Date('2026-01-10T10:00:00Z'),
    created_at:            new Date('2026-01-10T10:00:00Z'),
    property: { name: 'Beachfront Villa' },
    booking:  { guest_first_name: 'Alice', guest_last_name: 'Smith' },
    ...overrides,
  };
}

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id:                        'booking-001',
    account_id:                ACCOUNT_ID,
    property_id:               'prop-001',
    platform:                  'airbnb',
    platform_booking_id:       'airbnb-bk-001',
    guest_first_name:          'Bob',
    guest_last_name:           'Jones',
    guest_platform_id:         'guest-001',
    checkin_datetime:          new Date('2026-06-01T15:00:00Z'),
    checkout_datetime:         new Date('2026-06-07T11:00:00Z'),
    status:                    'active',
    checkin_message_sent:      true,
    checkin_message_sent_at:   new Date('2026-05-31T15:00:00Z'),
    checkout_reminder_sent:    false,
    checkout_reminder_sent_at: null,
    review_request_sent:       false,
    review_request_sent_at:    null,
    created_at:                new Date('2026-05-01T00:00:00Z'),
    property: { name: 'Beachfront Villa' },
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
  // AC5 — authentication guard (both endpoints)
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — GET /api/messages without token → 401');
  {
    const res = await request(testApp).get('/api/messages');
    assert('AC5a: 401 with no token on GET /api/messages', res.status === 401);
  }

  console.log('\nAC5b — GET /api/bookings without token → 401');
  {
    const res = await request(testApp).get('/api/bookings');
    assert('AC5b: 401 with no token on GET /api/bookings', res.status === 401);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC1 — GET /api/messages status filter
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1 — status=escalated,failed filters query correctly');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedWhere: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [
        fakeMessageRow({ status: 'escalated' }),
        fakeMessageRow({ id: 'msg-002', status: 'failed' }),
      ];
    };

    const res = await request(testApp)
      .get('/api/messages?status=escalated,failed')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    assert('AC1: response 200', res.status === 200);
    assert('AC1: where.account_id from JWT',
      capturedWhere?.account_id === ACCOUNT_ID);
    assert('AC1: where.status.in includes "escalated"',
      capturedWhere?.status?.in?.includes('escalated') === true);
    assert('AC1: where.status.in includes "failed"',
      capturedWhere?.status?.in?.includes('failed') === true);
    assert('AC1: data array has 2 messages',
      res.body.data?.length === 2);
    assert('AC1: returned statuses match filter',
      res.body.data?.every((m: any) => ['escalated', 'failed'].includes(m.status)));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — booking_id filter + sent_at ASC sort
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2 — booking_id filter applies; orderBy is sent_at ASC');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedArgs: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [
        fakeMessageRow({ sent_at: new Date('2026-01-10T08:00:00Z') }),
        fakeMessageRow({ id: 'msg-002', sent_at: new Date('2026-01-10T10:00:00Z') }),
      ];
    };

    const res = await request(testApp)
      .get('/api/messages?booking_id=booking-001')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    assert('AC2: response 200', res.status === 200);
    assert('AC2: where.booking_id = "booking-001"',
      (capturedArgs as any)?.where?.booking_id === 'booking-001');
    assert('AC2: orderBy sent_at asc',
      (capturedArgs as any)?.orderBy?.sent_at === 'asc');
    assert('AC2: data array has 2 messages', res.body.data?.length === 2);
  }

  console.log('\nAC2b — no booking_id → orderBy created_at DESC');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedArgs: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [];
    };

    await request(testApp)
      .get('/api/messages')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    assert('AC2b: orderBy created_at desc when no booking_id',
      (capturedArgs as any)?.orderBy?.created_at === 'desc');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — guest names promoted to top level; property.name present
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3 — guest_first_name and guest_last_name at top level of message');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedSelect: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedSelect = args.select ?? null;
      return [fakeMessageRow()];
    };

    const res = await request(testApp)
      .get('/api/messages')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    const msg = res.body.data?.[0];

    // Shape: uses select (not include)
    assert('AC3: query uses select (not include)',
      capturedSelect !== null);
    assert('AC3: select includes property',
      capturedSelect !== null && 'property' in capturedSelect);
    assert('AC3: select includes booking for name extraction',
      capturedSelect !== null && 'booking' in capturedSelect);

    // Top-level guest names
    assert('AC3: guest_first_name at top level = "Alice"',
      msg?.guest_first_name === 'Alice');
    assert('AC3: guest_last_name at top level = "Smith"',
      msg?.guest_last_name === 'Smith');

    // No nested booking sub-object in response
    assert('AC3: no nested booking sub-object in response',
      msg?.booking === undefined);

    // property.name present
    assert('AC3: property.name = "Beachfront Villa"',
      msg?.property?.name === 'Beachfront Villa');
  }

  console.log('\nAC3 edge — null booking relation → guest names null, no crash');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    (prisma.messages as any).findMany = async () => [
      fakeMessageRow({ booking: null }),
    ];

    const res = await request(testApp)
      .get('/api/messages')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    const msg = res.body.data?.[0];
    assert('AC3 edge: status 200', res.status === 200);
    assert('AC3 edge: guest_first_name is null', msg?.guest_first_name === null);
    assert('AC3 edge: guest_last_name is null',  msg?.guest_last_name  === null);
    assert('AC3 edge: no nested booking sub-object', msg?.booking === undefined);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — GET /api/bookings 3 send-status booleans explicitly selected
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4 — 3 message send-status booleans present in bookings response');
  {
    const restore = stubAuth();
    const orig = (prisma.bookings as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedSelect: any = null;
    (prisma.bookings as any).findMany = async (args: any) => {
      capturedSelect = args.select ?? null;
      return [fakeBooking()];
    };

    const res = await request(testApp)
      .get('/api/bookings')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings as any).findMany = orig;
    restore();

    const bk = res.body.data?.[0];

    // Explicit select in the query
    assert('AC4: query uses select (not rely on Prisma default)',
      capturedSelect !== null);
    assert('AC4: select.checkin_message_sent = true',
      capturedSelect?.checkin_message_sent === true);
    assert('AC4: select.checkout_reminder_sent = true',
      capturedSelect?.checkout_reminder_sent === true);
    assert('AC4: select.review_request_sent = true',
      capturedSelect?.review_request_sent === true);

    // Values present in response body
    assert('AC4: checkin_message_sent in response body',
      'checkin_message_sent' in (bk ?? {}));
    assert('AC4: checkout_reminder_sent in response body',
      'checkout_reminder_sent' in (bk ?? {}));
    assert('AC4: review_request_sent in response body',
      'review_request_sent' in (bk ?? {}));

    // Correct values
    assert('AC4: checkin_message_sent = true',   bk?.checkin_message_sent   === true);
    assert('AC4: checkout_reminder_sent = false', bk?.checkout_reminder_sent === false);
    assert('AC4: review_request_sent = false',    bk?.review_request_sent    === false);

    // property.name also present
    assert('AC4: property.name included', bk?.property?.name === 'Beachfront Villa');
  }

  console.log('\nAC4 all-sent — true values for all 3 flags pass through');
  {
    const restore = stubAuth();
    const orig = (prisma.bookings as any).findMany;

    (prisma.bookings as any).findMany = async () => [
      fakeBooking({
        checkin_message_sent:   true,
        checkout_reminder_sent: true,
        review_request_sent:    true,
      }),
    ];

    const res = await request(testApp)
      .get('/api/bookings')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings as any).findMany = orig;
    restore();

    const bk = res.body.data?.[0];
    assert('AC4 sent: checkin_message_sent = true',   bk?.checkin_message_sent   === true);
    assert('AC4 sent: checkout_reminder_sent = true', bk?.checkout_reminder_sent === true);
    assert('AC4 sent: review_request_sent = true',    bk?.review_request_sent    === true);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — account isolation (both endpoints use JWT account, never request body)
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5c — messages where.account_id always from JWT, not query string');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedWhere: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    // Attempt to inject a different account_id via query param — must be ignored
    await request(testApp)
      .get('/api/messages?account_id=injected-other-account')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.messages as any).findMany = orig;
    restore();

    assert('AC5c: messages where.account_id = JWT account',
      capturedWhere?.account_id === ACCOUNT_ID);
    assert('AC5c: injected account_id ignored',
      capturedWhere?.account_id !== 'injected-other-account');
  }

  console.log('\nAC5d — bookings where.account_id always from JWT, not query string');
  {
    const restore = stubAuth();
    const orig = (prisma.bookings as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedWhere: any = null;
    (prisma.bookings as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/bookings?account_id=injected-other-account')
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.bookings as any).findMany = orig;
    restore();

    assert('AC5d: bookings where.account_id = JWT account',
      capturedWhere?.account_id === ACCOUNT_ID);
    assert('AC5d: injected account_id ignored',
      capturedWhere?.account_id !== 'injected-other-account');
  }

  console.log('\nAC5e — different JWT account → different account_id in query');
  {
    const restore = stubAuth();
    const orig = (prisma.bookings as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedWhere: any = null;
    (prisma.bookings as any).findMany = async (args: any) => {
      capturedWhere = args.where;
      return [];
    };

    await request(testApp)
      .get('/api/bookings')
      .set('Authorization', `Bearer ${makeToken(OTHER_ACCOUNT)}`);

    (prisma.bookings as any).findMany = orig;
    restore();

    assert('AC5e: where.account_id = OTHER_ACCOUNT from JWT',
      capturedWhere?.account_id === OTHER_ACCOUNT);
    assert('AC5e: not equal to ACCOUNT_ID',
      capturedWhere?.account_id !== ACCOUNT_ID);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — pagination (both endpoints)
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6 — pagination on GET /api/messages');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedArgs: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [];
    };

    const res = await request(testApp)
      .get('/api/messages?page=3&limit=10')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    assert('AC6 messages: skip = (3-1)*10 = 20', (capturedArgs as any)?.skip === 20);
    assert('AC6 messages: take = 10',              (capturedArgs as any)?.take === 10);
    assert('AC6 messages: response page = 3',      res.body?.page  === 3);
    assert('AC6 messages: response limit = 10',    res.body?.limit === 10);
  }

  console.log('\nAC6b — pagination on GET /api/bookings');
  {
    const restore = stubAuth();
    const orig = (prisma.bookings as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedArgs: any = null;
    (prisma.bookings as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [];
    };

    const res = await request(testApp)
      .get('/api/bookings?page=2&limit=25')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings as any).findMany = orig;
    restore();

    assert('AC6b bookings: skip = (2-1)*25 = 25', (capturedArgs as any)?.skip === 25);
    assert('AC6b bookings: take = 25',              (capturedArgs as any)?.take === 25);
    assert('AC6b bookings: response page = 2',      res.body?.page  === 2);
    assert('AC6b bookings: response limit = 25',    res.body?.limit === 25);
  }

  console.log('\nAC6c — default pagination (no params): page=1, limit=50');
  {
    const restore = stubAuth();
    const orig = (prisma.messages as any).findMany;

    // eslint-disable-next-line prefer-const
    let capturedArgs: any = null;
    (prisma.messages as any).findMany = async (args: any) => {
      capturedArgs = args;
      return [];
    };

    const res = await request(testApp)
      .get('/api/messages')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.messages as any).findMany = orig;
    restore();

    assert('AC6c: default skip = 0',   (capturedArgs as any)?.skip === 0);
    assert('AC6c: default take = 50',  (capturedArgs as any)?.take === 50);
    assert('AC6c: response page = 1',  res.body?.page  === 1);
    assert('AC6c: response limit = 50', res.body?.limit === 50);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source-level checks
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — verify implementation details in routes');
  {
    const msgSrc = fs.readFileSync(path.join(__dirname, 'messages.ts'), 'utf8');
    const bkSrc  = fs.readFileSync(path.join(__dirname, 'bookings.ts'), 'utf8');
    const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

    // GET /api/messages
    assert('src: GET / handler on messages router',
      /router\.get\s*\(\s*['"]\/['"]/.test(msgSrc));
    assert('src: messages uses select (not include) for GET',
      /select:/.test(msgSrc));
    assert('src: messages select includes guest_first_name',
      /guest_first_name/.test(msgSrc));
    assert('src: messages select includes guest_last_name',
      /guest_last_name/.test(msgSrc));
    assert('src: messages promotes guest names to top level (destructures booking)',
      /const\s*\{[^}]*booking[^}]*\}/.test(msgSrc) ||
      /\(\s*\{\s*booking/.test(msgSrc));
    assert('src: messages sent_at asc when booking_id present',
      /sent_at.*asc/i.test(msgSrc));
    assert('src: messages created_at desc default',
      /created_at.*desc/i.test(msgSrc));

    // GET /api/bookings
    assert('src: GET / handler on bookings router',
      /router\.get\s*\(\s*['"]\/['"]/.test(bkSrc));
    assert('src: bookings uses explicit select',
      /select:/.test(bkSrc));
    assert('src: bookings select.checkin_message_sent = true',
      /checkin_message_sent\s*:\s*true/.test(bkSrc));
    assert('src: bookings select.checkout_reminder_sent = true',
      /checkout_reminder_sent\s*:\s*true/.test(bkSrc));
    assert('src: bookings select.review_request_sent = true',
      /review_request_sent\s*:\s*true/.test(bkSrc));

    // index.ts registration
    assert('src: index.ts mounts bookingsRouter under /api/bookings',
      /app\.use\(['"]\/api\/bookings['"],\s*bookingsRouter\)/.test(idxSrc));
    assert('src: index.ts applies apiLimiter to /api routes',
      /app\.use\(['"]\/api['"],\s*apiLimiter\)/.test(idxSrc));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
