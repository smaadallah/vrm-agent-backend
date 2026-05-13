/**
 * Verification script for T-017: Account Isolation Middleware
 *
 * AC1  src/middleware/accountIsolation.ts exists; TypeScript compiles
 * AC2  req.accountId not set → 401 {"error":"Unauthorized"}
 * AC3  req.accountId set, no account param in route → passes (200)
 * AC4  :accountId param matches req.accountId → passes (200)
 * AC5  :accountId param does NOT match req.accountId → 403 {"error":"Forbidden"}
 * AC6  :account_id param does NOT match req.accountId → 403 {"error":"Forbidden"}
 * AC7  Middleware is synchronous (no DB dependency)
 *
 * Run with: npx ts-node src/lib/t017.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import express, { Request, Response } from 'express';
import request from 'supertest';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

const backendRoot = path.join(__dirname, '..', '..');
const ACCOUNT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCOUNT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── AC1: source inspection ────────────────────────────────────────────────────
console.log('\nAC1 — accountIsolation.ts exists and compiles');
{
  const filePath = path.join(backendRoot, 'src', 'middleware', 'accountIsolation.ts');
  assert('src/middleware/accountIsolation.ts exists', fs.existsSync(filePath));

  const src = fs.readFileSync(filePath, 'utf8');
  assert('accountIsolationMiddleware exported', /export.*accountIsolationMiddleware/.test(src));
  assert('returns 401 when accountId missing', /401/.test(src));
  assert('returns 403 on mismatch', /403/.test(src));
  assert('checks req.accountId', /req\.accountId/.test(src));
  assert('checks route param accountId or account_id',
    /req\.params/.test(src) && /accountId|account_id/.test(src));
  assert('synchronous — no async keyword', !/async\s+function\s+accountIsolationMiddleware/.test(src));
  assert('no DB / prisma import', !/prisma|PrismaClient/.test(src));
}

// ── Helper: inject req.accountId via a stub middleware ────────────────────────
function withAccount(id: string | undefined) {
  return (req: Request, _res: Response, next: express.NextFunction): void => {
    if (id !== undefined) req.accountId = id;
    next();
  };
}

// ── AC2: req.accountId not set → 401 ─────────────────────────────────────────
console.log('\nAC2 — req.accountId not set → 401');
(async () => {
  const app = express();
  app.get('/test', withAccount(undefined), accountIsolationMiddleware, (_req, res) => {
    res.json({ ok: true });
  });

  const r = await request(app).get('/test');
  assert('no accountId → 401', r.status === 401);
  assert('no accountId → {"error":"Unauthorized"}', r.body?.error === 'Unauthorized');

  // ── AC3: req.accountId set, no route param → passes ──────────────────────────
  console.log('\nAC3 — req.accountId set, no account param → passes (200)');
  {
    const app2 = express();
    app2.get('/test', withAccount(ACCOUNT_A), accountIsolationMiddleware, (_req, res) => {
      res.json({ ok: true });
    });

    const r2 = await request(app2).get('/test');
    assert('accountId set, no param → 200', r2.status === 200);
    assert('response body is { ok: true }', r2.body?.ok === true);
  }

  // ── AC4: :accountId param matches req.accountId → passes ─────────────────────
  console.log('\nAC4 — :accountId param matches req.accountId → passes (200)');
  {
    const app3 = express();
    app3.get('/accounts/:accountId/resources',
      withAccount(ACCOUNT_A),
      accountIsolationMiddleware,
      (_req, res) => { res.json({ ok: true }); },
    );

    const r3 = await request(app3).get(`/accounts/${ACCOUNT_A}/resources`);
    assert(':accountId matches → 200', r3.status === 200);
  }

  // ── AC5: :accountId param does NOT match → 403 ───────────────────────────────
  console.log('\nAC5 — :accountId param mismatches req.accountId → 403');
  {
    const app4 = express();
    app4.get('/accounts/:accountId/resources',
      withAccount(ACCOUNT_A),
      accountIsolationMiddleware,
      (_req, res) => { res.json({ ok: true }); },
    );

    const r4 = await request(app4).get(`/accounts/${ACCOUNT_B}/resources`);
    assert(':accountId mismatch → 403', r4.status === 403);
    assert(':accountId mismatch → {"error":"Forbidden"}', r4.body?.error === 'Forbidden');
  }

  // ── AC6: :account_id param does NOT match → 403 ──────────────────────────────
  console.log('\nAC6 — :account_id param mismatches req.accountId → 403');
  {
    const app5 = express();
    app5.get('/resources/:account_id',
      withAccount(ACCOUNT_A),
      accountIsolationMiddleware,
      (_req, res) => { res.json({ ok: true }); },
    );

    const r5a = await request(app5).get(`/resources/${ACCOUNT_B}`);
    assert(':account_id mismatch → 403', r5a.status === 403);
    assert(':account_id mismatch → {"error":"Forbidden"}', r5a.body?.error === 'Forbidden');

    const r5b = await request(app5).get(`/resources/${ACCOUNT_A}`);
    assert(':account_id match → 200', r5b.status === 200);
  }

  // ── AC7: no DB calls — verified by source inspection above ───────────────────
  console.log('\nAC7 — No DB dependency (synchronous, no prisma import)');
  {
    assert('middleware has no prisma dependency (verified in AC1)', true);
    assert('middleware is synchronous (verified in AC1)', true);
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
