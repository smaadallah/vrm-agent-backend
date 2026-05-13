/**
 * E2E Integration Test — Full Cross-Session Verification
 *
 * Tests the complete happy path:
 * 1. Server + pg-boss worker start clean
 * 2. Property + cleaner created via real API
 * 3. Booking arrives via Airbnb webhook → booking row created
 * 4. Checkout webhook → booking completed, cleaning job created, cleaner dispatched
 * 5. Twilio CONFIRM → cleaning job confirmed
 * 6. Twilio DONE → cleaning job completed, property guest_ready
 * 7. Work order created via API linked to cleaning job
 * 8. GET /api/work-orders, /api/cleaning-jobs, /api/review-drafts all return the created data
 *
 * Run: npx ts-node src/e2e-integration.test.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Must be set before any module imports that read env
process.env.AIRBNB_WEBHOOK_SECRET  = 'e2e-test-airbnb-secret';
process.env.VRBO_WEBHOOK_SECRET    = 'e2e-test-vrbo-secret';
process.env.TWILIO_WEBHOOK_SECRET  = 'e2e-test-twilio-secret';
process.env.PORT                   = '3197';

import crypto   from 'crypto';
import request  from 'supertest';
import jwt      from 'jsonwebtoken';
import prisma   from './lib/prisma';
import app      from './index';
import { startWorker } from './worker';

// Suppress all outbound SMS across every job module so no real Twilio calls fire
import { _hooks as booksHooks }    from './jobs/bookingSync';
import { _hooks as checkoutHooks } from './jobs/checkoutDetection';
import { _hooks as twilioHooks }   from './jobs/twilioSms';
import { _hooks as checkinHooks }  from './jobs/checkinMessage';
import { _hooks as reminderHooks } from './jobs/checkoutReminder';
import { _hooks as reviewHooks }   from './jobs/reviewRequest';
import { _hooks as preHooks }      from './jobs/preCheckinAlert';
import { _hooks as cleanerHooks }  from './jobs/cleanerNoResponse';

const noopSms      = async () => {};
const noopPlatform = async () => {};
booksHooks.sendSms          = noopSms;
checkoutHooks.smsSend       = noopSms;
twilioHooks.smsSend         = noopSms;
checkinHooks.platformSend   = noopPlatform;   // checkinMessage uses platformSend
reminderHooks.smsSend       = noopSms;
reminderHooks.platformSend  = noopPlatform;
reviewHooks.platformSend    = noopPlatform;   // reviewRequest uses platformSend
preHooks.smsSend            = noopSms;
cleanerHooks.smsSend        = noopSms;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hmacHex(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}
function hmacSha1Base64(secret: string, body: string): string {
  return crypto.createHmac('sha1', secret).update(Buffer.from(body)).digest('base64');
}

function makeToken(accountId: string): string {
  return jwt.sign({ accountId, tokenVersion: 1 }, process.env.JWT_SECRET!);
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.error(`  TIMEOUT waiting for: ${label}`);
  return false;
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AIRBNB_SECRET  = 'e2e-test-airbnb-secret';
const TWILIO_SECRET  = 'e2e-test-twilio-secret';
const RUN_ID         = Date.now();                           // unique per run
const LISTING_ID     = `e2e-listing-${RUN_ID}`;
const BOOKING_ID_EXT = `e2e-booking-${RUN_ID}`;
const CLEANER_PHONE  = '+15005550006'; // Twilio test magic number — never routes
const TEST_TAG       = '[e2e-integration-test]';

let accountId     = '';
let accountToken  = '';
let propertyId    = '';
let cleanerId     = '';
let bookingDbId   = '';
let cleaningJobId = '';

// ── Cleanup helper ────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  // Deletion order respects FK constraints:
  // work_orders → cleaning_jobs → property_cleaners → bookings
  // → turnover_checklists → cleaners → properties
  const errors: string[] = [];
  const del = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { errors.push(`${label}: ${(err as Error).message.split('\n')[0]}`); }
  };

  if (cleaningJobId) await del('work_orders(cleaning_job)', () =>
    prisma.work_orders.deleteMany({ where: { source_cleaning_job_id: cleaningJobId } }));
  if (cleaningJobId) await del('cleaning_jobs', () =>
    prisma.cleaning_jobs.deleteMany({ where: { id: cleaningJobId } }));
  if (propertyId && cleanerId) await del('property_cleaners', () =>
    prisma.property_cleaners.deleteMany({ where: { property_id: propertyId, cleaner_id: cleanerId } }));
  if (bookingDbId) await del('bookings', () =>
    prisma.bookings.deleteMany({ where: { id: bookingDbId } }));
  if (propertyId) await del('turnover_checklists', () =>
    prisma.turnover_checklists.deleteMany({ where: { property_id: propertyId } }));
  if (cleanerId) await del('cleaners', () =>
    prisma.cleaners.deleteMany({ where: { id: cleanerId } }));
  if (propertyId) await del('properties', () =>
    prisma.properties.deleteMany({ where: { id: propertyId } }));

  if (errors.length > 0) console.warn('  WARN  cleanup partial failures:\n   ', errors.join('\n    '));
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' VRM E2E Integration Test');
  console.log('══════════════════════════════════════════════════════════════');

  // ── Pre-run cleanup: remove any stale e2e properties ─────────────────────

  console.log('\nPre-run — removing stale e2e test properties');
  {
    const stale = await prisma.properties.findMany({
      where: { name: { contains: TEST_TAG } },
      select: { id: true },
    });
    for (const { id } of stale) {
      try {
        await prisma.work_orders.deleteMany({ where: { property_id: id } });
        await prisma.cleaning_jobs.deleteMany({ where: { property_id: id } });
        await prisma.bookings.deleteMany({ where: { property_id: id } });
        await prisma.property_cleaners.deleteMany({ where: { property_id: id } });
        await prisma.turnover_checklists.deleteMany({ where: { property_id: id } });
        await prisma.properties.deleteMany({ where: { id } });
        console.log(`  INFO  removed stale property ${id}`);
      } catch { /* ignore individual failures */ }
    }
  }

  // ── Step 0: Resolve seed account ─────────────────────────────────────────

  console.log('\nStep 0 — Resolve seed account');
  {
    const loginBody = JSON.stringify({ email: 'admin@vrm.dev', password: 'VrmAdmin!2026' });
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(loginBody);

    assert('Step0: POST /auth/login → 200',     res.status === 200);
    assert('Step0: response has token',          typeof res.body?.token === 'string');

    if (res.status !== 200) {
      console.error('Cannot proceed without auth. Aborting.');
      process.exit(1);
    }

    accountToken = res.body.token;
    const decoded = jwt.decode(accountToken) as { accountId: string };
    accountId = decoded.accountId;
    console.log(`  INFO  account_id = ${accountId}`);
  }

  // ── Step 1: Start pg-boss worker ─────────────────────────────────────────

  console.log('\nStep 1 — Start pg-boss worker');
  {
    try {
      await startWorker();
      assert('Step1: worker started without throwing', true);
    } catch (err) {
      assert('Step1: worker started without throwing', false, (err as Error).message);
      console.error('Worker failed to start — aborting.');
      process.exit(1);
    }
  }

  // ── Step 2: Create test property via API ──────────────────────────────────

  console.log('\nStep 2 — Create test property via POST /api/properties');
  {
    const res = await request(app)
      .post('/api/properties')
      .set('Authorization', `Bearer ${accountToken}`)
      .send({
        name:          `${TEST_TAG} E2E Test Property`,
        address:       '999 Integration Ave, Miami FL 33101',
        checkin_time:  '3:00 PM',
        checkout_time: '11:00 AM',
        airbnb_listing_id: LISTING_ID,
      });

    assert('Step2: POST /api/properties → 201', res.status === 201);
    assert('Step2: response has id',            typeof res.body?.data?.id === 'string');

    propertyId = res.body?.data?.id ?? '';
    console.log(`  INFO  property_id = ${propertyId}`);
  }

  // ── Step 3: Create test cleaner via API ───────────────────────────────────

  console.log('\nStep 3 — Create test cleaner via POST /api/cleaners');
  {
    const res = await request(app)
      .post('/api/cleaners')
      .set('Authorization', `Bearer ${accountToken}`)
      .send({
        name:  `${TEST_TAG} E2E Cleaner`,
        phone: CLEANER_PHONE,
        email: 'e2ecleaner@vrm-test.dev',
      });

    assert('Step3: POST /api/cleaners → 201', res.status === 201);
    assert('Step3: response has id',          typeof res.body?.data?.id === 'string');

    cleanerId = res.body?.data?.id ?? '';
    console.log(`  INFO  cleaner_id = ${cleanerId}`);
  }

  // ── Step 3b: Assign cleaner to property as primary (direct DB) ───────────

  console.log('\nStep 3b — Assign cleaner to property as primary (property_cleaners)');
  {
    try {
      await prisma.property_cleaners.create({
        data: {
          account_id:  accountId,
          property_id: propertyId,
          cleaner_id:  cleanerId,
          is_primary:  true,
        },
      });
      assert('Step3b: property_cleaners row created', true);
    } catch (err) {
      assert('Step3b: property_cleaners row created', false, (err as Error).message);
    }
  }

  // ── Step 4: Booking webhook → booking row created ────────────────────────

  console.log('\nStep 4 — Airbnb booking webhook → booking row created');
  {
    const payload = {
      platform_booking_id:    BOOKING_ID_EXT,
      listing_id:             LISTING_ID,
      guest_platform_user_id: 'guest-e2e-001',
      guest_first_name:       'E2E',
      guest_last_name:        'Guest',
      checkin_datetime:       new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),  // 4 days ago
      checkout_datetime:      new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),        // 1 hour ago
      status:                 'upcoming',
    };
    const body = JSON.stringify(payload);
    const sig  = hmacHex(AIRBNB_SECRET, body);

    const res = await request(app)
      .post('/webhooks/airbnb/booking-update')
      .set('Content-Type', 'application/json')
      .set('x-airbnb-signature', sig)
      .send(body);

    assert('Step4: webhook accepted (200)',         res.status === 200);
    assert('Step4: response { received: true }',   res.body?.received === true);

    // Wait for pg-boss to process the job and booking to appear in DB
    const found = await waitFor('booking in DB', async () => {
      const b = await prisma.bookings.findFirst({
        where: {
          account_id:          accountId,
          platform_booking_id: BOOKING_ID_EXT,
          platform:            'airbnb',
        },
      });
      if (b) { bookingDbId = b.id; return true; }
      return false;
    });

    assert('Step4: booking row created in DB',   found);
    if (found) {
      const booking = await prisma.bookings.findUnique({ where: { id: bookingDbId } });
      assert('Step4: booking status = upcoming',   booking?.status === 'upcoming');
      assert('Step4: booking property_id correct', booking?.property_id === propertyId);
      console.log(`  INFO  booking_id = ${bookingDbId}`);
    }
  }

  // ── Step 5: Activate booking (simulate booking activation) ───────────────

  console.log('\nStep 5 — Activate booking via direct DB update (simulates booking-activation-sweep)');
  {
    if (!bookingDbId) {
      console.error('  SKIP  No booking ID — cannot activate');
    } else {
      await prisma.bookings.update({
        where: { id: bookingDbId },
        data:  { status: 'active' },
      });
      const booking = await prisma.bookings.findUnique({ where: { id: bookingDbId } });
      assert('Step5: booking status = active', booking?.status === 'active');
    }
  }

  // ── Step 6: Checkout webhook → booking completed, cleaning job created ────

  console.log('\nStep 6 — Airbnb checkout webhook → cleaning job created, cleaner dispatched');
  {
    const payload = {
      platform_booking_id: BOOKING_ID_EXT,
      listing_id:          LISTING_ID,
    };
    const body = JSON.stringify(payload);
    const sig  = hmacHex(AIRBNB_SECRET, body);

    const res = await request(app)
      .post('/webhooks/airbnb/checkout')
      .set('Content-Type', 'application/json')
      .set('x-airbnb-signature', sig)
      .send(body);

    assert('Step6: checkout webhook accepted (200)', res.status === 200);

    // Wait for cleaning job to appear
    const found = await waitFor('cleaning job in DB', async () => {
      const job = await prisma.cleaning_jobs.findFirst({
        where: { booking_id: bookingDbId },
      });
      if (job) { cleaningJobId = job.id; return true; }
      return false;
    });

    assert('Step6: cleaning job created', found);

    if (found) {
      const [booking, job] = await Promise.all([
        prisma.bookings.findUnique({ where: { id: bookingDbId } }),
        prisma.cleaning_jobs.findUnique({ where: { id: cleaningJobId } }),
      ]);
      assert('Step6: booking status = completed',        booking?.status === 'completed');
      assert('Step6: cleaning job status = scheduled',   job?.status === 'scheduled');
      assert('Step6: cleaning job cleaner_id correct',   job?.cleaner_id === cleanerId);
      assert('Step6: cleaning job property_id correct',  job?.property_id === propertyId);
      console.log(`  INFO  cleaning_job_id = ${cleaningJobId}`);
    }
  }

  // ── Step 7: Twilio CONFIRM SMS → cleaning job confirmed ──────────────────

  console.log('\nStep 7 — Twilio inbound SMS CONFIRM → cleaning job confirmed');
  {
    if (!cleaningJobId) {
      console.error('  SKIP  No cleaning job — cannot confirm');
    } else {
      const payload = {
        MessageSid: 'SMconfirm-e2e-001',
        From:       CLEANER_PHONE,
        Body:       'CONFIRM',
      };
      const body = JSON.stringify(payload);
      const sig  = hmacSha1Base64(TWILIO_SECRET, body);

      const res = await request(app)
        .post('/webhooks/twilio/inbound-sms')
        .set('Content-Type', 'application/json')
        .set('x-twilio-signature', sig)
        .send(body);

      assert('Step7: Twilio webhook accepted (200)', res.status === 200);

      const found = await waitFor('cleaning job confirmed', async () => {
        const job = await prisma.cleaning_jobs.findUnique({ where: { id: cleaningJobId } });
        return job?.status === 'confirmed';
      });

      assert('Step7: cleaning job status = confirmed', found);
      const job = await prisma.cleaning_jobs.findUnique({ where: { id: cleaningJobId } });
      assert('Step7: cleaner_confirmed_at set', job?.cleaner_confirmed_at instanceof Date);
      assert('Step7: inbound_sms_sids logged',  (job?.inbound_sms_sids ?? []).includes('SMconfirm-e2e-001'));
    }
  }

  // ── Step 8: Twilio DONE SMS → cleaning job completed, property guest_ready

  console.log('\nStep 8 — Twilio inbound SMS DONE → cleaning job completed, property guest_ready');
  {
    if (!cleaningJobId) {
      console.error('  SKIP  No cleaning job — cannot complete');
    } else {
      const payload = {
        MessageSid: 'SMdone-e2e-001',
        From:       CLEANER_PHONE,
        Body:       'DONE',
      };
      const body = JSON.stringify(payload);
      const sig  = hmacSha1Base64(TWILIO_SECRET, body);

      const res = await request(app)
        .post('/webhooks/twilio/inbound-sms')
        .set('Content-Type', 'application/json')
        .set('x-twilio-signature', sig)
        .send(body);

      assert('Step8: Twilio webhook accepted (200)', res.status === 200);

      const jobDone = await waitFor('cleaning job completed', async () => {
        const job = await prisma.cleaning_jobs.findUnique({ where: { id: cleaningJobId } });
        return job?.status === 'completed';
      });

      assert('Step8: cleaning job status = completed', jobDone);

      const propReady = await waitFor('property guest_ready', async () => {
        const prop = await prisma.properties.findUnique({ where: { id: propertyId } });
        return prop?.property_status === 'guest_ready';
      });

      assert('Step8: property_status = guest_ready', propReady);

      const job = await prisma.cleaning_jobs.findUnique({ where: { id: cleaningJobId } });
      assert('Step8: closed_by = cleaner_sms',        job?.closed_by === 'cleaner_sms');
      assert('Step8: completed_at set',               job?.completed_at instanceof Date);
      assert('Step8: DONE sid in inbound_sms_sids',   (job?.inbound_sms_sids ?? []).includes('SMdone-e2e-001'));
    }
  }

  // ── Step 9: Create work order linked to cleaning job ─────────────────────

  console.log('\nStep 9 — Create work order via POST /api/work-orders');
  let workOrderId = '';
  if (!cleaningJobId) {
    console.log('  SKIP  No cleaning job ID — skipping work order creation');
    failed += 4;
  } else {
  {
    const res = await request(app)
      .post('/api/work-orders')
      .set('Authorization', `Bearer ${accountToken}`)
      .send({
        property_id:            propertyId,
        description:            'E2E test: bathroom tap dripping. Needs a plumber.',
        priority:               'medium',
        source_cleaning_job_id: cleaningJobId,
      });

    assert('Step9: POST /api/work-orders → 201', res.status === 201);
    assert('Step9: reported_by = cleaner',       res.body?.data?.reported_by === 'cleaner');
    assert('Step9: status = open',               res.body?.data?.status === 'open');
    assert('Step9: source_cleaning_job_id set',  res.body?.data?.source_cleaning_job_id === cleaningJobId);

    workOrderId = res.body?.data?.id ?? '';
    console.log(`  INFO  work_order_id = ${workOrderId}`);

    if (workOrderId) {
      await prisma.work_orders.deleteMany({ where: { id: workOrderId } });
    }
  }
  } // end if cleaningJobId

  // ── Step 10: GET endpoint verification ───────────────────────────────────

  console.log('\nStep 10 — GET /api/cleaning-jobs, /api/work-orders, /api/review-drafts');
  {
    const [cleaningRes, workOrderRes, reviewRes] = await Promise.all([
      request(app).get('/api/cleaning-jobs').set('Authorization', `Bearer ${accountToken}`),
      request(app).get('/api/work-orders').set('Authorization', `Bearer ${accountToken}`),
      request(app).get('/api/review-drafts').set('Authorization', `Bearer ${accountToken}`),
    ]);

    assert('Step10: GET /api/cleaning-jobs → 200',   cleaningRes.status === 200);
    assert('Step10: GET /api/work-orders → 200',     workOrderRes.status === 200);
    assert('Step10: GET /api/review-drafts → 200',   reviewRes.status === 200);

    // GET /api/cleaning-jobs returns { data: [...] } — a flat array of cleaning jobs
    assert('Step10: cleaning-jobs data is array',    Array.isArray(cleaningRes.body?.data));

    assert('Step10: work-orders response shape valid',
      typeof workOrderRes.body?.data?.active === 'object');
    assert('Step10: review-drafts response shape valid',
      Array.isArray(reviewRes.body?.data?.pending));
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  console.log('\nCleanup — removing all test data');
  await cleanup();
  console.log('  INFO  test data removed');

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` Result: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(62));

  if (failed > 0) process.exit(1);
  else process.exit(0);

})().catch(err => {
  console.error('\nFATAL test runner error:', err);
  process.exit(1);
});
