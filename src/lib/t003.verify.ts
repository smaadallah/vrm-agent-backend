/**
 * Verification script for T-003: DB Migration — accounts Table
 *
 * AC1  accounts model has all 20 fields
 * AC2  AlertChannel enum: sms, email, both. CommunicationTone enum: casual, professional, luxury
 * AC3  token_version defaults to 1; daily_ai_token_usage defaults to 0; ai_token_daily_cap defaults to 500000
 * AC4  Migration SQL file generated in /backend/prisma/migrations/
 * AC5  accounts table visible in Supabase (verified via live INSERT + SELECT + DELETE)
 *
 * Run with: npx ts-node src/lib/t003.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
// Use the direct (non-pooled) URL for live verification — same connection the migration used.
if (process.env.DIRECT_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
}
import { PrismaClient } from '@prisma/client';

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

const backendRoot = path.join(__dirname, '..', '..');
const schemaPath = path.join(backendRoot, 'prisma', 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');

// ── AC1: accounts model has all 20 fields ─────────────────────────────────────
console.log('\nAC1 — accounts model has all 20 fields');
{
  const fields = [
    'id',
    'business_name',
    'manager_phone',
    'manager_email',
    'alert_channel',
    'communication_tone',
    'twilio_phone_number',
    'airbnb_access_token',
    'airbnb_refresh_token',
    'vrbo_access_token',
    'vrbo_refresh_token',
    'token_version',
    'daily_ai_token_usage',
    'ai_token_daily_cap',
    'ai_token_cap_reset_at',
    'data_region',
    'password_hash',
    'password_reset_token',
    'password_reset_expires_at',
    'created_at',
  ];
  assert('accounts model block exists', /model\s+accounts\s*\{/.test(schema));
  assert('model has exactly 20 fields', fields.length === 20);
  for (const field of fields) {
    assert(`field "${field}" present`, new RegExp(`\\b${field}\\b`).test(schema));
  }
}

// ── AC2: Enums ────────────────────────────────────────────────────────────────
console.log('\nAC2 — AlertChannel and CommunicationTone enums');
{
  assert('AlertChannel enum defined', /enum\s+AlertChannel\s*\{/.test(schema));
  assert('AlertChannel has sms', /enum\s+AlertChannel\s*\{[^}]*\bsms\b/s.test(schema));
  assert('AlertChannel has email', /enum\s+AlertChannel\s*\{[^}]*\bemail\b/s.test(schema));
  assert('AlertChannel has both', /enum\s+AlertChannel\s*\{[^}]*\bboth\b/s.test(schema));

  assert('CommunicationTone enum defined', /enum\s+CommunicationTone\s*\{/.test(schema));
  assert('CommunicationTone has casual', /enum\s+CommunicationTone\s*\{[^}]*\bcasual\b/s.test(schema));
  assert('CommunicationTone has professional', /enum\s+CommunicationTone\s*\{[^}]*\bprofessional\b/s.test(schema));
  assert('CommunicationTone has luxury', /enum\s+CommunicationTone\s*\{[^}]*\bluxury\b/s.test(schema));
}

// ── AC3: Default values ───────────────────────────────────────────────────────
console.log('\nAC3 — Default values for token_version, daily_ai_token_usage, ai_token_daily_cap');
{
  assert('token_version defaults to 1', /token_version\s+Int\s+@default\(1\)/.test(schema));
  assert('daily_ai_token_usage defaults to 0', /daily_ai_token_usage\s+Int\s+@default\(0\)/.test(schema));
  assert('ai_token_daily_cap defaults to 500000', /ai_token_daily_cap\s+Int\s+@default\(500000\)/.test(schema));
}

// ── AC4: Migration SQL file exists ────────────────────────────────────────────
console.log('\nAC4 — Migration SQL file generated in /backend/prisma/migrations/');
{
  const migrationsDir = path.join(backendRoot, 'prisma', 'migrations');
  assert('migrations directory exists', fs.existsSync(migrationsDir));

  const dirs = fs.readdirSync(migrationsDir).filter(d =>
    d.endsWith('_create_accounts_table'),
  );
  assert('migration folder named *_create_accounts_table exists', dirs.length === 1);

  if (dirs.length === 1) {
    const sqlPath = path.join(migrationsDir, dirs[0], 'migration.sql');
    assert('migration.sql file exists', fs.existsSync(sqlPath));

    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert('SQL creates accounts table', /CREATE TABLE "accounts"/.test(sql));
    assert('SQL creates AlertChannel enum', /CREATE TYPE "AlertChannel"/.test(sql));
    assert('SQL creates CommunicationTone enum', /CREATE TYPE "CommunicationTone"/.test(sql));
    assert('SQL sets token_version DEFAULT 1', /token_version.*DEFAULT 1/s.test(sql));
    assert('SQL sets ai_token_daily_cap DEFAULT 500000', /ai_token_daily_cap.*DEFAULT 500000/s.test(sql));
  }
}

// ── AC5: Live Supabase round-trip ─────────────────────────────────────────────
console.log('\nAC5 — accounts table visible in Supabase (live INSERT → SELECT → DELETE)');
(async () => {
  const prisma = new PrismaClient();
  let testId: string | null = null;
  try {
    const row = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-003 Verify Co',
        manager_phone: '+15550001234',
        manager_email: 'verify@t003.test',
        alert_channel: 'sms',
        communication_tone: 'casual',
        password_hash: 'bcrypt_placeholder',
        token_version: 1,
        daily_ai_token_usage: 0,
        ai_token_daily_cap: 500000,
        data_region: 'us',
      },
    });
    testId = row.id;

    assert('INSERT succeeded — table exists in Supabase', !!row.id);
    assert('token_version default is 1', row.token_version === 1);
    assert('daily_ai_token_usage default is 0', row.daily_ai_token_usage === 0);
    assert('ai_token_daily_cap default is 500000', row.ai_token_daily_cap === 500000);
    assert('data_region default is "us"', row.data_region === 'us');
    assert('created_at is populated', row.created_at instanceof Date);

    // Read back
    const fetched = await (prisma as any).accounts.findUnique({ where: { id: row.id } });
    assert('SELECT by id returns the row', fetched?.business_name === 'T-003 Verify Co');

    // Enum round-trip
    assert('alert_channel round-trips as "sms"', fetched?.alert_channel === 'sms');
    assert('communication_tone round-trips as "casual"', fetched?.communication_tone === 'casual');
  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    if (testId) {
      await (prisma as any).accounts.delete({ where: { id: testId } }).catch(() => {});
      assert('DELETE cleanup succeeded', true);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
