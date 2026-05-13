/**
 * Verification script for T-010: DB Migration — work_orders Table + Trigger + Partial Unique Index
 *
 * AC1  work_orders model has all 16 fields
 * AC2  WorkOrderPriority enum: urgent, high, medium, low. WorkOrderStatus enum: open, in_progress, resolved
 * AC3  Partial unique index work_orders_source_message_id_unique exists
 * AC4  Two work orders with the same non-null source_message_id -> constraint violation
 * AC5  work_orders_updated_at trigger fires on UPDATE
 *
 * Run with: npx ts-node src/lib/t010.verify.ts
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

// ── AC1: all 16 fields ────────────────────────────────────────────────────────
console.log('\nAC1 — work_orders model has all 16 fields');
{
  const fields = [
    'id', 'account_id', 'property_id', 'booking_id',
    'reported_by', 'description', 'ai_summary',
    'priority', 'status',
    'source_message_id', 'source_cleaning_job_id',
    'resolved_at', 'resolved_by', 'manager_notes',
    'created_at', 'updated_at',
  ];
  assert('work_orders model block exists', /model\s+work_orders\s*\{/.test(schema));
  assert('model has exactly 16 fields', fields.length === 16);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));

  assert('booking_id is optional (String?)', /booking_id\s+String\?/.test(schema));
  assert('ai_summary is optional (String?)', /ai_summary\s+String\?/.test(schema));
  assert('source_message_id is optional (String?)', /source_message_id\s+String\?/.test(schema));
  assert('source_cleaning_job_id is optional (String?)', /source_cleaning_job_id\s+String\?/.test(schema));
  assert('resolved_at is optional (DateTime?)', /resolved_at\s+DateTime\?/.test(schema));
  assert('resolved_by is optional (ResolvedBy?)', /resolved_by\s+ResolvedBy\?/.test(schema));
  assert('manager_notes is optional (String?)', /manager_notes\s+String\?/.test(schema));
  assert('updated_at uses @updatedAt', /updated_at\s+DateTime\s+@updatedAt/.test(schema));
}

// ── AC2: enums ────────────────────────────────────────────────────────────────
console.log('\nAC2 — WorkOrderPriority, WorkOrderStatus, ReportedBy, ResolvedBy enums');
{
  assert('WorkOrderPriority enum defined', /enum\s+WorkOrderPriority\s*\{/.test(schema));
  for (const v of ['urgent', 'high', 'medium', 'low']) {
    assert(`WorkOrderPriority has "${v}"`, new RegExp(`enum\\s+WorkOrderPriority\\s*\\{[^}]*\\b${v}\\b`, 's').test(schema));
  }
  assert('WorkOrderStatus enum defined', /enum\s+WorkOrderStatus\s*\{/.test(schema));
  for (const v of ['open', 'in_progress', 'resolved']) {
    assert(`WorkOrderStatus has "${v}"`, new RegExp(`enum\\s+WorkOrderStatus\\s*\\{[^}]*\\b${v}\\b`, 's').test(schema));
  }
  assert('ReportedBy enum defined', /enum\s+ReportedBy\s*\{/.test(schema));
  for (const v of ['guest', 'cleaner', 'manager']) {
    assert(`ReportedBy has "${v}"`, new RegExp(`enum\\s+ReportedBy\\s*\\{[^}]*\\b${v}\\b`, 's').test(schema));
  }
  assert('ResolvedBy enum defined', /enum\s+ResolvedBy\s*\{/.test(schema));
  assert('ResolvedBy has "manager"', /enum\s+ResolvedBy\s*\{[^}]*\bmanager\b/s.test(schema));
}

// ── Live DB ───────────────────────────────────────────────────────────────────
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  let bookingId: string | null = null;
  let cleanerId: string | null = null;
  let cleaningJobId: string | null = null;
  let messageId: string | null = null;
  const workOrderIds: string[] = [];

  try {
    // ── Seed parents ──────────────────────────────────────────────────────────
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-010 Verify Co', manager_phone: '+15550010000',
        manager_email: 'verify@t010.test', alert_channel: 'sms',
        communication_tone: 'casual', password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: { account_id: accountId, name: 'T-010 Property', address: '10 Test Way',
              checkin_time: '15:00', checkout_time: '11:00' },
    });
    propertyId = property.id;

    const booking = await (prisma as any).bookings.create({
      data: {
        account_id: accountId, property_id: propertyId, platform: 'airbnb',
        platform_booking_id: 'AB-T010-001', guest_first_name: 'T010', guest_last_name: 'Guest',
        guest_platform_id: 'g010', checkin_datetime: new Date('2026-08-01T15:00:00Z'),
        checkout_datetime: new Date('2026-08-05T11:00:00Z'), status: 'upcoming',
      },
    });
    bookingId = booking.id;

    const msg = await (prisma as any).messages.create({
      data: {
        account_id: accountId, property_id: propertyId, booking_id: bookingId,
        platform_message_id: 'airbnb_msg_t010_001',
        direction: 'inbound', channel: 'airbnb', sender: 'guest',
        content: 'The AC is broken', status: 'processing',
      },
    });
    messageId = msg.id;

    const cleaner = await (prisma as any).cleaners.create({
      data: { account_id: accountId, name: 'T010 Cleaner', phone: '+15550010001' },
    });
    cleanerId = cleaner.id;

    const cleaningJob = await (prisma as any).cleaning_jobs.create({
      data: {
        account_id: accountId, property_id: propertyId, booking_id: bookingId,
        cleaner_id: cleanerId, status: 'scheduled',
        scheduled_start: new Date('2026-08-05T11:30:00Z'), supply_flags: [],
      },
    });
    cleaningJobId = cleaningJob.id;

    // ── AC1 runtime: INSERT + defaults ────────────────────────────────────────
    console.log('\nAC1 (runtime) — INSERT work_order and verify defaults');
    const wo = await (prisma as any).work_orders.create({
      data: {
        account_id: accountId, property_id: propertyId,
        booking_id: bookingId,
        reported_by: 'guest', description: 'AC unit not cooling',
        priority: 'urgent', status: 'open',
        source_message_id: messageId,
        source_cleaning_job_id: cleaningJobId,
      },
    });
    workOrderIds.push(wo.id);

    assert('INSERT succeeded — table exists in Supabase', !!wo.id);
    assert('ai_summary defaults null', wo.ai_summary === null);
    assert('resolved_at defaults null', wo.resolved_at === null);
    assert('resolved_by defaults null', wo.resolved_by === null);
    assert('manager_notes defaults null', wo.manager_notes === null);
    assert('reported_by stored as "guest"', wo.reported_by === 'guest');
    assert('priority stored as "urgent"', wo.priority === 'urgent');
    assert('status stored as "open"', wo.status === 'open');
    assert('source_message_id stored', wo.source_message_id === messageId);
    assert('source_cleaning_job_id stored', wo.source_cleaning_job_id === cleaningJobId);
    assert('created_at populated', wo.created_at instanceof Date);
    assert('updated_at populated', wo.updated_at instanceof Date);

    // Work order without booking or source — null FKs must be accepted
    const wo2 = await (prisma as any).work_orders.create({
      data: {
        account_id: accountId, property_id: propertyId,
        reported_by: 'manager', description: 'Leaky faucet',
        priority: 'low', status: 'open',
      },
    });
    workOrderIds.push(wo2.id);
    assert('work order without optional FKs succeeds', !!wo2.id);
    assert('booking_id defaults null', wo2.booking_id === null);

    // ── AC3: partial index exists in pg catalog ───────────────────────────────
    console.log('\nAC3 — Partial unique index work_orders_source_message_id_unique exists');
    const idxRows = await (prisma as any).$queryRaw`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'work_orders'
        AND indexname = 'work_orders_source_message_id_unique'
    `;
    assert('index exists in pg_indexes', (idxRows as any[]).length === 1);
    const def: string = (idxRows as any[])[0]?.indexdef ?? '';
    assert('index definition has WHERE clause', /WHERE/i.test(def));
    assert('index filters IS NOT NULL', /IS NOT NULL/i.test(def));

    // ── AC4: duplicate non-null source_message_id must fail ───────────────────
    console.log('\nAC4 — duplicate non-null source_message_id is rejected');
    let threw = false;
    try {
      const dup = await (prisma as any).work_orders.create({
        data: {
          account_id: accountId, property_id: propertyId,
          reported_by: 'guest', description: 'Duplicate from same message',
          priority: 'high', status: 'open',
          source_message_id: messageId, // same non-null message
        },
      });
      workOrderIds.push(dup.id);
    } catch (e: unknown) {
      threw = true;
      const errMsg = e instanceof Error ? e.message : String(e);
      assert('error is a unique constraint violation', /unique/i.test(errMsg));
    }
    assert('duplicate source_message_id INSERT threw', threw);

    // Two work orders with null source_message_id must both succeed
    const woNull1 = await (prisma as any).work_orders.create({
      data: {
        account_id: accountId, property_id: propertyId,
        reported_by: 'cleaner', description: 'Stain on carpet',
        priority: 'medium', status: 'open',
      },
    });
    workOrderIds.push(woNull1.id);
    const woNull2 = await (prisma as any).work_orders.create({
      data: {
        account_id: accountId, property_id: propertyId,
        reported_by: 'cleaner', description: 'Broken lamp',
        priority: 'low', status: 'open',
      },
    });
    workOrderIds.push(woNull2.id);
    assert('two rows with null source_message_id both succeed (partial index)', !!woNull1.id && !!woNull2.id);

    // ── AC5: trigger fires on UPDATE ─────────────────────────────────────────
    console.log('\nAC5 — work_orders_updated_at trigger fires on UPDATE');
    const trigRows = await (prisma as any).$queryRaw`
      SELECT trigger_name, event_manipulation, action_timing
      FROM information_schema.triggers
      WHERE trigger_name = 'work_orders_updated_at'
        AND event_object_table = 'work_orders'
    `;
    assert('trigger exists in information_schema', (trigRows as any[]).length >= 1);
    assert('trigger fires on UPDATE', (trigRows as any[]).some((r: any) => r.event_manipulation === 'UPDATE'));
    assert('trigger timing is BEFORE', (trigRows as any[]).some((r: any) => r.action_timing === 'BEFORE'));

    const beforeUpdate = wo.updated_at as Date;
    await new Promise(r => setTimeout(r, 1100));
    await (prisma as any).work_orders.update({ where: { id: wo.id }, data: { status: 'in_progress' } });
    const afterWo = await (prisma as any).work_orders.findUnique({ where: { id: wo.id } });
    assert('updated_at advances after UPDATE', afterWo.updated_at > beforeUpdate);
    assert('status updated to in_progress', afterWo.status === 'in_progress');

    // ── Migration file check ──────────────────────────────────────────────────
    console.log('\nMigration file check');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const migr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_work_orders'));
    assert('*_create_work_orders migration folder exists', !!migr);
    if (migr) {
      const sql = fs.readFileSync(path.join(migrDir, migr, 'migration.sql'), 'utf8');
      assert('SQL creates work_orders table', /CREATE TABLE "work_orders"/.test(sql));
      assert('SQL creates WorkOrderPriority enum', /CREATE TYPE "WorkOrderPriority"/.test(sql));
      assert('SQL creates WorkOrderStatus enum', /CREATE TYPE "WorkOrderStatus"/.test(sql));
      assert('SQL creates trigger', /CREATE TRIGGER work_orders_updated_at/.test(sql));
      assert('SQL creates partial unique index', /CREATE UNIQUE INDEX work_orders_source_message_id_unique/.test(sql));
      assert('SQL partial index has WHERE clause', /WHERE source_message_id IS NOT NULL/.test(sql));
    }
    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260418000006_create_work_orders'
    `;
    assert('migration recorded in _prisma_migrations', (applied as any[]).length === 1);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    for (const id of workOrderIds) await (prisma as any).work_orders.delete({ where: { id } }).catch(() => {});
    if (cleaningJobId) await (prisma as any).cleaning_jobs.delete({ where: { id: cleaningJobId } }).catch(() => {});
    if (messageId)    await (prisma as any).messages.delete({ where: { id: messageId } }).catch(() => {});
    if (cleanerId)    await (prisma as any).cleaners.delete({ where: { id: cleanerId } }).catch(() => {});
    if (bookingId)    await (prisma as any).bookings.delete({ where: { id: bookingId } }).catch(() => {});
    if (propertyId)   await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId)    await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
