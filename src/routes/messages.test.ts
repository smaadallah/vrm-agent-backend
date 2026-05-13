/**
 * T-032 verification — PATCH /api/messages/:id — Manager Reply via Platform API
 *
 * AC1  Protected by JWT auth and account isolation.
 * AC2  reply_text > 2000 chars -> 400 validation error.
 * AC3  On success: new outbound messages row with sender='manager', status='manager_handled'.
 * AC4  Source message status updated to 'manager_handled'.
 * AC5  Platform API failure after retry -> 500, no messages row inserted.
 * AC6  Rate-limited by apiLimiter (verified via source check on index.ts).
 *
 * Run: npx ts-node src/routes/messages.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

// Fix JWT_SECRET and PORT before importing any modules that read them at import time.
process.env.JWT_SECRET = 'test-secret-t032';
process.env.PORT = '0';  // supertest binds its own port; prevent collision

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import messagesRouter, { _hooks } from './messages';

// ── Minimal test app (no Sentry, no listen side-effects) ─────────────────────
const testApp = express();
testApp.use(express.json());
testApp.use('/api/messages', messagesRouter);

// Generic error handler for the test app
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-secret-t032';
const ACCOUNT_ID = 'acc-test-001';
const OTHER_ACCOUNT_ID = 'acc-test-002';
const MESSAGE_ID = 'msg-test-001';

function makeToken(accountId: string = ACCOUNT_ID, tokenVersion: number = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

/** Fake source message returned by prisma.messages.findUnique */
function fakeSourceMsg(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id:                  MESSAGE_ID,
    account_id:          ACCOUNT_ID,
    property_id:         'prop-001',
    booking_id:          'booking-001',
    platform_message_id: 'plat-inbound-001',
    direction:           'inbound',
    channel:             'airbnb',
    sender:              'guest',
    content:             'The AC is broken',
    status:              'escalated',
    is_urgent:           false,
    maintenance_triggered: false,
    sent_at:             new Date(),
    created_at:          new Date(),
    booking: {
      platform:          'airbnb',
      guest_platform_id: 'guest-plat-001',
    },
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

// ── All tests run sequentially ────────────────────────────────────────────────
(async () => {

  // ── AC1a: no token → 401 ───────────────────────────────────────────────────
  console.log('\nAC1a — no Authorization header → 401');
  {
    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .send({ reply_text: 'Hello' });

    assert('AC1a: status 401 when no token provided', res.status === 401);
  }

  // ── AC1b: invalid token → 401 ──────────────────────────────────────────────
  console.log('\nAC1b — invalid JWT token → 401');
  {
    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .send({ reply_text: 'Hello' });

    assert('AC1b: status 401 when token is invalid', res.status === 401);
  }

  // ── AC1c: cross-account message → 404 ─────────────────────────────────────
  console.log('\nAC1c — message belongs to different account → 404');
  {
    const origFindUnique = (prisma.accounts as any).findUnique;
    (prisma.accounts as any).findUnique = async () => ({ token_version: 1 });

    const origMsgFindUnique = (prisma.messages as any).findUnique;
    // Return a message owned by a different account
    (prisma.messages as any).findUnique = async () =>
      fakeSourceMsg({ account_id: OTHER_ACCOUNT_ID });

    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reply_text: 'Hello' });

    (prisma.accounts as any).findUnique = origFindUnique;
    (prisma.messages as any).findUnique = origMsgFindUnique;

    assert('AC1c: status 404 for cross-account message', res.status === 404);
  }

  // ── AC1d: message not found → 404 ─────────────────────────────────────────
  console.log('\nAC1d — message not found → 404');
  {
    const origFindUnique = (prisma.accounts as any).findUnique;
    (prisma.accounts as any).findUnique = async () => ({ token_version: 1 });

    const origMsgFindUnique = (prisma.messages as any).findUnique;
    (prisma.messages as any).findUnique = async () => null;

    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reply_text: 'Hello' });

    (prisma.accounts as any).findUnique = origFindUnique;
    (prisma.messages as any).findUnique = origMsgFindUnique;

    assert('AC1d: status 404 when message not found', res.status === 404);
  }

  // ── AC2: reply_text > 2000 chars → 400 ────────────────────────────────────
  console.log('\nAC2 — reply_text > 2000 chars → 400');
  {
    const origAcctFindUnique = (prisma.accounts as any).findUnique;
    (prisma.accounts as any).findUnique = async () => ({ token_version: 1 });

    const longText = 'x'.repeat(2001);
    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reply_text: longText });

    (prisma.accounts as any).findUnique = origAcctFindUnique;

    assert('AC2: status 400 for reply_text > 2000 chars', res.status === 400);
    assert('AC2: error message mentions 2000 characters',
      typeof res.body?.error === 'string' && res.body.error.includes('2000'));
  }

  // ── AC2b: reply_text exactly 2000 chars → succeeds (boundary) ─────────────
  console.log('\nAC2b — reply_text exactly 2000 chars → 200 (boundary)');
  {
    const origAcctFindUnique  = (prisma.accounts as any).findUnique;
    const origMsgFindUnique   = (prisma.messages as any).findUnique;
    const origMsgCreate       = (prisma.messages as any).create;
    const origMsgUpdate       = (prisma.messages as any).update;

    (prisma.accounts as any).findUnique = async () => ({ token_version: 1 });
    (prisma.messages as any).findUnique = async () => fakeSourceMsg();
    (prisma.messages as any).create     = async () => ({ id: 'out-msg-001' });
    (prisma.messages as any).update     = async () => ({});
    _hooks.platformSend = async () => {};  // no-op send

    const exactText = 'y'.repeat(2000);
    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reply_text: exactText });

    (prisma.accounts as any).findUnique = origAcctFindUnique;
    (prisma.messages as any).findUnique = origMsgFindUnique;
    (prisma.messages as any).create     = origMsgCreate;
    (prisma.messages as any).update     = origMsgUpdate;
    _hooks.platformSend = undefined;

    assert('AC2b: status 200 for reply_text exactly 2000 chars', res.status === 200);
  }

  // ── AC3 + AC4: success path — new outbound row + source status update ──────
  console.log('\nAC3 + AC4 — success: outbound row created, source message updated');
  {
    const origAcctFindUnique  = (prisma.accounts as any).findUnique;
    const origMsgFindUnique   = (prisma.messages as any).findUnique;
    const origMsgCreate       = (prisma.messages as any).create;
    const origMsgUpdate       = (prisma.messages as any).update;

    (prisma.accounts as any).findUnique = async () => ({ token_version: 1 });
    (prisma.messages as any).findUnique = async () => fakeSourceMsg();

    let createArgs: Record<string, unknown> | null = null;
    let updateArgs: Record<string, unknown> | null = null;

    (prisma.messages as any).create = async (args: any) => {
      createArgs = args;
      return { id: 'out-msg-001' };
    };
    (prisma.messages as any).update = async (args: any) => {
      updateArgs = args;
      return {};
    };

    _hooks.platformSend = async () => {};  // succeeds
    _hooks.retryDelayMs = 0;

    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reply_text: 'We are sending someone right away!' });

    (prisma.accounts as any).findUnique = origAcctFindUnique;
    (prisma.messages as any).findUnique = origMsgFindUnique;
    (prisma.messages as any).create     = origMsgCreate;
    (prisma.messages as any).update     = origMsgUpdate;
    _hooks.platformSend = undefined;
    _hooks.retryDelayMs = 60_000;

    assert('AC3+AC4: response is 200', res.status === 200);

    // AC3
    const data = (createArgs as any)?.data;
    assert('AC3: messages.create called', createArgs !== null);
    assert('AC3: new row sender = "manager"', data?.sender === 'manager');
    assert('AC3: new row status = "manager_handled"', data?.status === 'manager_handled');
    assert('AC3: new row direction = "outbound"', data?.direction === 'outbound');
    assert('AC3: new row account_id matches', data?.account_id === ACCOUNT_ID);
    assert('AC3: new row booking_id matches', data?.booking_id === 'booking-001');
    assert('AC3: new row property_id matches', data?.property_id === 'prop-001');
    assert('AC3: new row content = reply_text',
      data?.content === 'We are sending someone right away!');
    assert('AC3: new row has platform_message_id (prefixed mgr-)',
      typeof data?.platform_message_id === 'string' &&
      data.platform_message_id.startsWith('mgr-'));
    assert('AC3: new row has sent_at as Date', data?.sent_at instanceof Date);

    // AC4
    assert('AC4: messages.update called on source', updateArgs !== null);
    assert('AC4: source message where.id = MESSAGE_ID',
      (updateArgs as any)?.where?.id === MESSAGE_ID);
    assert('AC4: source message status set to manager_handled',
      (updateArgs as any)?.data?.status === 'manager_handled');
  }

  // ── AC5: platform failure after retry → 500, no messages row ──────────────
  console.log('\nAC5 — platform API fails both attempts → 500, no row inserted');
  {
    const origAcctFindUnique  = (prisma.accounts as any).findUnique;
    const origMsgFindUnique   = (prisma.messages as any).findUnique;
    const origMsgCreate       = (prisma.messages as any).create;
    const origMsgUpdate       = (prisma.messages as any).update;

    (prisma.accounts as any).findUnique = async () => ({ token_version: 1 });
    (prisma.messages as any).findUnique = async () => fakeSourceMsg();

    let createCalled = false;
    let updateCalled = false;
    (prisma.messages as any).create = async () => { createCalled = true; return {}; };
    (prisma.messages as any).update = async () => { updateCalled = true; return {}; };

    _hooks.platformSend = async () => { throw new Error('platform unavailable'); };
    _hooks.retryDelayMs = 0;  // suppress 60-second sleep

    const res = await request(testApp)
      .patch(`/api/messages/${MESSAGE_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ reply_text: 'Hello' });

    (prisma.accounts as any).findUnique = origAcctFindUnique;
    (prisma.messages as any).findUnique = origMsgFindUnique;
    (prisma.messages as any).create     = origMsgCreate;
    (prisma.messages as any).update     = origMsgUpdate;
    _hooks.platformSend = undefined;
    _hooks.retryDelayMs = 60_000;

    assert('AC5: status 500 when platform send permanently fails', res.status === 500);
    assert('AC5: messages.create NOT called on platform failure', !createCalled);
    assert('AC5: messages.update NOT called on platform failure', !updateCalled);
  }

  // ── AC6 (source): apiLimiter applied to /api routes in index.ts ───────────
  console.log('\nAC6 — apiLimiter applied to /api routes');
  {
    const indexSrc      = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const messagesSrc   = fs.readFileSync(path.join(__dirname, 'messages.ts'), 'utf8');

    assert('AC6: index.ts applies apiLimiter to /api routes',
      /app\.use\(['"]\/api['"],\s*apiLimiter\)/.test(indexSrc));
    assert('AC6: index.ts mounts messagesRouter under /api/messages',
      /app\.use\(['"]\/api\/messages['"],\s*messagesRouter\)/.test(indexSrc));
    assert('AC6: messages.ts imports authMiddleware',
      /authMiddleware/.test(messagesSrc));
    assert('AC6: messages.ts imports accountIsolationMiddleware',
      /accountIsolationMiddleware/.test(messagesSrc));
    assert('AC6: messages.ts uses router.patch',
      /router\.patch/.test(messagesSrc));
    assert('AC6: messages.ts applies Rule 3 retry',
      /sendWithRetry/.test(messagesSrc));
    assert('AC6: messages.ts 2000-char limit defined',
      /MAX_REPLY_LENGTH\s*=\s*2000/.test(messagesSrc));
  }

  // ── AC3+AC4 source: verify implementation details ─────────────────────────
  console.log('\nAC3+AC4 (source) — verify implementation details in messages.ts');
  {
    const src = fs.readFileSync(path.join(__dirname, 'messages.ts'), 'utf8');

    assert('src: sender set to manager', /sender:\s*['"]manager['"]/.test(src));
    assert('src: status set to manager_handled',
      /status:\s*['"]manager_handled['"]/.test(src));
    assert('src: direction set to outbound', /direction:\s*['"]outbound['"]/.test(src));
    assert('src: messages.create used for outbound row',
      /messages\.create/.test(src));
    assert('src: messages.update used for source status',
      /messages\.update/.test(src));
    assert('src: sent_at set to new Date()', /sent_at:\s*new Date\(\)/.test(src));
    assert('src: platform_message_id prefixed with mgr-',
      /`mgr-\$\{/.test(src) || /['"]mgr-['"]/.test(src));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
