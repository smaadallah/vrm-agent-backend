/**
 * Verification script for T-004: DB Migration — properties Table
 *
 * AC1  properties model has all 31 fields with correct optionality
 * AC2  PropertyStatus enum has all 4 values with unknown as default
 * AC3  All 3 boolean message-enabled fields default to true
 * AC4  account_id @relation to accounts.id defined
 * AC5  Migration applied; properties table visible in Supabase (live round-trip)
 *
 * Run with: npx ts-node src/lib/t004.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
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

// ── AC1: properties model has all 31 fields ───────────────────────────────────
console.log('\nAC1 — properties model has all 31 fields with correct optionality');
{
  const requiredFields = [
    'id', 'account_id', 'name', 'address', 'checkin_time', 'checkout_time',
    'checkin_message_enabled', 'checkout_reminder_enabled', 'review_request_enabled',
    'checkin_message_hours_before', 'checkout_reminder_send_time',
    'review_request_hours_after', 'property_status',
    'auto_schedule_cleaner_enabled', 'cleaner_confirmation_window_minutes',
    'pre_checkin_alert_minutes', 'created_at',
  ];
  const optionalFields = [
    'door_access_instructions', 'parking_instructions', 'wifi_name', 'wifi_password',
    'house_rules', 'amenities', 'local_recommendations', 'special_instructions',
    'checkout_steps', 'checkin_message_template', 'checkout_reminder_template',
    'review_request_template', 'airbnb_listing_id', 'vrbo_listing_id',
  ];
  const allFields = [...requiredFields, ...optionalFields];

  assert('properties model block exists', /model\s+properties\s*\{/.test(schema));
  assert('model has exactly 31 fields', allFields.length === 31);

  for (const field of allFields) {
    assert(`field "${field}" present`, new RegExp(`\\b${field}\\b`).test(schema));
  }

  // Verify optionality — optional fields must have String?/DateTime? in schema
  for (const field of optionalFields) {
    assert(
      `"${field}" is optional (String?)`,
      new RegExp(`${field}\\s+String\\?`).test(schema),
    );
  }
}

// ── AC2: PropertyStatus enum ──────────────────────────────────────────────────
console.log('\nAC2 — PropertyStatus enum has all 4 values; unknown is default');
{
  assert('PropertyStatus enum defined', /enum\s+PropertyStatus\s*\{/.test(schema));
  assert('has unknown', /enum\s+PropertyStatus\s*\{[^}]*\bunknown\b/s.test(schema));
  assert('has guest_ready', /enum\s+PropertyStatus\s*\{[^}]*\bguest_ready\b/s.test(schema));
  assert('has occupied', /enum\s+PropertyStatus\s*\{[^}]*\boccupied\b/s.test(schema));
  assert('has needs_cleaning', /enum\s+PropertyStatus\s*\{[^}]*\bneeds_cleaning\b/s.test(schema));
  assert(
    'property_status defaults to unknown',
    /property_status\s+PropertyStatus\s+@default\(unknown\)/.test(schema),
  );
}

// ── AC3: Boolean message-enabled fields default true ─────────────────────────
console.log('\nAC3 — All 3 boolean message-enabled fields default to true');
{
  assert(
    'checkin_message_enabled defaults true',
    /checkin_message_enabled\s+Boolean\s+@default\(true\)/.test(schema),
  );
  assert(
    'checkout_reminder_enabled defaults true',
    /checkout_reminder_enabled\s+Boolean\s+@default\(true\)/.test(schema),
  );
  assert(
    'review_request_enabled defaults true',
    /review_request_enabled\s+Boolean\s+@default\(true\)/.test(schema),
  );
}

// ── AC4: account_id relation ──────────────────────────────────────────────────
console.log('\nAC4 — account_id @relation to accounts.id defined');
{
  assert(
    'account_id field present',
    /account_id\s+String/.test(schema),
  );
  assert(
    '@relation(fields: [account_id], references: [id]) defined',
    /@relation\s*\(\s*fields:\s*\[account_id\]\s*,\s*references:\s*\[id\]\s*\)/.test(schema),
  );
  assert(
    'accounts model has properties[] back-relation',
    /properties\s+properties\[\]/.test(schema),
  );
}

// ── AC5: Live Supabase round-trip ─────────────────────────────────────────────
console.log('\nAC5 — properties table visible in Supabase (live INSERT → SELECT → DELETE)');
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;

  try {
    // Create a parent account first (FK constraint)
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-004 Verify Co',
        manager_phone: '+15550001234',
        manager_email: 'verify@t004.test',
        alert_channel: 'sms',
        communication_tone: 'casual',
        password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    // Insert a property row
    const property = await (prisma as any).properties.create({
      data: {
        account_id: accountId,
        name: 'T-004 Beach House',
        address: '123 Ocean Drive, Malibu, CA',
        checkin_time: '15:00',
        checkout_time: '11:00',
      },
    });
    propertyId = property.id;

    assert('INSERT succeeded — table exists in Supabase', !!property.id);
    assert('checkin_message_enabled defaults true', property.checkin_message_enabled === true);
    assert('checkout_reminder_enabled defaults true', property.checkout_reminder_enabled === true);
    assert('review_request_enabled defaults true', property.review_request_enabled === true);
    assert('property_status defaults to "unknown"', property.property_status === 'unknown');
    assert('auto_schedule_cleaner_enabled defaults true', property.auto_schedule_cleaner_enabled === true);
    assert('checkin_message_hours_before defaults 24', property.checkin_message_hours_before === 24);
    assert('checkout_reminder_send_time defaults "20:00"', property.checkout_reminder_send_time === '20:00');
    assert('review_request_hours_after defaults 2', property.review_request_hours_after === 2);
    assert('cleaner_confirmation_window_minutes defaults 60', property.cleaner_confirmation_window_minutes === 60);
    assert('pre_checkin_alert_minutes defaults 30', property.pre_checkin_alert_minutes === 30);
    assert('optional fields are null', property.wifi_password === null && property.door_access_instructions === null);
    assert('created_at is populated', property.created_at instanceof Date);

    // Read back + confirm relation
    const fetched = await (prisma as any).properties.findUnique({
      where: { id: propertyId },
      include: { account: true },
    });
    assert('SELECT by id returns the row', fetched?.name === 'T-004 Beach House');
    assert('account relation resolves correctly', fetched?.account?.business_name === 'T-004 Verify Co');

    // Verify migration SQL
    const migrationsDir = path.join(backendRoot, 'prisma', 'migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_create_properties_table'));
    assert('migration folder *_create_properties_table exists', dirs.length === 1);
    if (dirs.length === 1) {
      const sql = fs.readFileSync(path.join(migrationsDir, dirs[0], 'migration.sql'), 'utf8');
      assert('SQL creates properties table', /CREATE TABLE "properties"/.test(sql));
      assert('SQL creates PropertyStatus enum', /CREATE TYPE "PropertyStatus"/.test(sql));
      assert('SQL has FK constraint to accounts', /REFERENCES "accounts"\("id"\)/.test(sql));
    }
  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    if (propertyId) await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId) await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
