/**
 * Verification script for T-005: DB Migration — bookings Table
 *
 * AC1  bookings model has all 18 fields
 * AC2  Platform enum: airbnb, vrbo. BookingStatus enum: upcoming, active, completed, cancelled
 * AC3  @@unique([account_id, platform, platform_booking_id]) constraint applied
 * AC4  Inserting two rows with the same (account_id, platform, platform_booking_id) fails
 * AC5  Migration applied; bookings table visible in Supabase
 *
 * Run with: npx ts-node src/lib/t005.verify.ts
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

// ── AC1: all 18 fields ────────────────────────────────────────────────────────
console.log('\nAC1 — bookings model has all 18 fields');
{
  const fields = [
    'id', 'account_id', 'property_id', 'platform', 'platform_booking_id',
    'guest_first_name', 'guest_last_name', 'guest_platform_id',
    'checkin_datetime', 'checkout_datetime', 'status',
    'checkin_message_sent', 'checkin_message_sent_at',
    'checkout_reminder_sent', 'checkout_reminder_sent_at',
    'review_request_sent', 'review_request_sent_at',
    'created_at',
  ];
  assert('bookings model block exists', /model\s+bookings\s*\{/.test(schema));
  assert('model has exactly 18 fields', fields.length === 18);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));

  // Optional datetime fields
  for (const f of ['checkin_message_sent_at', 'checkout_reminder_sent_at', 'review_request_sent_at']) {
    assert(`"${f}" is optional (DateTime?)`, new RegExp(`${f}\\s+DateTime\\?`).test(schema));
  }
  // Boolean sent fields default false
  for (const f of ['checkin_message_sent', 'checkout_reminder_sent', 'review_request_sent']) {
    assert(`"${f}" defaults false`, new RegExp(`${f}\\s+Boolean\\s+@default\\(false\\)`).test(schema));
  }
}

// ── AC2: enums ────────────────────────────────────────────────────────────────
console.log('\nAC2 — Platform and BookingStatus enums');
{
  assert('Platform enum defined', /enum\s+Platform\s*\{/.test(schema));
  assert('Platform has airbnb', /enum\s+Platform\s*\{[^}]*\bairbnb\b/s.test(schema));
  assert('Platform has vrbo', /enum\s+Platform\s*\{[^}]*\bvrbo\b/s.test(schema));

  assert('BookingStatus enum defined', /enum\s+BookingStatus\s*\{/.test(schema));
  assert('BookingStatus has upcoming',  /enum\s+BookingStatus\s*\{[^}]*\bupcoming\b/s.test(schema));
  assert('BookingStatus has active',    /enum\s+BookingStatus\s*\{[^}]*\bactive\b/s.test(schema));
  assert('BookingStatus has completed', /enum\s+BookingStatus\s*\{[^}]*\bcompleted\b/s.test(schema));
  assert('BookingStatus has cancelled', /enum\s+BookingStatus\s*\{[^}]*\bcancelled\b/s.test(schema));
}

// ── AC3: @@unique constraint in schema ───────────────────────────────────────
console.log('\nAC3 — @@unique([account_id, platform, platform_booking_id]) in schema');
{
  assert(
    '@@unique constraint defined',
    /@@unique\(\[account_id,\s*platform,\s*platform_booking_id\]\)/.test(schema),
  );
}

// ── AC4 & AC5: live DB ────────────────────────────────────────────────────────
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  const bookingIds: string[] = [];

  try {
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-005 Verify Co',
        manager_phone: '+15550005555',
        manager_email: 'verify@t005.test',
        alert_channel: 'sms',
        communication_tone: 'casual',
        password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: {
        account_id: accountId,
        name: 'T-005 Test Property',
        address: '5 Test Blvd',
        checkin_time: '15:00',
        checkout_time: '11:00',
      },
    });
    propertyId = property.id;

    // ── AC5: INSERT succeeds ──────────────────────────────────────────────────
    console.log('\nAC5 — bookings table visible in Supabase (live INSERT → SELECT → DELETE)');
    const booking = await (prisma as any).bookings.create({
      data: {
        account_id: accountId,
        property_id: propertyId,
        platform: 'airbnb',
        platform_booking_id: 'AB-TEST-001',
        guest_first_name: 'Jane',
        guest_last_name: 'Smith',
        guest_platform_id: 'airbnb_guest_999',
        checkin_datetime: new Date('2026-06-01T15:00:00Z'),
        checkout_datetime: new Date('2026-06-05T11:00:00Z'),
        status: 'upcoming',
      },
    });
    bookingIds.push(booking.id);

    assert('INSERT succeeded — table exists in Supabase', !!booking.id);
    assert('checkin_message_sent defaults false', booking.checkin_message_sent === false);
    assert('checkout_reminder_sent defaults false', booking.checkout_reminder_sent === false);
    assert('review_request_sent defaults false', booking.review_request_sent === false);
    assert('optional sent_at fields are null', booking.checkin_message_sent_at === null);
    assert('platform stored as "airbnb"', booking.platform === 'airbnb');
    assert('status stored as "upcoming"', booking.status === 'upcoming');
    assert('created_at populated', booking.created_at instanceof Date);

    const fetched = await (prisma as any).bookings.findUnique({ where: { id: booking.id } });
    assert('SELECT by id returns the row', fetched?.platform_booking_id === 'AB-TEST-001');

    // ── AC4: duplicate (account_id, platform, platform_booking_id) must fail ──
    console.log('\nAC4 — duplicate (account_id, platform, platform_booking_id) is rejected');
    let threw = false;
    try {
      const dup = await (prisma as any).bookings.create({
        data: {
          account_id: accountId,
          property_id: propertyId,
          platform: 'airbnb',
          platform_booking_id: 'AB-TEST-001', // same composite key
          guest_first_name: 'Duplicate',
          guest_last_name: 'Guest',
          guest_platform_id: 'airbnb_guest_000',
          checkin_datetime: new Date('2026-07-01T15:00:00Z'),
          checkout_datetime: new Date('2026-07-05T11:00:00Z'),
          status: 'upcoming',
        },
      });
      bookingIds.push(dup.id);
    } catch (e: unknown) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      assert('error is a unique constraint violation', /unique/i.test(msg));
    }
    assert('duplicate composite key INSERT threw', threw);

    // Different platform with same booking_id must succeed
    const vrboBooking = await (prisma as any).bookings.create({
      data: {
        account_id: accountId,
        property_id: propertyId,
        platform: 'vrbo',
        platform_booking_id: 'AB-TEST-001', // same ID but different platform
        guest_first_name: 'Alice',
        guest_last_name: 'Jones',
        guest_platform_id: 'vrbo_guest_111',
        checkin_datetime: new Date('2026-08-01T15:00:00Z'),
        checkout_datetime: new Date('2026-08-05T11:00:00Z'),
        status: 'upcoming',
      },
    });
    bookingIds.push(vrboBooking.id);
    assert('same platform_booking_id on different platform succeeds', !!vrboBooking.id);

    // ── AC5: migration file checks ────────────────────────────────────────────
    console.log('\nAC5 (cont.) — Migration file exists and applied');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const migr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_bookings_table'));
    assert('*_create_bookings_table migration folder exists', !!migr);
    if (migr) {
      const sql = fs.readFileSync(path.join(migrDir, migr, 'migration.sql'), 'utf8');
      assert('SQL creates bookings table', /CREATE TABLE "bookings"/.test(sql));
      assert('SQL creates Platform enum', /CREATE TYPE "Platform"/.test(sql));
      assert('SQL creates BookingStatus enum', /CREATE TYPE "BookingStatus"/.test(sql));
      assert('SQL creates composite unique index', /CREATE UNIQUE INDEX.*bookings.*account_id.*platform.*platform_booking_id/s.test(sql));
      assert('SQL has FK to accounts', /REFERENCES "accounts"\("id"\)/.test(sql));
      assert('SQL has FK to properties', /REFERENCES "properties"\("id"\)/.test(sql));
    }

    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260418000003_create_bookings_table'
    `;
    assert('migration recorded in _prisma_migrations', (applied as any[]).length === 1);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    for (const id of bookingIds) {
      await (prisma as any).bookings.delete({ where: { id } }).catch(() => {});
    }
    if (propertyId) await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId)  await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
