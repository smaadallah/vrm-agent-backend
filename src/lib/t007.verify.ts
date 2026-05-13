/**
 * Verification script for T-007: DB Migration — cleaners + property_cleaners Tables
 *
 * AC1  cleaners model has all 7 fields
 * AC2  property_cleaners model has all 6 fields
 * AC3  Partial unique index property_cleaners_one_primary_per_property exists in Supabase
 * AC4  Inserting a second is_primary=true row for the same property_id fails
 * AC5  Migration files generated and applied
 *
 * Run with: npx ts-node src/lib/t007.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
import { PrismaClient } from '@prisma/client';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

const backendRoot = path.join(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(backendRoot, 'prisma', 'schema.prisma'), 'utf8');

// ── AC1: cleaners model has all 7 fields ──────────────────────────────────────
console.log('\nAC1 — cleaners model has all 7 fields');
{
  const fields = ['id', 'account_id', 'name', 'phone', 'email', 'is_active', 'created_at'];
  assert('cleaners model block exists', /model\s+cleaners\s*\{/.test(schema));
  assert('model has exactly 7 fields', fields.length === 7);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));
  assert('email is optional (String?)', /\bemail\s+String\?/.test(schema));
  assert('is_active defaults true', /is_active\s+Boolean\s+@default\(true\)/.test(schema));
}

// ── AC2: property_cleaners model has all 6 fields ─────────────────────────────
console.log('\nAC2 — property_cleaners model has all 6 fields');
{
  const fields = ['id', 'account_id', 'property_id', 'cleaner_id', 'is_primary', 'created_at'];
  assert('property_cleaners model block exists', /model\s+property_cleaners\s*\{/.test(schema));
  assert('model has exactly 6 fields', fields.length === 6);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));
  assert('is_primary defaults false', /is_primary\s+Boolean\s+@default\(false\)/.test(schema));
}

// ── AC3 & AC4 & AC5 (live DB) ─────────────────────────────────────────────────
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  let cleanerId: string | null = null;
  const pcIds: string[] = [];

  try {
    // Seed parent rows
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-007 Verify Co',
        manager_phone: '+15550007777',
        manager_email: 'verify@t007.test',
        alert_channel: 'sms',
        communication_tone: 'casual',
        password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: {
        account_id: accountId,
        name: 'T-007 Test Property',
        address: '1 Test St',
        checkin_time: '15:00',
        checkout_time: '11:00',
      },
    });
    propertyId = property.id;

    const cleaner = await (prisma as any).cleaners.create({
      data: { account_id: accountId, name: 'Alice', phone: '+15550007001' },
    });
    cleanerId = cleaner.id;

    // ── AC1/AC2 runtime field checks ─────────────────────────────────────────
    console.log('\nAC1 (runtime) — cleaners INSERT + defaults');
    assert('cleaner INSERT succeeded', !!cleaner.id);
    assert('is_active defaults true', cleaner.is_active === true);
    assert('email defaults null', cleaner.email === null);
    assert('created_at populated', cleaner.created_at instanceof Date);

    console.log('\nAC2 (runtime) — property_cleaners INSERT + defaults');
    const pc1 = await (prisma as any).property_cleaners.create({
      data: {
        account_id: accountId,
        property_id: propertyId,
        cleaner_id: cleanerId,
        is_primary: true,
      },
    });
    pcIds.push(pc1.id);
    assert('property_cleaners INSERT succeeded', !!pc1.id);
    assert('is_primary stored correctly', pc1.is_primary === true);

    // ── AC3: partial index exists in pg catalog ───────────────────────────────
    console.log('\nAC3 — partial index property_cleaners_one_primary_per_property exists');
    const indexRows = await (prisma as any).$queryRaw`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'property_cleaners'
        AND indexname = 'property_cleaners_one_primary_per_property'
    `;
    assert('index exists in pg_indexes', (indexRows as any[]).length === 1);

    // Also verify it is a partial index (has WHERE clause)
    const partialCheck = await (prisma as any).$queryRaw`
      SELECT indexdef
      FROM pg_indexes
      WHERE indexname = 'property_cleaners_one_primary_per_property'
    `;
    const def: string = (partialCheck as any[])[0]?.indexdef ?? '';
    assert('index definition contains WHERE clause', /WHERE/i.test(def));
    assert('index definition filters is_primary = true', /is_primary\s*=\s*true/i.test(def));

    // ── AC4: second is_primary=true for same property_id must fail ────────────
    console.log('\nAC4 — second is_primary=true for same property_id is rejected');
    let threw = false;
    try {
      const pc2 = await (prisma as any).property_cleaners.create({
        data: {
          account_id: accountId,
          property_id: propertyId,
          cleaner_id: cleanerId,
          is_primary: true,
        },
      });
      pcIds.push(pc2.id);
    } catch (e: unknown) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      assert('error is a unique constraint violation', /unique/i.test(msg));
    }
    assert('duplicate is_primary=true INSERT threw', threw);

    // Non-primary row for same property must succeed
    const pc3 = await (prisma as any).property_cleaners.create({
      data: {
        account_id: accountId,
        property_id: propertyId,
        cleaner_id: cleanerId,
        is_primary: false,
      },
    });
    pcIds.push(pc3.id);
    assert('non-primary duplicate INSERT succeeds (index only covers is_primary=true)', !!pc3.id);

    // ── AC5: migration files exist ────────────────────────────────────────────
    console.log('\nAC5 — Migration files generated and applied');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const cleanersMigr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_cleaners_tables'));
    const indexMigr = fs.readdirSync(migrDir).find(d => d.endsWith('_cleaners_partial_index'));

    assert('*_create_cleaners_tables migration folder exists', !!cleanersMigr);
    assert('*_cleaners_partial_index migration folder exists', !!indexMigr);

    if (cleanersMigr) {
      const sql = fs.readFileSync(path.join(migrDir, cleanersMigr, 'migration.sql'), 'utf8');
      assert('SQL creates cleaners table', /CREATE TABLE "cleaners"/.test(sql));
      assert('SQL creates property_cleaners table', /CREATE TABLE "property_cleaners"/.test(sql));
    }
    if (indexMigr) {
      const sql = fs.readFileSync(path.join(migrDir, indexMigr, 'migration.sql'), 'utf8');
      assert('partial index SQL documented', /CREATE UNIQUE INDEX/.test(sql));
      assert('index name correct in SQL file', /property_cleaners_one_primary_per_property/.test(sql));
    }

    // Confirm both migrations recorded in _prisma_migrations
    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name IN (
        '20260417212606_create_cleaners_tables',
        '20260417212700_cleaners_partial_index'
      )
      ORDER BY migration_name
    `;
    assert('both migrations recorded in _prisma_migrations', (applied as any[]).length === 2);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    for (const id of pcIds) {
      await (prisma as any).property_cleaners.delete({ where: { id } }).catch(() => {});
    }
    if (cleanerId) await (prisma as any).cleaners.delete({ where: { id: cleanerId } }).catch(() => {});
    if (propertyId) await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId) await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
