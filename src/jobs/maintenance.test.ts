/**
 * T-031 verification — AI Token Cap Reset + Guest PII Retention Purge Daily Jobs
 *
 * AC1  ai-token-cap-reset sets daily_ai_token_usage = 0 and ai_token_cap_reset_at = now()
 *      for all accounts.
 * AC2  guest-pii-retention-purge deletes messages and clears guest PII on bookings
 *      older than 12 months.
 * AC3  Both jobs log count of affected rows.
 * AC4  Both handlers registered in worker.ts.
 *
 * Run: npx ts-node src/jobs/maintenance.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import { aiTokenCapResetHandler, guestPiiPurgeHandler } from './maintenance';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

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

// ── Logger capture helper ─────────────────────────────────────────────────────
// Runs fn() while capturing all logger.info calls. Restores the original after.
// Must be used sequentially (not concurrently) to avoid spy collision.
async function captureLoggerInfo(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const captured: Array<Record<string, unknown>> = [];
  const origInfo = (logger as any).info.bind(logger);

  (logger as any).info = (obj: unknown, msg?: string) => {
    if (typeof obj === 'object' && obj !== null) {
      captured.push({ ...(obj as object), _msg: msg });
    } else {
      captured.push({ _msg: String(obj) });
    }
    origInfo(obj, msg);  // still write to actual log
  };

  try {
    await fn();
  } finally {
    (logger as any).info = origInfo;
  }
  return captured;
}

// ── All runtime tests run sequentially inside a single async block ─────────────
(async () => {

  // ── AC1: ai-token-cap-reset ─────────────────────────────────────────────────
  console.log('\nAC1 — ai-token-cap-reset: sets daily_ai_token_usage=0 and ai_token_cap_reset_at=now() for all accounts');
  {
    let capturedArgs: Record<string, unknown> | null = null;

    const origUpdateMany = (prisma.accounts as any).updateMany;
    (prisma.accounts as any).updateMany = async (args: any) => {
      capturedArgs = args;
      return { count: 7 };
    };

    const logs = await captureLoggerInfo(async () => {
      await aiTokenCapResetHandler();
    });

    (prisma.accounts as any).updateMany = origUpdateMany;

    assert('AC1: updateMany called on accounts',
      capturedArgs !== null);
    assert('AC1: daily_ai_token_usage set to 0',
      (capturedArgs as any)?.data?.daily_ai_token_usage === 0);
    assert('AC1: ai_token_cap_reset_at set to a Date',
      (capturedArgs as any)?.data?.ai_token_cap_reset_at instanceof Date);
    assert('AC1: ai_token_cap_reset_at is approximately now (within 5 seconds)',
      Math.abs(Date.now() - ((capturedArgs as any)?.data?.ai_token_cap_reset_at as Date)?.getTime()) < 5000);
    assert('AC1: no where clause — all accounts updated',
      (capturedArgs as any)?.where === undefined);

    // AC3: count logged
    const countLog = logs.find(l => typeof (l as any).count === 'number');
    assert('AC3: ai-token-cap-reset logs count of affected rows',
      countLog !== undefined && (countLog as any).count === 7);
    assert('AC3: log message references ai-token-cap-reset',
      logs.some(l => String(l._msg ?? '').includes('ai-token-cap-reset')));
  }

  // ── AC2: guest-pii-retention-purge (normal case) ────────────────────────────
  console.log('\nAC2 — guest-pii-retention-purge: deletes messages and clears PII on old bookings');
  {
    let findManyArgs:    Record<string, unknown> | null = null;
    let deleteManyArgs:  Record<string, unknown> | null = null;
    let updateManyArgs:  Record<string, unknown> | null = null;

    const origFindMany   = (prisma.bookings as any).findMany;
    const origDeleteMany = (prisma.messages as any).deleteMany;
    const origUpdateMany = (prisma.bookings as any).updateMany;

    (prisma.bookings as any).findMany = async (args: any) => {
      findManyArgs = args;
      return [{ id: 'booking-old-001' }, { id: 'booking-old-002' }];
    };
    (prisma.messages as any).deleteMany = async (args: any) => {
      deleteManyArgs = args;
      return { count: 14 };
    };
    (prisma.bookings as any).updateMany = async (args: any) => {
      updateManyArgs = args;
      return { count: 2 };
    };

    const logs = await captureLoggerInfo(async () => {
      await guestPiiPurgeHandler();
    });

    (prisma.bookings as any).findMany   = origFindMany;
    (prisma.messages as any).deleteMany = origDeleteMany;
    (prisma.bookings as any).updateMany = origUpdateMany;

    // Cutoff should be ~12 months ago
    const expectedCutoff = new Date();
    expectedCutoff.setMonth(expectedCutoff.getMonth() - 12);
    const queryDate: Date | undefined = (findManyArgs as any)?.where?.checkout_datetime?.lt;

    assert('AC2: findMany queries checkout_datetime < cutoff',
      queryDate instanceof Date);
    assert('AC2: cutoff is approximately 12 months ago (within 60 seconds)',
      queryDate instanceof Date &&
      Math.abs(queryDate.getTime() - expectedCutoff.getTime()) < 60_000);

    // messages.deleteMany
    const deletedIds: string[] = (deleteManyArgs as any)?.where?.booking_id?.in ?? [];
    assert('AC2: messages.deleteMany called',
      deleteManyArgs !== null);
    assert('AC2: deleteMany uses the old booking IDs',
      deletedIds.includes('booking-old-001') && deletedIds.includes('booking-old-002'));

    // bookings.updateMany clears PII
    assert('AC2: bookings.updateMany called',
      updateManyArgs !== null);
    assert('AC2: guest_first_name set to [redacted]',
      (updateManyArgs as any)?.data?.guest_first_name === '[redacted]');
    assert('AC2: guest_last_name set to [redacted]',
      (updateManyArgs as any)?.data?.guest_last_name === '[redacted]');
    assert('AC2: guest_platform_id set to [redacted]',
      (updateManyArgs as any)?.data?.guest_platform_id === '[redacted]');
    assert('AC2: updateMany targets same old booking IDs',
      (() => {
        const ids: string[] = (updateManyArgs as any)?.where?.id?.in ?? [];
        return ids.includes('booking-old-001') && ids.includes('booking-old-002');
      })());

    // AC3: counts logged
    const countLog = logs.find(l =>
      typeof (l as any).deletedMessages === 'number' &&
      typeof (l as any).redactedBookings === 'number',
    );
    assert('AC3: guest-pii-retention-purge logs deletedMessages count',
      countLog !== undefined && (countLog as any).deletedMessages === 14);
    assert('AC3: guest-pii-retention-purge logs redactedBookings count',
      countLog !== undefined && (countLog as any).redactedBookings === 2);
    assert('AC3: log message references guest-pii-retention-purge',
      logs.some(l => String(l._msg ?? '').includes('guest-pii-retention-purge')));
  }

  // ── AC2: guest-pii-retention-purge (empty case — no old bookings) ─────────────
  console.log('\nAC2 (empty case) — no old bookings → no delete/update called');
  {
    let deleteCalled = false;
    let updateCalled = false;

    const origFindMany   = (prisma.bookings as any).findMany;
    const origDeleteMany = (prisma.messages as any).deleteMany;
    const origUpdateMany = (prisma.bookings as any).updateMany;

    (prisma.bookings as any).findMany   = async () => [];
    (prisma.messages as any).deleteMany = async () => { deleteCalled = true; return { count: 0 }; };
    (prisma.bookings as any).updateMany = async () => { updateCalled = true; return { count: 0 }; };

    await guestPiiPurgeHandler();

    (prisma.bookings as any).findMany   = origFindMany;
    (prisma.messages as any).deleteMany = origDeleteMany;
    (prisma.bookings as any).updateMany = origUpdateMany;

    assert('AC2: deleteMany NOT called when no old bookings',  !deleteCalled);
    assert('AC2: updateMany NOT called when no old bookings',  !updateCalled);
  }

  // ── AC3 (source): verify logger.info calls exist in source ────────────────────
  console.log('\nAC3 (source) — both handlers contain logger.info with relevant counts');
  {
    const src = fs.readFileSync(path.join(__dirname, 'maintenance.ts'), 'utf8');

    assert('AC3 src: maintenance.ts imports logger',
      /import logger/.test(src));
    assert('AC3 src: aiTokenCapResetHandler logs count',
      /logger\.info\s*\(\s*\{[^}]*count[^}]*\}/.test(src));
    assert('AC3 src: guestPiiPurgeHandler logs deletedMessages',
      /deletedMessages/.test(src));
    assert('AC3 src: guestPiiPurgeHandler logs redactedBookings',
      /redactedBookings/.test(src));
  }

  // ── AC4: both handlers registered in worker.ts ───────────────────────────────
  console.log('\nAC4 — Both handlers registered in worker.ts');
  {
    const workerSrc = fs.readFileSync(path.join(backendRoot, 'src', 'worker.ts'), 'utf8');

    assert('AC4: worker.ts imports aiTokenCapResetHandler',
      /aiTokenCapResetHandler/.test(workerSrc));
    assert('AC4: worker.ts imports guestPiiPurgeHandler',
      /guestPiiPurgeHandler/.test(workerSrc));
    assert('AC4: worker.ts imports from ./jobs/maintenance',
      /from\s+['"]\.\/jobs\/maintenance['"]/.test(workerSrc));
    assert("AC4: 'ai-token-cap-reset' mapped to aiTokenCapResetHandler",
      /['"]ai-token-cap-reset['"][\s\S]{0,80}aiTokenCapResetHandler/.test(workerSrc));
    assert("AC4: 'guest-pii-retention-purge' mapped to guestPiiPurgeHandler",
      /['"]guest-pii-retention-purge['"][\s\S]{0,80}guestPiiPurgeHandler/.test(workerSrc));
    assert('AC4: JOB_HANDLERS used with boss.work()',
      /JOB_HANDLERS/.test(workerSrc) && /boss\.work/.test(workerSrc));
    assert('AC4: stub fallback retained for other jobs',
      /\?\?/.test(workerSrc));
    assert('AC4: ai-token-cap-reset cron is "0 5 * * *" (00:00 ET)',
      /0 5 \* \* \*/.test(workerSrc));
    assert('AC4: guest-pii-retention-purge cron is "0 8 * * *" (03:00 ET)',
      /0 8 \* \* \*/.test(workerSrc));
  }

  // ── AC1 + AC2 (source): key implementation details ────────────────────────────
  console.log('\nAC1 + AC2 (source) — verify implementation details in maintenance.ts');
  {
    const src = fs.readFileSync(path.join(__dirname, 'maintenance.ts'), 'utf8');

    assert('AC1 src: accounts.updateMany used (no where = all accounts)',
      /accounts\.updateMany/.test(src));
    assert('AC1 src: daily_ai_token_usage set to 0',
      /daily_ai_token_usage:\s*0/.test(src));
    assert('AC1 src: ai_token_cap_reset_at set to new Date()',
      /ai_token_cap_reset_at:\s*new Date\(\)/.test(src));

    assert('AC2 src: 12-month retention window',
      /setMonth.*getMonth.*-\s*12|getMonth\(\)\s*-\s*12/.test(src));
    assert('AC2 src: checkout_datetime used as cutoff reference',
      /checkout_datetime/.test(src));
    assert('AC2 src: messages.deleteMany called',
      /messages\.deleteMany/.test(src));
    assert('AC2 src: bookings.updateMany called for PII clear',
      /bookings\.updateMany/.test(src));
    assert('AC2 src: guest_first_name redacted',
      /guest_first_name:\s*'\[redacted\]'/.test(src));
    assert('AC2 src: guest_last_name redacted',
      /guest_last_name:\s*'\[redacted\]'/.test(src));
    assert('AC2 src: guest_platform_id redacted',
      /guest_platform_id:\s*'\[redacted\]'/.test(src));
    assert('AC2 src: cutoff is runtime-calculated (no hardcoded date literal)',
      !/new Date\(['"]20[0-9]{2}/.test(src));
    assert('AC2 src: both handlers are exported',
      /export async function aiTokenCapResetHandler/.test(src) &&
      /export async function guestPiiPurgeHandler/.test(src));
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
