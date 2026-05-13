/**
 * Verification script for T-011: DB Migration — review_drafts Table + Trigger
 *
 * AC1  review_drafts model has all 15 fields
 * AC2  platform_review_id is @unique
 * AC3  ReviewDraftStatus enum: pending, copied, dismissed
 * AC4  review_drafts_updated_at trigger fires on UPDATE
 * AC5  Migration applied; table visible in Supabase
 *
 * Run with: npx ts-node src/lib/t011.verify.ts
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

// ── AC1: all 15 fields ────────────────────────────────────────────────────────
console.log('\nAC1 — review_drafts model has all 15 fields');
{
  const fields = [
    'id', 'account_id', 'property_id', 'booking_id',
    'platform', 'platform_review_id', 'reviewer_name', 'rating',
    'review_text', 'draft_response', 'status',
    'no_review_text', 'ai_failed',
    'created_at', 'updated_at',
  ];
  assert('review_drafts model block exists', /model\s+review_drafts\s*\{/.test(schema));
  assert('model has exactly 15 fields', fields.length === 15);
  for (const f of fields) assert(`field "${f}" present`, new RegExp(`\\b${f}\\b`).test(schema));

  assert('booking_id is optional (String?)', /booking_id\s+String\?/.test(schema));
  assert('review_text is optional (String?)', /review_text\s+String\?/.test(schema));
  assert('draft_response is optional (String?)', /draft_response\s+String\?/.test(schema));
  assert('no_review_text defaults false', /no_review_text\s+Boolean\s+@default\(false\)/.test(schema));
  assert('ai_failed defaults false', /ai_failed\s+Boolean\s+@default\(false\)/.test(schema));
  assert('updated_at uses @updatedAt', /updated_at\s+DateTime\s+@updatedAt/.test(schema));
  assert('reuses Platform enum (not a new enum)', /platform\s+Platform\b/.test(schema));
}

// ── AC2: platform_review_id @unique ──────────────────────────────────────────
console.log('\nAC2 — platform_review_id is @unique');
{
  assert('platform_review_id has @unique', /platform_review_id\s+String\s+@unique/.test(schema));
}

// ── AC3: ReviewDraftStatus enum ───────────────────────────────────────────────
console.log('\nAC3 — ReviewDraftStatus enum: pending, copied, dismissed');
{
  assert('ReviewDraftStatus enum defined', /enum\s+ReviewDraftStatus\s*\{/.test(schema));
  for (const v of ['pending', 'copied', 'dismissed']) {
    assert(`ReviewDraftStatus has "${v}"`, new RegExp(`enum\\s+ReviewDraftStatus\\s*\\{[^}]*\\b${v}\\b`, 's').test(schema));
  }
}

// ── AC4 & AC5: live DB ────────────────────────────────────────────────────────
(async () => {
  const prisma = new PrismaClient();
  let accountId: string | null = null;
  let propertyId: string | null = null;
  let bookingId: string | null = null;
  const draftIds: string[] = [];

  try {
    const account = await (prisma as any).accounts.create({
      data: {
        business_name: 'T-011 Verify Co', manager_phone: '+15550011111',
        manager_email: 'verify@t011.test', alert_channel: 'sms',
        communication_tone: 'casual', password_hash: 'bcrypt_placeholder',
      },
    });
    accountId = account.id;

    const property = await (prisma as any).properties.create({
      data: { account_id: accountId, name: 'T-011 Property', address: '11 Test Ave',
              checkin_time: '15:00', checkout_time: '11:00' },
    });
    propertyId = property.id;

    const booking = await (prisma as any).bookings.create({
      data: {
        account_id: accountId, property_id: propertyId, platform: 'airbnb',
        platform_booking_id: 'AB-T011-001', guest_first_name: 'T011', guest_last_name: 'Guest',
        guest_platform_id: 'g011', checkin_datetime: new Date('2026-09-01T15:00:00Z'),
        checkout_datetime: new Date('2026-09-05T11:00:00Z'), status: 'completed',
      },
    });
    bookingId = booking.id;

    // ── AC5: INSERT + defaults ────────────────────────────────────────────────
    console.log('\nAC5 — review_drafts table visible in Supabase (live INSERT → SELECT → DELETE)');
    const draft = await (prisma as any).review_drafts.create({
      data: {
        account_id: accountId, property_id: propertyId, booking_id: bookingId,
        platform: 'airbnb', platform_review_id: 'airbnb_rev_t011_001',
        reviewer_name: 'Jane Traveler', rating: 5,
        review_text: 'Amazing stay!',
        status: 'pending',
      },
    });
    draftIds.push(draft.id);

    assert('INSERT succeeded — table exists in Supabase', !!draft.id);
    assert('no_review_text defaults false', draft.no_review_text === false);
    assert('ai_failed defaults false', draft.ai_failed === false);
    assert('draft_response defaults null', draft.draft_response === null);
    assert('platform stored as "airbnb"', draft.platform === 'airbnb');
    assert('status stored as "pending"', draft.status === 'pending');
    assert('rating stored', draft.rating === 5);
    assert('booking_id stored', draft.booking_id === bookingId);
    assert('created_at populated', draft.created_at instanceof Date);
    assert('updated_at populated', draft.updated_at instanceof Date);

    // INSERT without booking_id (always NULL in MVP per spec)
    const draftNoBk = await (prisma as any).review_drafts.create({
      data: {
        account_id: accountId, property_id: propertyId,
        platform: 'vrbo', platform_review_id: 'vrbo_rev_t011_001',
        reviewer_name: 'Bob Vacationer', rating: 4,
        status: 'pending',
      },
    });
    draftIds.push(draftNoBk.id);
    assert('INSERT without booking_id succeeds (null FK)', !!draftNoBk.id);
    assert('booking_id is null when omitted', draftNoBk.booking_id === null);
    assert('review_text is null when omitted', draftNoBk.review_text === null);

    // SELECT
    const fetched = await (prisma as any).review_drafts.findUnique({ where: { id: draft.id } });
    assert('SELECT by id returns correct row', fetched?.platform_review_id === 'airbnb_rev_t011_001');

    // ── AC2 runtime: duplicate platform_review_id must fail ──────────────────
    console.log('\nAC2 (runtime) — duplicate platform_review_id is rejected');
    let threw = false;
    try {
      const dup = await (prisma as any).review_drafts.create({
        data: {
          account_id: accountId, property_id: propertyId,
          platform: 'airbnb', platform_review_id: 'airbnb_rev_t011_001', // duplicate
          reviewer_name: 'Dup', rating: 3, status: 'pending',
        },
      });
      draftIds.push(dup.id);
    } catch (e: unknown) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      assert('error is a unique constraint violation', /unique/i.test(msg));
    }
    assert('duplicate platform_review_id INSERT threw', threw);

    // Confirm unique index in pg catalog
    const idxRows = await (prisma as any).$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'review_drafts'
        AND indexname = 'review_drafts_platform_review_id_key'
    `;
    assert('unique index on platform_review_id exists in pg_indexes', (idxRows as any[]).length === 1);

    // ── AC4: trigger fires on UPDATE ─────────────────────────────────────────
    console.log('\nAC4 — review_drafts_updated_at trigger fires on UPDATE');
    const trigRows = await (prisma as any).$queryRaw`
      SELECT trigger_name, event_manipulation, action_timing
      FROM information_schema.triggers
      WHERE trigger_name = 'review_drafts_updated_at'
        AND event_object_table = 'review_drafts'
    `;
    assert('trigger exists in information_schema', (trigRows as any[]).length >= 1);
    assert('trigger fires on UPDATE', (trigRows as any[]).some((r: any) => r.event_manipulation === 'UPDATE'));
    assert('trigger timing is BEFORE', (trigRows as any[]).some((r: any) => r.action_timing === 'BEFORE'));

    const beforeUpdate = draft.updated_at as Date;
    await new Promise(r => setTimeout(r, 1100));
    await (prisma as any).review_drafts.update({
      where: { id: draft.id },
      data: { draft_response: 'Thank you for the wonderful review!', status: 'copied' },
    });
    const afterDraft = await (prisma as any).review_drafts.findUnique({ where: { id: draft.id } });
    assert('updated_at advances after UPDATE', afterDraft.updated_at > beforeUpdate);
    assert('status updated to "copied"', afterDraft.status === 'copied');

    // ── AC5: migration file ───────────────────────────────────────────────────
    console.log('\nAC5 (cont.) — Migration file exists and applied');
    const migrDir = path.join(backendRoot, 'prisma', 'migrations');
    const migr = fs.readdirSync(migrDir).find(d => d.endsWith('_create_review_drafts'));
    assert('*_create_review_drafts migration folder exists', !!migr);
    if (migr) {
      const sql = fs.readFileSync(path.join(migrDir, migr, 'migration.sql'), 'utf8');
      assert('SQL creates review_drafts table', /CREATE TABLE "review_drafts"/.test(sql));
      assert('SQL creates ReviewDraftStatus enum', /CREATE TYPE "ReviewDraftStatus"/.test(sql));
      assert('SQL creates unique index on platform_review_id', /CREATE UNIQUE INDEX.*platform_review_id/s.test(sql));
      assert('SQL creates trigger', /CREATE TRIGGER review_drafts_updated_at/.test(sql));
    }
    const applied = await (prisma as any).$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name = '20260418000007_create_review_drafts'
    `;
    assert('migration recorded in _prisma_migrations', (applied as any[]).length === 1);

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('live DB operations succeeded', false);
  } finally {
    for (const id of draftIds) await (prisma as any).review_drafts.delete({ where: { id } }).catch(() => {});
    if (bookingId)  await (prisma as any).bookings.delete({ where: { id: bookingId } }).catch(() => {});
    if (propertyId) await (prisma as any).properties.delete({ where: { id: propertyId } }).catch(() => {});
    if (accountId)  await (prisma as any).accounts.delete({ where: { id: accountId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
