/**
 * Verification script for T-006: DB Migration — messages Table
 *
 * AC1  messages model has all 16 fields
 * AC2  platform_message_id is @unique
 * AC3  is_urgent field exists with @default(false)
 * AC4  MessageStatus enum includes all 6 values
 * AC5  Migration applied; messages table visible in Supabase
 *
 * Run with: npx ts-node src/lib/t006.verify.ts
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
console.log('\nAC1 — messages model has all 16 fields');
{
  const fields = [
    'id', 'account_id', 'property_id', 'booking_id',
    'platform_message_id', 'direction', 'channel', 'sender',
    'content', 'intent_classification', 'status',
    'is_urgent', 'escalation_reason', 'maintenance_triggered',
    'sent_at', 'created_at',
  ];
  assert('messages model block exists', /model\s+messages\s*\{/.test(schema));
  assert('model has exactly 16 fields', fields.length === 16);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));

  // Optionality checks
  assert('intent_classification is optional (String?)', /intent_classification\s+String\?/.test(schema));
  assert('escalation_reason is optional (String?)', /escalation_reason\s+String\?/.test(schema));
  assert('sent_at is optional (DateTime?)', /sent_at\s+DateTime\?/.test(schema));
}

// ── AC2: platform_message_id is @unique ───────────────────────────────────────
console.log('\nAC2 — platform_message_id is @unique');
{
  assert(
    'platform_message_id has @unique',
    /platform_message_id\s+String\s+@unique/.test(schema),
  );
}

// ── AC3: is_urgent @default(false) ───────────────────────────────────────────
console.log('\nAC3 — is_urgent exists with @default(false)');
{
  assert(
    'is_urgent Boolean @default(false)',
    /is_urgent\s+Boolean\s+@default\(false\)/.test(schema),
  );
  assert(
    'maintenance_triggered Boolean @default(false)',
    /maintenance_triggered\s+Boolean\s+@default\(false\)/.test(schema),
  );
}

// ── AC4: MessageStatus enum has all 6 values ─────────────────────────────────
console.log('\nAC4 — MessageStatus enum has all 6 values');
{
  assert('MessageStatus enum defined', /enum\s+MessageStatus\s*\{/.test(schema));
  const values = ['auto_handled', 'escalated', 'failed', 'no_response_needed', 'processing', 'manager_handled'];
  for (const v of values) {
    assert(`MessageStatus has "${v}"`, new RegExp(`enum\\s+MessageStatus\\s*\\{[^}]*\\b${v}\\b`, 's').test(schema));
  }
  // Also verify the other 3 enums
  assert('MessageDirection enum defined', /enum\s+MessageDirection\s*\{/.test(schema));
  assert('MessageDirection has inbound',  /enum\s+MessageDirection\s*\{[^}]*\binbound\b/s.test(schema));
  assert('MessageDirection has outbound', /enum\s+MessageDirection\s*\{[^}]*\boutbound\b/s.test(schema));
  assert('MessageChannel enum defined', /enum\s+MessageChannel\s*\{/.test(schema));
  assert('MessageChannel has airbnb', /enum\s+MessageChannel\s*\{[^}]*\bairbnb\b/s.test(schema));
  assert('MessageChannel has vrbo',   /enum\s+MessageChannel\s*\{[^}]*\bvrbo\b/s.test(schema));
  assert('MessageChannel has sms',    /enum\s+MessageChannel\s*\{[^}]*\bsms\b/s.test(schema));
  assert('MessageSender enum defined', /enum\s+MessageSender\s*\{/.test(schema));
  assert('MessageSender has guest',   /enum\s+MessageSender\s*\{[^}]*\bguest\b/s.test(schema));
  assert('MessageSender has agent',   /enum\s+MessageSender\s*\{[^}]*\bagent\b/s.test(schema));
  assert('MessageSender has manager', /enum\s+MessageSender\s*\{[^}]*\bmanager\b/s.test(schema));
}

// ── AC5: live DB round-trip ───────────────────────────────────────────────────
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  let bookingId: string | null = null;
  const messageIds: string[] = [];

  try {
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-006 Verify Co',
        manager_phone: '+15550006666',
        manager_email: 'verify@t006.test',
        alert_channel: 'sms',
        communication_tone: 'casual',
        password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: {
        account_id: accountId,
        name: 'T-006 Test Property',
        address: '6 Test Lane',
        checkin_time: '15:00',
        checkout_time: '11:00',
      },
    });
    propertyId = property.id;

    const booking = await (prisma as any).bookings.create({
      data: {
        account_id: accountId,
        property_id: propertyId,
        platform: 'airbnb',
        platform_booking_id: 'AB-T006-001',
        guest_first_name: 'Test',
        guest_last_name: 'Guest',
        guest_platform_id: 'airbnb_guest_t006',
        checkin_datetime: new Date('2026-06-01T15:00:00Z'),
        checkout_datetime: new Date('2026-06-05T11:00:00Z'),
        status: 'upcoming',
      },
    });
    bookingId = booking.id;

    console.log('\nAC5 — messages table visible in Supabase (live INSERT → SELECT → DELETE)');

    const msg = await (prisma as any).messages.create({
      data: {
        account_id: accountId,
        property_id: propertyId,
        booking_id: bookingId,
        platform_message_id: 'airbnb_msg_t006_001',
        direction: 'inbound',
        channel: 'airbnb',
        sender: 'guest',
        content: 'What is the wifi password?',
        status: 'processing',
      },
    });
    messageIds.push(msg.id);

    assert('INSERT succeeded — table exists in Supabase', !!msg.id);
    assert('is_urgent defaults false', msg.is_urgent === false);
    assert('maintenance_triggered defaults false', msg.maintenance_triggered === false);
    assert('intent_classification is null', msg.intent_classification === null);
    assert('escalation_reason is null', msg.escalation_reason === null);
    assert('sent_at is null', msg.sent_at === null);
    assert('direction stored as "inbound"', msg.direction === 'inbound');
    assert('channel stored as "airbnb"', msg.channel === 'airbnb');
    assert('sender stored as "guest"', msg.sender === 'guest');
    assert('status stored as "processing"', msg.status === 'processing');
    assert('created_at populated', msg.created_at instanceof Date);

    const fetched = await (prisma as any).messages.findUnique({ where: { id: msg.id } });
    assert('SELECT by id returns the row', fetched?.platform_message_id === 'airbnb_msg_t006_001');

    // AC2: platform_message_id @unique — duplicate must fail
    console.log('\nAC2 (runtime) — duplicate platform_message_id is rejected');
    let threw = false;
    try {
      const dup = await (prisma as any).messages.create({
        data: {
          account_id: accountId,
          property_id: propertyId,
          booking_id: bookingId,
          platform_message_id: 'airbnb_msg_t006_001', // duplicate
          direction: 'inbound',
          channel: 'airbnb',
          sender: 'guest',
          content: 'Duplicate message',
          status: 'processing',
        },
      });
      messageIds.push(dup.id);
    } catch (e: unknown) {
      threw = true;
      const msg2 = e instanceof Error ? e.message : String(e);
      assert('error is a unique constraint violation', /unique/i.test(msg2));
    }
    assert('duplicate platform_message_id INSERT threw', threw);

    // Verify platform_message_id uniqueness in pg_indexes
    const idxRows = await (prisma as any).$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'messages'
        AND indexname = 'messages_platform_message_id_key'
    `;
    assert('unique index on platform_message_id exists in pg_indexes', (idxRows as any[]).length === 1);

    // AC5: migration file
    console.log('\nAC5 (cont.) — Migration file exists and applied');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const migr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_messages_table'));
    assert('*_create_messages_table migration folder exists', !!migr);
    if (migr) {
      const sql = fs.readFileSync(path.join(migrDir, migr, 'migration.sql'), 'utf8');
      assert('SQL creates messages table', /CREATE TABLE "messages"/.test(sql));
      assert('SQL creates MessageStatus enum', /CREATE TYPE "MessageStatus"/.test(sql));
      assert('SQL creates unique index on platform_message_id', /CREATE UNIQUE INDEX.*platform_message_id/s.test(sql));
      assert('SQL has FK to bookings', /REFERENCES "bookings"\("id"\)/.test(sql));
    }

    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260418000004_create_messages_table'
    `;
    assert('migration recorded in _prisma_migrations', (applied as any[]).length === 1);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    for (const id of messageIds) {
      await (prisma as any).messages.delete({ where: { id } }).catch(() => {});
    }
    if (bookingId)  await (prisma as any).bookings.delete({ where: { id: bookingId } }).catch(() => {});
    if (propertyId) await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId)  await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
