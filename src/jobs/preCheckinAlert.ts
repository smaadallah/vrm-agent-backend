/**
 * T-044 — pre-checkin-alert-check Job
 *
 * Hourly sweep: warns the manager when a cleaning job is not complete and
 * the next guest's check-in is approaching or has already passed.
 *
 * Two alert variants (PRD Section 7.4, ISSUE-22 fix):
 *   Standard  — deadline >= NOW(): check-in approaching within window.
 *   Overdue   — deadline <  NOW(): check-in has already passed.
 *
 * Window comes from properties.pre_checkin_alert_minutes (default 30).
 * All template values come from the database — nothing is hardcoded.
 */

import { formatInTimeZone } from 'date-fns-tz';
import type { accounts, cleaners, cleaning_jobs, properties } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendManagerSms } from './workOrderCreation';

const EASTERN = 'America/New_York';

// ── Injectable hooks for testing ─────────────────────────────────────────────

export const _hooks = {
  now:     undefined as (() => Date) | undefined,
  smsSend: undefined as
    | ((to: string, from: string, body: string) => Promise<void>)
    | undefined,
};

function getNow(): Date {
  return _hooks.now ? _hooks.now() : new Date();
}

// ── Alert builders — PRD Section 7.4 (ISSUE-22 fix) ──────────────────────────

/**
 * Standard alert: cleaning not yet confirmed but deadline has not passed.
 * Fired when deadline >= NOW() and within pre_checkin_alert_minutes.
 */
export function buildStandardAlert(
  cleanerName:        string,
  propertyName:       string,
  nextCheckinEastern: string,
  businessName:       string,
): string {
  return (
    `ALERT: ${cleanerName} has not yet confirmed completion for ${propertyName}. ` +
    `Next guest checks in at ${nextCheckinEastern}. ` +
    `Please confirm the property is ready. - ${businessName}`
  );
}

/**
 * Overdue alert: check-in deadline has already passed, job still incomplete.
 * Fired when deadline < NOW().
 */
export function buildOverdueAlert(
  propertyName:       string,
  nextCheckinEastern: string,
  businessName:       string,
): string {
  return (
    `OVERDUE ALERT: Cleaning deadline has passed for ${propertyName}. ` +
    `Next guest check-in at ${nextCheckinEastern} is at risk. ` +
    `Please verify property status immediately. - ${businessName}`
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

type CleaningJobWithRelations = cleaning_jobs & {
  property: properties;
  account:  accounts;
  cleaner:  cleaners;
};

// ── Sweep handler ─────────────────────────────────────────────────────────────

/**
 * Hourly sweep. Broad query returns all incomplete jobs with a deadline that
 * haven't yet been alerted. Per-property window filtering happens in
 * application code because pre_checkin_alert_minutes varies per property.
 */
export async function preCheckinAlertHandler(): Promise<void> {
  const now = getNow();

  const candidates = await prisma.cleaning_jobs.findMany({
    where: {
      status:                 { in: ['scheduled', 'confirmed', 'no_response'] },
      next_booking_id:        { not: null },
      deadline:               { not: null },
      pre_checkin_alert_sent: false,
    },
    include: { property: true, account: true, cleaner: true },
  }) as CleaningJobWithRelations[];

  if (candidates.length === 0) {
    logger.info('pre-checkin-alert-check: no candidates');
    return;
  }

  logger.info({ count: candidates.length }, 'pre-checkin-alert-check: candidates found');

  for (const job of candidates) {
    const { property, account, cleaner } = job;
    const deadline = job.deadline!;

    // Per-property window: skip if deadline is still more than pre_checkin_alert_minutes away.
    const windowMs       = property.pre_checkin_alert_minutes * 60_000;
    const alertThreshold = new Date(now.getTime() + windowMs);

    if (deadline > alertThreshold) {
      logger.info(
        { jobId: job.id, deadline, alertThreshold },
        'pre-checkin-alert-check: outside alert window — skipping',
      );
      continue;
    }

    const isOverdue          = deadline < now;
    const nextCheckinEastern = formatInTimeZone(deadline, EASTERN, 'MMM d, yyyy h:mm a zzz');

    const alertText = isOverdue
      ? buildOverdueAlert(property.name, nextCheckinEastern, account.business_name)
      : buildStandardAlert(cleaner.name, property.name, nextCheckinEastern, account.business_name);

    logger.info(
      { jobId: job.id, isOverdue },
      `pre-checkin-alert-check: sending ${isOverdue ? 'overdue' : 'standard'} alert`,
    );

    // Rule 3 retry handled inside sendManagerSms. Never throws.
    await sendManagerSms(account, alertText, _hooks.smsSend ?? undefined).catch(
      (err: unknown) =>
        logger.error({ err, jobId: job.id }, 'pre-checkin-alert-check: alert send failed'),
    );

    // AC5: set flag regardless of send outcome so the alert is not repeated.
    await prisma.cleaning_jobs.update({
      where: { id: job.id },
      data:  { pre_checkin_alert_sent: true },
    });

    logger.info({ jobId: job.id }, 'pre-checkin-alert-check: pre_checkin_alert_sent flagged');
  }
}
