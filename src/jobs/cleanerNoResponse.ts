/**
 * T-043 — Feature 2.5 — Cleaner No-Response Check (PRD Section 7.6)
 *
 * CRITICAL FIX (ISSUE-04): Without this, the 'no_response' status transition
 * never fires.
 *
 * Hourly sweep. Queries cleaning_jobs where status = 'scheduled',
 * job_notification_sent = true, cleaner_confirmed_at IS NULL,
 * no_response_alert_sent = false. Per-property window filtering is done in
 * application code because cleaner_confirmation_window_minutes varies per
 * property. Atomic raw-SQL UPDATE prevents double-transition.
 */

import { formatInTimeZone } from 'date-fns-tz';
import type { accounts, bookings, cleaners, cleaning_jobs, properties } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendManagerSms } from './workOrderCreation';

const EASTERN = 'America/New_York';

// ── Injectable hooks for testing ──────────────────────────────────────────────

export const _hooks = {
  now:     undefined as (() => Date) | undefined,
  smsSend: undefined as
    | ((to: string, from: string, body: string) => Promise<void>)
    | undefined,
};

function getNow(): Date {
  return _hooks.now ? _hooks.now() : new Date();
}

// ── Alert builder — PRD Section 7.6 ──────────────────────────────────────────

export function buildNoResponseAlert({
  cleanerName,
  cleanerPhone,
  propertyName,
  checkoutTimeEastern,
  businessName,
}: {
  cleanerName:         string;
  cleanerPhone:        string;
  propertyName:        string;
  checkoutTimeEastern: string;
  businessName:        string;
}): string {
  return (
    `NO RESPONSE: ${cleanerName} has not confirmed the turnover job at ${propertyName}.\n` +
    `Guest checkout was ${checkoutTimeEastern}.\n` +
    `Please contact ${cleanerName} directly at ${cleanerPhone}, or assign a replacement ` +
    `and close the job manually in the dashboard.\n` +
    `- ${businessName}`
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type CleaningJobWithRelations = cleaning_jobs & {
  property: properties;
  account:  accounts;
  cleaner:  cleaners;
  booking:  Pick<bookings, 'checkout_datetime'>;
};

// ── Sweep handler ─────────────────────────────────────────────────────────────

export async function cleanerNoResponseHandler(): Promise<void> {
  const now = getNow();

  const candidates = await prisma.cleaning_jobs.findMany({
    where: {
      status:                 'scheduled',
      job_notification_sent:  true,
      cleaner_confirmed_at:   null,
      no_response_alert_sent: false,
    },
    include: {
      property: true,
      account:  true,
      cleaner:  true,
      booking:  { select: { checkout_datetime: true } },
    },
  }) as CleaningJobWithRelations[];

  if (candidates.length === 0) {
    logger.info('cleaner-no-response-check: no candidates');
    return;
  }

  logger.info({ count: candidates.length }, 'cleaner-no-response-check: candidates found');

  for (const job of candidates) {
    const { property, account, cleaner, booking } = job;

    // Per-property window: skip if notification was sent less than
    // cleaner_confirmation_window_minutes ago (window varies per property).
    const windowMs = property.cleaner_confirmation_window_minutes * 60_000;
    const cutoff   = new Date(now.getTime() - windowMs);

    if (!job.job_notification_sent_at || job.job_notification_sent_at > cutoff) {
      logger.info(
        { jobId: job.id, sentAt: job.job_notification_sent_at, cutoff },
        'cleaner-no-response-check: still within confirmation window — skipping',
      );
      continue;
    }

    // CRITICAL: Atomic conditional UPDATE prevents double-transition.
    // Do NOT replace with Prisma ORM — atomicity would be lost.
    const affected = await prisma.$executeRaw`
      UPDATE cleaning_jobs SET status = 'no_response' WHERE id = ${job.id} AND status = 'scheduled'
    `;

    if (Number(affected) === 0) {
      logger.info({ jobId: job.id }, 'cleaner-no-response-check: already transitioned — skipping');
      continue;
    }

    logger.info({ jobId: job.id }, 'cleaner-no-response-check: transitioned to no_response');

    const checkoutTimeEastern = formatInTimeZone(
      booking.checkout_datetime,
      EASTERN,
      'MMM d, yyyy h:mm a zzz',
    );

    const alertText = buildNoResponseAlert({
      cleanerName:         cleaner.name,
      cleanerPhone:        cleaner.phone,
      propertyName:        property.name,
      checkoutTimeEastern,
      businessName:        account.business_name,
    });

    // Rule 3 retry handled inside sendManagerSms.
    await sendManagerSms(account, alertText, _hooks.smsSend ?? undefined).catch((err: unknown) =>
      logger.error({ err, jobId: job.id }, 'cleaner-no-response-check: alert send failed'),
    );

    // Set flag regardless of send outcome to prevent repeated alerts.
    await prisma.cleaning_jobs.update({
      where: { id: job.id },
      data:  { no_response_alert_sent: true },
    });

    logger.info({ jobId: job.id }, 'cleaner-no-response-check: no_response_alert_sent flagged');
  }
}
