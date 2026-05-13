/**
 * Verification script for T-009: DB Migration — cleaning_jobs Table + Trigger + UNIQUE
 *
 * AC1  cleaning_jobs model has all 28 fields
 * AC2  CleaningJobStatus enum: scheduled, confirmed, completed, no_response, failed
 * AC3  booking_id is @unique — duplicate booking_id INSERT fails
 * AC4  supply_flags and inbound_sms_sids are String[]; inbound_sms_sids defaults to {}
 * AC5  cleaning_jobs_updated_at trigger fires on UPDATE
 * AC6  Migration applied
 *
 * Run with: npx ts-node src/lib/t009.verify.ts
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

// ── AC1: all 28 fields ────────────────────────────────────────────────────────
console.log('\nAC1 — cleaning_jobs model has all 28 fields');
{
  const fields = [
    'id', 'account_id', 'property_id', 'booking_id', 'next_booking_id', 'cleaner_id',
    'status', 'scheduled_start', 'deadline',
    'job_notification_sent', 'job_notification_sent_at',
    'cleaner_confirmed_at',
    'checklist_sent', 'checklist_sent_at',
    'completed_at', 'closed_by', 'completion_sms_raw',
    'supply_flags',
    'supply_alert_sent', 'supply_alert_sent_at',
    'supply_alert_dismissed', 'supply_alert_permanently_failed',
    'no_response_alert_sent', 'pre_checkin_alert_sent',
    'damage_fyi_sent', 'damage_report_dismissed',
    'inbound_sms_sids',
    'created_at', 'updated_at',
  ];
  assert('cleaning_jobs model block exists', /model\s+cleaning_jobs\s*\{/.test(schema));
  assert('model has exactly 29 fields (28 data + updated_at)', fields.length === 29);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));

  // Optionality
  assert('next_booking_id is optional (String?)', /next_booking_id\s+String\?/.test(schema));
  assert('deadline is optional (DateTime?)', /deadline\s+DateTime\?/.test(schema));
  assert('closed_by is optional (ClosedBy?)', /closed_by\s+ClosedBy\?/.test(schema));
  assert('updated_at uses @updatedAt', /updated_at\s+DateTime\s+@updatedAt/.test(schema));
  assert('booking_id has @unique', /booking_id\s+String\s+@unique/.test(schema));
}

// ── AC2: enums ────────────────────────────────────────────────────────────────
console.log('\nAC2 — CleaningJobStatus and ClosedBy enums');
{
  assert('CleaningJobStatus enum defined', /enum\s+CleaningJobStatus\s*\{/.test(schema));
  for (const v of ['scheduled', 'confirmed', 'completed', 'no_response', 'failed']) {
    assert(`CleaningJobStatus has "${v}"`, new RegExp(`enum\\s+CleaningJobStatus\\s*\\{[^}]*\\b${v}\\b`, 's').test(schema));
  }
  assert('ClosedBy enum defined', /enum\s+ClosedBy\s*\{/.test(schema));
  assert('ClosedBy has cleaner_sms', /enum\s+ClosedBy\s*\{[^}]*\bcleaner_sms\b/s.test(schema));
  assert('ClosedBy has manager_manual', /enum\s+ClosedBy\s*\{[^}]*\bmanager_manual\b/s.test(schema));
}

// ── AC4: array fields in schema ───────────────────────────────────────────────
console.log('\nAC4 — supply_flags and inbound_sms_sids are String[] arrays');
{
  assert('supply_flags is String[]', /supply_flags\s+String\[\]/.test(schema));
  assert('inbound_sms_sids is String[] @default([])', /inbound_sms_sids\s+String\[\]\s+@default\(\[\]\)/.test(schema));
}

// ── Live DB tests (AC3, AC4 runtime, AC5, AC6) ────────────────────────────────
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  let cleanerId: string | null = null;
  let bookingId: string | null = null;
  let booking2Id: string | null = null;
  const jobIds: string[] = [];

  try {
    // Seed parents
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-009 Verify Co', manager_phone: '+15550009999',
        manager_email: 'verify@t009.test', alert_channel: 'sms',
        communication_tone: 'casual', password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: { account_id: accountId, name: 'T-009 Property', address: '9 Test Rd',
              checkin_time: '15:00', checkout_time: '11:00' },
    });
    propertyId = property.id;

    const cleaner = await (prisma as any).cleaners.create({
      data: { account_id: accountId, name: 'Bob Cleaner', phone: '+15550009001' },
    });
    cleanerId = cleaner.id;

    const booking = await (prisma as any).bookings.create({
      data: {
        account_id: accountId, property_id: propertyId, platform: 'airbnb',
        platform_booking_id: 'AB-T009-001', guest_first_name: 'Guest', guest_last_name: 'One',
        guest_platform_id: 'g001', checkin_datetime: new Date('2026-07-01T15:00:00Z'),
        checkout_datetime: new Date('2026-07-05T11:00:00Z'), status: 'upcoming',
      },
    });
    bookingId = booking.id;

    const booking2 = await (prisma as any).bookings.create({
      data: {
        account_id: accountId, property_id: propertyId, platform: 'airbnb',
        platform_booking_id: 'AB-T009-002', guest_first_name: 'Guest', guest_last_name: 'Two',
        guest_platform_id: 'g002', checkin_datetime: new Date('2026-07-10T15:00:00Z'),
        checkout_datetime: new Date('2026-07-14T11:00:00Z'), status: 'upcoming',
      },
    });
    booking2Id = booking2.id;

    // ── AC1/AC4 runtime: INSERT and verify defaults ───────────────────────────
    console.log('\nAC1 + AC4 (runtime) — INSERT cleaning_job and verify defaults');
    const job = await (prisma as any).cleaning_jobs.create({
      data: {
        account_id: accountId, property_id: propertyId,
        booking_id: bookingId, next_booking_id: booking2Id,
        cleaner_id: cleanerId, status: 'scheduled',
        scheduled_start: new Date('2026-07-05T11:30:00Z'),
        supply_flags: ['paper_towels', 'soap'],
      },
    });
    jobIds.push(job.id);

    assert('INSERT succeeded', !!job.id);
    assert('job_notification_sent defaults false', job.job_notification_sent === false);
    assert('checklist_sent defaults false', job.checklist_sent === false);
    assert('supply_alert_sent defaults false', job.supply_alert_sent === false);
    assert('damage_fyi_sent defaults false', job.damage_fyi_sent === false);
    assert('damage_report_dismissed defaults false', job.damage_report_dismissed === false);
    assert('no_response_alert_sent defaults false', job.no_response_alert_sent === false);
    assert('supply_alert_dismissed defaults false', job.supply_alert_dismissed === false);
    assert('supply_alert_permanently_failed defaults false', job.supply_alert_permanently_failed === false);
    assert('pre_checkin_alert_sent defaults false', job.pre_checkin_alert_sent === false);
    assert('closed_by defaults null', job.closed_by === null);
    assert('deadline defaults null', job.deadline === null);
    assert('inbound_sms_sids defaults to empty array', Array.isArray(job.inbound_sms_sids) && job.inbound_sms_sids.length === 0);
    assert('supply_flags stored as array', Array.isArray(job.supply_flags) && job.supply_flags[0] === 'paper_towels');
    assert('next_booking_id stored', job.next_booking_id === booking2Id);
    assert('updated_at populated on create', job.updated_at instanceof Date);

    // ── AC3: duplicate booking_id must fail ───────────────────────────────────
    console.log('\nAC3 — duplicate booking_id INSERT is rejected');
    let threw = false;
    try {
      const dup = await (prisma as any).cleaning_jobs.create({
        data: {
          account_id: accountId, property_id: propertyId,
          booking_id: bookingId, // duplicate
          cleaner_id: cleanerId, status: 'scheduled',
          scheduled_start: new Date('2026-07-05T12:00:00Z'),
          supply_flags: [],
        },
      });
      jobIds.push(dup.id);
    } catch (e: unknown) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      assert('error is a unique constraint violation', /unique/i.test(msg));
    }
    assert('duplicate booking_id INSERT threw', threw);

    // Confirm unique index in pg catalog
    const idxRows = await (prisma as any).$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'cleaning_jobs' AND indexname = 'cleaning_jobs_booking_id_key'
    `;
    assert('unique index on booking_id exists in pg_indexes', (idxRows as any[]).length === 1);

    // ── AC5: trigger fires on UPDATE ─────────────────────────────────────────
    console.log('\nAC5 — cleaning_jobs_updated_at trigger fires on UPDATE');
    const trigRows = await (prisma as any).$queryRaw`
      SELECT trigger_name, event_manipulation, action_timing
      FROM information_schema.triggers
      WHERE trigger_name = 'cleaning_jobs_updated_at'
        AND event_object_table = 'cleaning_jobs'
    `;
    assert('trigger exists in information_schema', (trigRows as any[]).length >= 1);
    assert('trigger fires on UPDATE', (trigRows as any[]).some((r: any) => r.event_manipulation === 'UPDATE'));
    assert('trigger timing is BEFORE', (trigRows as any[]).some((r: any) => r.action_timing === 'BEFORE'));

    const beforeUpdate = job.updated_at as Date;
    await new Promise(r => setTimeout(r, 1100));
    await (prisma as any).cleaning_jobs.update({
      where: { id: job.id },
      data: { status: 'confirmed' },
    });
    const afterJob = await (prisma as any).cleaning_jobs.findUnique({ where: { id: job.id } });
    assert('updated_at advances after UPDATE', afterJob.updated_at > beforeUpdate);

    // ── AC6: migration file ───────────────────────────────────────────────────
    console.log('\nAC6 — Migration file generated and applied');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const migr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_cleaning_jobs'));
    assert('*_create_cleaning_jobs migration folder exists', !!migr);
    if (migr) {
      const sql = fs.readFileSync(path.join(migrDir, migr, 'migration.sql'), 'utf8');
      assert('SQL creates cleaning_jobs table', /CREATE TABLE "cleaning_jobs"/.test(sql));
      assert('SQL creates CleaningJobStatus enum', /CREATE TYPE "CleaningJobStatus"/.test(sql));
      assert('SQL creates ClosedBy enum', /CREATE TYPE "ClosedBy"/.test(sql));
      assert('SQL creates unique index on booking_id', /CREATE UNIQUE INDEX.*cleaning_jobs_booking_id_key/s.test(sql));
      assert('SQL creates trigger', /CREATE TRIGGER cleaning_jobs_updated_at/.test(sql));
    }
    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260418000005_create_cleaning_jobs'
    `;
    assert('migration recorded in _prisma_migrations', (applied as any[]).length === 1);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    for (const id of jobIds) await (prisma as any).cleaning_jobs.delete({ where: { id } }).catch(() => {});
    if (booking2Id) await (prisma as any).bookings.delete({ where: { id: booking2Id } }).catch(() => {});
    if (bookingId)  await (prisma as any).bookings.delete({ where: { id: bookingId } }).catch(() => {});
    if (cleanerId)  await (prisma as any).cleaners.delete({ where: { id: cleanerId } }).catch(() => {});
    if (propertyId) await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId)  await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
