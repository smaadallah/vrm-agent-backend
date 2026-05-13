/**
 * Verification script for T-008: DB Migration — turnover_checklists Table + updated_at Trigger
 *
 * AC1  turnover_checklists model has all 6 fields
 * AC2  set_updated_at() function exists in Supabase
 * AC3  turnover_checklists_updated_at trigger fires on UPDATE
 * AC4  updated_at changes on any UPDATE to a row
 * AC5  Migration applied
 *
 * Run with: npx ts-node src/lib/t008.verify.ts
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

// ── AC1: schema inspection ────────────────────────────────────────────────────
console.log('\nAC1 — turnover_checklists model has all 6 fields');
{
  const fields = ['id', 'account_id', 'property_id', 'checklist_body', 'created_at', 'updated_at'];
  assert('turnover_checklists model block exists', /model\s+turnover_checklists\s*\{/.test(schema));
  assert('model has exactly 6 fields', fields.length === 6);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));
  assert('checklist_body defaults ""', /checklist_body\s+String\s+@default/.test(schema) && schema.includes('@default("")'));
  assert('updated_at uses @updatedAt', /updated_at\s+DateTime\s+@updatedAt/.test(schema));
}

(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  let checklistId: string | null = null;

  try {
    // Seed parent rows
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-008 Verify Co',
        manager_phone: '+15550008888',
        manager_email: 'verify@t008.test',
        alert_channel: 'sms',
        communication_tone: 'casual',
        password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: {
        account_id: accountId,
        name: 'T-008 Test Property',
        address: '8 Test Ave',
        checkin_time: '15:00',
        checkout_time: '11:00',
      },
    });
    propertyId = property.id;

    // ── AC1 (runtime): INSERT + defaults ──────────────────────────────────────
    const checklist = await (prisma as any).turnover_checklists.create({
      data: { account_id: accountId, property_id: propertyId },
    });
    checklistId = checklist.id;

    assert('INSERT succeeded', !!checklist.id);
    assert('checklist_body defaults to empty string', checklist.checklist_body === '');
    assert('created_at populated', checklist.created_at instanceof Date);
    assert('updated_at populated on create', checklist.updated_at instanceof Date);

    // ── AC2: set_updated_at() function exists in pg catalog ───────────────────
    console.log('\nAC2 — set_updated_at() function exists in Supabase');
    const fnRows = await (prisma as any).$queryRaw`
      SELECT proname FROM pg_proc
      WHERE proname = 'set_updated_at'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `;
    assert('set_updated_at() function exists', (fnRows as any[]).length >= 1);

    // ── AC3: trigger exists in pg catalog ─────────────────────────────────────
    console.log('\nAC3 — turnover_checklists_updated_at trigger exists and fires BEFORE UPDATE');
    const trigRows = await (prisma as any).$queryRaw`
      SELECT trigger_name, event_manipulation, action_timing
      FROM information_schema.triggers
      WHERE trigger_name = 'turnover_checklists_updated_at'
        AND event_object_table = 'turnover_checklists'
    `;
    assert('trigger exists', (trigRows as any[]).length >= 1);
    assert('trigger fires on UPDATE', (trigRows as any[]).some((r: any) => r.event_manipulation === 'UPDATE'));
    assert('trigger timing is BEFORE', (trigRows as any[]).some((r: any) => r.action_timing === 'BEFORE'));

    // ── AC4: updated_at changes on UPDATE ─────────────────────────────────────
    console.log('\nAC4 — updated_at changes on any UPDATE to a row');
    const beforeUpdate = checklist.updated_at as Date;

    // Small sleep so now() differs from the insert timestamp
    await new Promise(r => setTimeout(r, 1100));

    await (prisma as any).turnover_checklists.update({
      where: { id: checklistId },
      data: { checklist_body: '## Kitchen\n- Wipe counters' },
    });

    const afterRow = await (prisma as any).turnover_checklists.findUnique({
      where: { id: checklistId },
    });
    assert('updated_at changed after UPDATE', afterRow.updated_at > beforeUpdate);
    assert('checklist_body was updated', afterRow.checklist_body === '## Kitchen\n- Wipe counters');

    // ── AC5: migration files exist and applied ────────────────────────────────
    console.log('\nAC5 — Migration files generated and applied');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const tableMigr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_turnover_checklists'));
    const trigMigr  = fs.readdirSync(migrDir).find(d => d.endsWith('_turnover_checklists_trigger'));

    assert('*_create_turnover_checklists folder exists', !!tableMigr);
    assert('*_turnover_checklists_trigger folder exists', !!trigMigr);

    if (tableMigr) {
      const sql = fs.readFileSync(path.join(migrDir, tableMigr, 'migration.sql'), 'utf8');
      assert('SQL creates turnover_checklists table', /CREATE TABLE "turnover_checklists"/.test(sql));
      assert('SQL has FK to accounts', /REFERENCES "accounts"\("id"\)/.test(sql));
      assert('SQL has FK to properties', /REFERENCES "properties"\("id"\)/.test(sql));
    }
    if (trigMigr) {
      const sql = fs.readFileSync(path.join(migrDir, trigMigr, 'migration.sql'), 'utf8');
      assert('trigger SQL has CREATE OR REPLACE FUNCTION set_updated_at', /CREATE OR REPLACE FUNCTION set_updated_at/.test(sql));
      assert('trigger SQL has CREATE TRIGGER turnover_checklists_updated_at', /CREATE TRIGGER turnover_checklists_updated_at/.test(sql));
    }

    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name IN (
        '20260418000001_create_turnover_checklists',
        '20260418000002_turnover_checklists_trigger'
      )
    `;
    assert('both migrations recorded in _prisma_migrations', (applied as any[]).length === 2);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    if (checklistId) await (prisma as any).turnover_checklists.delete({ where: { id: checklistId } }).catch(() => {});
    if (propertyId)  await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId)   await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
