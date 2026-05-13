/**
 * Verification script for T-021: POST /auth/reset-password
 *
 * AC1  POST with valid token + newPassword → 200 success message
 * AC2  password_hash in DB updated (new password verifies with bcrypt)
 * AC3  Old password no longer valid after reset
 * AC4  token_version incremented (all existing JWTs revoked)
 * AC5  password_reset_token and password_reset_expires_at cleared in DB
 * AC6  Token is single-use: using it a second time → 400
 * AC7  Expired token → 400 "Invalid or expired reset token"
 * AC8  Invalid (unknown) token → 400
 * AC9  Missing fields → 400
 *
 * Run with: npx ts-node src/lib/t021.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;

import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
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

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.get('/probe', authMiddleware, (_req, res) => res.json({ ok: true }));
  return app;
}

/** Write a reset token directly into the DB for a given account. */
async function seedResetToken(
  pgClient: Client,
  accountId: string,
  rawToken: string,
  expiresInMs: number,
): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pgClient.query(
    `UPDATE accounts
     SET password_reset_token = $1,
         password_reset_expires_at = NOW() + ($2 || ' milliseconds')::interval
     WHERE id = $3`,
    [tokenHash, expiresInMs.toString(), accountId],
  );
}

// ── Source inspection ─────────────────────────────────────────────────────────
console.log('\nSource — reset-password route inspection');
{
  const src = fs.readFileSync(
    path.join(backendRoot, 'src', 'routes', 'auth.ts'), 'utf8',
  );
  assert('reset-password route defined',
    /router\.post\(['"]\/reset-password/.test(src));
  assert('SHA-256 hash used to look up token',
    /createHash\(['"]sha256['"]/.test(src));
  assert('expiry checked via gt: new Date()',
    /password_reset_expires_at.*gt|gt.*password_reset_expires_at/.test(src));
  assert('bcrypt.hash used for new password',
    /bcrypt\.hash\(newPassword/.test(src) || /bcrypt\.hash\(/.test(src));
  assert('token_version incremented',
    /token_version.*increment/.test(src));
  assert('reset fields cleared (null)',
    /password_reset_token.*null/.test(src));
  assert('400 returned for invalid/expired token',
    /400/.test(src) && /Invalid or expired/.test(src));
}

(async () => {
  const app = makeApp();
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();

  const initialPassword = 'OldPass!021';
  const newPassword     = 'NewPass!021';
  const passwordHash    = await bcrypt.hash(initialPassword, 10);

  const seedRes = await pgClient.query(`
    INSERT INTO accounts (id, business_name, manager_phone, manager_email,
      alert_channel, communication_tone, password_hash, token_version)
    VALUES (gen_random_uuid()::text, 'Reset021 Co', '+15550010021',
      'reset021@t021.test', 'sms', 'casual', $1, 1)
    RETURNING id, token_version
  `, [passwordHash]);
  const accountId   = seedRes.rows[0].id as string;
  const initVersion = Number(seedRes.rows[0].token_version);

  try {
    // ── AC9: missing fields → 400 ─────────────────────────────────────────────
    console.log('\nAC9 — Missing fields → 400');
    {
      const r1 = await request(app).post('/auth/reset-password').send({});
      assert('empty body → 400', r1.status === 400);

      const r2 = await request(app)
        .post('/auth/reset-password')
        .send({ token: 'abc' });
      assert('missing newPassword → 400', r2.status === 400);

      const r3 = await request(app)
        .post('/auth/reset-password')
        .send({ newPassword: newPassword });
      assert('missing token → 400', r3.status === 400);
    }

    // ── AC8: unknown token → 400 ──────────────────────────────────────────────
    console.log('\nAC8 — Unknown token → 400');
    {
      const r = await request(app)
        .post('/auth/reset-password')
        .send({ token: 'deadbeef'.repeat(8), newPassword });
      assert('unknown token → 400', r.status === 400);
      assert('unknown token → correct error message',
        r.body?.error === 'Invalid or expired reset token');
    }

    // ── AC7: expired token → 400 ──────────────────────────────────────────────
    console.log('\nAC7 — Expired token → 400');
    {
      const expiredRaw = crypto.randomBytes(32).toString('hex');
      await seedResetToken(pgClient, accountId, expiredRaw, -1000); // 1 s in the past

      const r = await request(app)
        .post('/auth/reset-password')
        .send({ token: expiredRaw, newPassword });
      assert('expired token → 400', r.status === 400);
      assert('expired token → correct error message',
        r.body?.error === 'Invalid or expired reset token');
    }

    // ── AC1: valid token → 200 ────────────────────────────────────────────────
    console.log('\nAC1 — Valid token + newPassword → 200');
    const validRaw = crypto.randomBytes(32).toString('hex');
    await seedResetToken(pgClient, accountId, validRaw, 60 * 60 * 1000); // 1 h

    let resetRes: request.Response;
    {
      resetRes = await request(app)
        .post('/auth/reset-password')
        .send({ token: validRaw, newPassword });
      assert('valid token → 200', resetRes.status === 200);
      assert('response has success message', typeof resetRes.body?.message === 'string');
    }

    // ── AC2: password_hash updated — new password verifies ────────────────────
    console.log('\nAC2 — password_hash updated in DB (new password bcrypt-verifies)');
    {
      const dbRes = await pgClient.query(
        `SELECT password_hash FROM accounts WHERE id = $1`, [accountId],
      );
      const storedHash: string = dbRes.rows[0].password_hash;
      const newValid  = await bcrypt.compare(newPassword, storedHash);
      assert('new password verifies against stored hash', newValid);
    }

    // ── AC3: old password no longer valid ────────────────────────────────────
    console.log('\nAC3 — Old password rejected after reset');
    {
      const dbRes = await pgClient.query(
        `SELECT password_hash FROM accounts WHERE id = $1`, [accountId],
      );
      const storedHash: string = dbRes.rows[0].password_hash;
      const oldValid = await bcrypt.compare(initialPassword, storedHash);
      assert('old password no longer verifies', !oldValid);

      // Login with old password → 401
      const loginOld = await request(app)
        .post('/auth/login')
        .send({ email: 'reset021@t021.test', password: initialPassword });
      assert('login with old password → 401', loginOld.status === 401);

      // Login with new password → 200
      const loginNew = await request(app)
        .post('/auth/login')
        .send({ email: 'reset021@t021.test', password: newPassword });
      assert('login with new password → 200', loginNew.status === 200);
    }

    // ── AC4: token_version incremented ───────────────────────────────────────
    console.log('\nAC4 — token_version incremented (all prior JWTs revoked)');
    {
      const dbRes = await pgClient.query(
        `SELECT token_version FROM accounts WHERE id = $1`, [accountId],
      );
      const newVersion = Number(dbRes.rows[0].token_version);
      assert('token_version incremented by 1', newVersion === initVersion + 1);
    }

    // ── AC5: reset fields cleared ─────────────────────────────────────────────
    console.log('\nAC5 — password_reset_token and password_reset_expires_at cleared');
    {
      const dbRes = await pgClient.query(
        `SELECT password_reset_token, password_reset_expires_at FROM accounts WHERE id = $1`,
        [accountId],
      );
      assert('password_reset_token is NULL', dbRes.rows[0].password_reset_token === null);
      assert('password_reset_expires_at is NULL',
        dbRes.rows[0].password_reset_expires_at === null);
    }

    // ── AC6: token is single-use ──────────────────────────────────────────────
    console.log('\nAC6 — Token is single-use (second use → 400)');
    {
      const r = await request(app)
        .post('/auth/reset-password')
        .send({ token: validRaw, newPassword: 'AnotherPass!99' });
      assert('reusing the same token → 400', r.status === 400);
    }

  } finally {
    await pgClient.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    await pgClient.end();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
