/**
 * Verification script for T-019: POST /auth/login + POST /auth/logout
 *
 * AC1  POST /auth/login with valid credentials → 200 { token }
 * AC2  JWT in login response contains correct accountId + tokenVersion claims
 * AC3  POST /auth/login with wrong password → 401 { error: "Invalid credentials" }
 * AC4  POST /auth/login with unknown email → 401 (same message, no user enumeration)
 * AC5  POST /auth/login with missing fields → 400
 * AC6  POST /auth/logout with valid token → 204, token_version incremented in DB
 * AC7  Using the pre-logout token after logout → 401 (revoked)
 * AC8  POST /auth/logout without auth header → 401
 * AC9  Routes registered under /auth in index.ts; authLimiter applied
 *
 * Run with: npx ts-node src/lib/t019.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;

import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import authRouter from '../routes/auth';
import { authMiddleware } from '../middleware/auth';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

const backendRoot = path.join(__dirname, '..', '..');
const JWT_SECRET = process.env.JWT_SECRET!;
const TEST_PASSWORD = 'TestP@ss!019';

// Minimal app that mirrors index.ts auth setup
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  // Protected probe route to verify token revocation (AC7)
  app.get('/probe', authMiddleware, (_req, res) => res.json({ ok: true }));
  return app;
}

(async () => {
  const app = makeApp();
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();

  // Seed test account with a known bcrypt password hash
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const seedRes = await pgClient.query(`
    INSERT INTO accounts (id, business_name, manager_phone, manager_email,
      alert_channel, communication_tone, password_hash, token_version)
    VALUES (gen_random_uuid()::text, 'Login Test Co', '+15550010019',
      'login@t019.test', 'sms', 'casual', $1, 1)
    RETURNING id, token_version
  `, [passwordHash]);
  const { id: accountId, token_version: tokenVersion } = seedRes.rows[0];

  try {
    // ── AC1: valid login → 200 + token ───────────────────────────────────────
    console.log('\nAC1 — Valid login → 200 { token }');
    let loginToken = '';
    {
      const r = await request(app)
        .post('/auth/login')
        .send({ email: 'login@t019.test', password: TEST_PASSWORD });
      assert('valid credentials → 200', r.status === 200);
      assert('response has token field', typeof r.body?.token === 'string' && r.body.token.length > 0);
      loginToken = r.body?.token ?? '';
    }

    // ── AC2: JWT claims are correct ───────────────────────────────────────────
    console.log('\nAC2 — JWT contains correct accountId + tokenVersion claims');
    {
      const payload = jwt.verify(loginToken, JWT_SECRET) as Record<string, unknown>;
      assert('JWT accountId matches seeded account', payload.accountId === accountId);
      assert('JWT tokenVersion matches DB token_version', payload.tokenVersion === Number(tokenVersion));
      assert('JWT has expiry (iat + exp present)', typeof payload.exp === 'number');
    }

    // ── AC3: wrong password → 401 ─────────────────────────────────────────────
    console.log('\nAC3 — Wrong password → 401 { error: "Invalid credentials" }');
    {
      const r = await request(app)
        .post('/auth/login')
        .send({ email: 'login@t019.test', password: 'WrongPassword!' });
      assert('wrong password → 401', r.status === 401);
      assert('wrong password → correct error message', r.body?.error === 'Invalid credentials');
    }

    // ── AC4: unknown email → 401 (same message — no enumeration) ─────────────
    console.log('\nAC4 — Unknown email → 401 (same message, no user enumeration)');
    {
      const r = await request(app)
        .post('/auth/login')
        .send({ email: 'nobody@nowhere.test', password: TEST_PASSWORD });
      assert('unknown email → 401', r.status === 401);
      assert('unknown email → same "Invalid credentials" message', r.body?.error === 'Invalid credentials');
    }

    // ── AC5: missing fields → 400 ─────────────────────────────────────────────
    console.log('\nAC5 — Missing fields → 400');
    {
      const r1 = await request(app).post('/auth/login').send({ email: 'login@t019.test' });
      assert('missing password → 400', r1.status === 400);

      const r2 = await request(app).post('/auth/login').send({ password: TEST_PASSWORD });
      assert('missing email → 400', r2.status === 400);

      const r3 = await request(app).post('/auth/login').send({});
      assert('empty body → 400', r3.status === 400);
    }

    // ── AC6: logout → 204, token_version incremented ─────────────────────────
    console.log('\nAC6 — Valid logout → 204, token_version incremented in DB');
    {
      const r = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${loginToken}`);
      assert('logout → 204', r.status === 204);

      const dbRes = await pgClient.query(
        `SELECT token_version FROM accounts WHERE id = $1`, [accountId],
      );
      const newVersion = Number(dbRes.rows[0].token_version);
      assert('token_version incremented in DB',
        newVersion === Number(tokenVersion) + 1);
    }

    // ── AC7: old token after logout → 401 ────────────────────────────────────
    console.log('\nAC7 — Pre-logout token rejected after logout (revoked)');
    {
      const r = await request(app)
        .get('/probe')
        .set('Authorization', `Bearer ${loginToken}`);
      assert('old token after logout → 401', r.status === 401);
    }

    // ── AC8: logout without auth header → 401 ────────────────────────────────
    console.log('\nAC8 — Logout without Authorization header → 401');
    {
      const r = await request(app).post('/auth/logout');
      assert('no auth header on logout → 401', r.status === 401);
    }

    // ── AC9: routes registered in index.ts; authLimiter applied ──────────────
    console.log('\nAC9 — Routes registered in index.ts; authLimiter wired to /auth');
    {
      const indexSrc = fs.readFileSync(
        path.join(backendRoot, 'src', 'index.ts'), 'utf8',
      );
      assert('authRouter imported in index.ts', /authRouter/.test(indexSrc));
      assert('authRouter mounted at /auth', /app\.use\(['"]\/auth['"].*authRouter\)/.test(indexSrc));
      assert('authLimiter applied to /auth before authRouter',
        indexSrc.indexOf('authLimiter') < indexSrc.indexOf('authRouter'));

      const authSrc = fs.readFileSync(
        path.join(backendRoot, 'src', 'routes', 'auth.ts'), 'utf8',
      );
      assert('login route defined', /router\.post\(['"]\/login/.test(authSrc));
      assert('logout route defined', /router\.post\(['"]\/logout/.test(authSrc));
      assert('logout uses authMiddleware', /authMiddleware/.test(authSrc));
      assert('bcrypt.compare used', /bcrypt\.compare/.test(authSrc));
      assert('jwt.sign used', /jwt\.sign/.test(authSrc));
      assert('token_version incremented on logout',
        /token_version.*increment|increment.*token_version/.test(authSrc));
      assert('dummy hash prevents timing enumeration', /DUMMY_HASH/.test(authSrc));
    }

  } finally {
    await pgClient.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    await pgClient.end();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
