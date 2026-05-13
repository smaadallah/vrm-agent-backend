/**
 * Verification script for T-016: JWT Auth Middleware + token_version Revocation Check
 *
 * AC1  src/middleware/auth.ts exists; TypeScript compiles (npx tsc --noEmit)
 * AC2  Missing / malformed Authorization header → 401 {"error":"Unauthorized"}
 * AC3  Invalid JWT (bad signature / tampered) → 401
 * AC4  Expired JWT → 401
 * AC5  Valid JWT with correct token_version → next() called, req.accountId set
 * AC6  Valid JWT with stale token_version → 401 (revoked)
 *
 * Run with: npx ts-node src/lib/t016.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { authMiddleware } from '../middleware/auth';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

const backendRoot = path.join(__dirname, '..', '..');
const JWT_SECRET = process.env.JWT_SECRET!;

// Minimal Express app for testing the middleware
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/protected', authMiddleware, (req, res) => {
    res.json({ accountId: (req as any).accountId });
  });
  return app;
}

// ── AC1: file exists, TypeScript compiles ────────────────────────────────────
console.log('\nAC1 — auth.ts exists and TypeScript compiles');
{
  const authPath = path.join(backendRoot, 'src', 'middleware', 'auth.ts');
  assert('src/middleware/auth.ts exists', fs.existsSync(authPath));

  const src = fs.readFileSync(authPath, 'utf8');
  assert('authMiddleware exported', /export.*authMiddleware/.test(src));
  assert('jwt.verify used', /jwt\.verify\(/.test(src));
  assert('token_version checked against DB', /token_version/.test(src));
  assert('401 Unauthorized returned on failure', /401/.test(src) && /Unauthorized/.test(src));
  assert('req.accountId set on success', /req\.accountId/.test(src));
  assert('JWT_SECRET read from env', /JWT_SECRET/.test(src));
  assert('types/express.d.ts exists',
    fs.existsSync(path.join(backendRoot, 'src', 'types', 'express.d.ts')));
}

// ── Runtime tests (AC2–AC6) ───────────────────────────────────────────────────
(async () => {
  const app = makeApp();

  // Seed a test account directly via pg (bypasses Prisma encryption middleware)
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();

  const seedRes = await pgClient.query(`
    INSERT INTO accounts (id, business_name, manager_phone, manager_email,
      alert_channel, communication_tone, password_hash, token_version)
    VALUES (gen_random_uuid()::text, 'Auth Test Co', '+15550010016',
      'auth@t016.test', 'sms', 'casual', 'hash', 1)
    RETURNING id, token_version
  `);
  const { id: accountId, token_version: tokenVersion } = seedRes.rows[0];

  try {
    // ── AC2: no / malformed Authorization header ──────────────────────────────
    console.log('\nAC2 — Missing or malformed Authorization header → 401');
    {
      const r1 = await request(app).get('/protected');
      assert('no header → 401', r1.status === 401);
      assert('no header → {"error":"Unauthorized"}', r1.body?.error === 'Unauthorized');

      const r2 = await request(app).get('/protected').set('Authorization', 'Basic abc123');
      assert('non-Bearer scheme → 401', r2.status === 401);

      const r3 = await request(app).get('/protected').set('Authorization', 'Bearer');
      assert('bare "Bearer" (no token) → 401', r3.status === 401);
    }

    // ── AC3: invalid JWT signature ────────────────────────────────────────────
    console.log('\nAC3 — Invalid JWT signature → 401');
    {
      const badToken = jwt.sign({ accountId, tokenVersion }, 'wrong-secret');
      const r = await request(app).get('/protected').set('Authorization', `Bearer ${badToken}`);
      assert('bad signature → 401', r.status === 401);
      assert('bad signature → {"error":"Unauthorized"}', r.body?.error === 'Unauthorized');

      const r2 = await request(app).get('/protected').set('Authorization', 'Bearer not.a.jwt');
      assert('malformed token → 401', r2.status === 401);
    }

    // ── AC4: expired JWT ──────────────────────────────────────────────────────
    console.log('\nAC4 — Expired JWT → 401');
    {
      const expiredToken = jwt.sign(
        { accountId, tokenVersion },
        JWT_SECRET,
        { expiresIn: -1 }, // already expired
      );
      const r = await request(app).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
      assert('expired token → 401', r.status === 401);
      assert('expired token → {"error":"Unauthorized"}', r.body?.error === 'Unauthorized');
    }

    // ── AC5: valid JWT + correct token_version → passes ───────────────────────
    console.log('\nAC5 — Valid JWT with correct token_version → 200, req.accountId set');
    {
      const validToken = jwt.sign({ accountId, tokenVersion: Number(tokenVersion) }, JWT_SECRET);
      const r = await request(app).get('/protected').set('Authorization', `Bearer ${validToken}`);
      assert('valid token → 200', r.status === 200);
      assert('req.accountId equals seeded account id', r.body?.accountId === accountId);
    }

    // ── AC6: valid JWT but stale token_version → 401 (revoked) ───────────────
    console.log('\nAC6 — Valid JWT with stale token_version → 401 (revoked)');
    {
      // Bump token_version in DB to simulate password change / logout-all
      await pgClient.query(
        `UPDATE accounts SET token_version = token_version + 1 WHERE id = $1`,
        [accountId],
      );

      // Old token still has tokenVersion = 1, DB now has 2 → revoked
      const staleToken = jwt.sign({ accountId, tokenVersion: Number(tokenVersion) }, JWT_SECRET);
      const r = await request(app).get('/protected').set('Authorization', `Bearer ${staleToken}`);
      assert('stale token_version → 401', r.status === 401);
      assert('stale token_version → {"error":"Unauthorized"}', r.body?.error === 'Unauthorized');

      // Fresh token with updated tokenVersion should still pass
      const freshToken = jwt.sign(
        { accountId, tokenVersion: Number(tokenVersion) + 1 },
        JWT_SECRET,
      );
      const r2 = await request(app).get('/protected').set('Authorization', `Bearer ${freshToken}`);
      assert('fresh token after bump → 200', r2.status === 200);
    }

  } finally {
    await pgClient.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    await pgClient.end();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
