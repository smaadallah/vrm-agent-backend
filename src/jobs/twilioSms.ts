/**
 * T-038 — Twilio SMS Inbound Router (PRD Section 7.1)
 * T-040 — Feature 2.2 — Turnover Checklist Delivery (PRD Section 7.3)
 * T-041 — Feature 2.3 — Completion Confirmation / DONE Handler (PRD Section 7.4)
 *
 * Deduplicates by MessageSid, looks up cleaner by phone, applies multi-job
 * guard, then routes to confirmHandler / doneHandler / lowHandler.
 * lowHandler stub is replaced in T-042.
 */

import twilio from 'twilio';
import type { accounts } from '@prisma/client';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendManagerSms } from './workOrderCreation';

// ── Shared job shape used across handler stubs ────────────────────────────────

export type OpenJob = {
  id:               string;
  inbound_sms_sids: string[];
  property:         { name: string };
};

// ── Injectable hooks for testing ──────────────────────────────────────────────

export const _hooks = {
  smsSend:        undefined as ((to: string, from: string, body: string) => Promise<void>) | undefined,
  retryDelayMs:   undefined as number | undefined,
  confirmHandler: undefined as ((job: OpenJob) => Promise<void>) | undefined,
  doneHandler:    undefined as ((job: OpenJob, body: string) => Promise<void>) | undefined,
  lowHandler:     undefined as ((job: OpenJob, items: string) => Promise<void>) | undefined,
};

// ── Rule 3 SMS helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function defaultSendSms(to: string, from: string, body: string): Promise<void> {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    logger.warn('twilioSms: Twilio credentials not set');
    return;
  }

  const client = twilio(sid, token);
  await client.messages.create({ body, from, to });
}

async function sendCleanerSmsWithRetry(
  account: accounts,
  cleanerPhone: string,
  body: string,
): Promise<void> {
  if (!account.twilio_phone_number) {
    logger.warn({ accountId: account.id }, 'twilioSms: Twilio phone not configured');
    return;
  }

  const send    = _hooks.smsSend    ?? defaultSendSms;
  const delayMs = _hooks.retryDelayMs ?? 60_000;

  try {
    await send(cleanerPhone, account.twilio_phone_number, body);
  } catch (firstErr) {
    logger.warn({ err: firstErr }, 'twilioSms: cleaner SMS failed — retrying (Rule 3)');
    await sleep(delayMs);
    // Throws on second failure; caller handles permanent failure
    await send(cleanerPhone, account.twilio_phone_number, body);
  }
}

// ── confirmHandler — Feature 2.2 (PRD Section 7.3) ───────────────────────────

export async function confirmHandler(job: OpenJob): Promise<void> {
  const cleaningJob = await prisma.cleaning_jobs.findUnique({
    where:   { id: job.id },
    include: {
      cleaner:  { select: { phone: true, name: true } },
      account:  true,
      property: { select: { name: true } },
    },
  });

  if (!cleaningJob) {
    logger.warn({ jobId: job.id }, 'twilioSms: confirmHandler: job not found');
    return;
  }

  // Already confirmed + checklist sent → duplicate discard
  if (cleaningJob.status === 'confirmed' && cleaningJob.checklist_sent) {
    logger.info({ jobId: job.id }, 'twilioSms: confirmHandler: duplicate CONFIRM — discarding');
    return;
  }

  // Only process scheduled or no_response jobs
  if (cleaningJob.status !== 'scheduled' && cleaningJob.status !== 'no_response') {
    logger.warn(
      { jobId: job.id, status: cleaningJob.status },
      'twilioSms: confirmHandler: invalid status — discarding',
    );
    return;
  }

  // Step 1: Confirm the job
  await prisma.cleaning_jobs.update({
    where: { id: job.id },
    data:  { status: 'confirmed', cleaner_confirmed_at: new Date() },
  });

  // Step 2: Look up turnover checklist for this property
  const checklist = await prisma.turnover_checklists.findFirst({
    where:  { property_id: cleaningJob.property_id },
    select: { checklist_body: true },
  });

  if (!checklist || !checklist.checklist_body.trim()) {
    logger.warn({ jobId: job.id }, 'twilioSms: confirmHandler: no checklist configured — skipping send');
    const alertText =
      `CHECKLIST NOT CONFIGURED: ${cleaningJob.cleaner.name} confirmed the turnover job at ` +
      `${cleaningJob.property.name} but no checklist has been set up. ` +
      `Please add a checklist in the dashboard. - ${cleaningJob.account.business_name}`;
    await sendManagerSms(cleaningJob.account, alertText).catch((err: unknown) =>
      logger.error({ err }, 'twilioSms: confirmHandler: manager alert failed'),
    );
    return;
  }

  // Step 3: Send checklist to cleaner with Rule 3
  try {
    await sendCleanerSmsWithRetry(cleaningJob.account, cleaningJob.cleaner.phone, checklist.checklist_body);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'twilioSms: confirmHandler: checklist SMS permanently failed');
    const failureAlert =
      `SEND FAILURE: Could not send checklist to ${cleaningJob.cleaner.name} for ` +
      `${cleaningJob.property.name}. Please send it manually. - ${cleaningJob.account.business_name}`;
    await sendManagerSms(cleaningJob.account, failureAlert).catch((smsErr: unknown) =>
      logger.error({ err: smsErr }, 'twilioSms: confirmHandler: failure alert also failed'),
    );
    return;
  }

  // Step 4: Flag checklist sent
  await prisma.cleaning_jobs.update({
    where: { id: job.id },
    data:  { checklist_sent: true, checklist_sent_at: new Date() },
  });

  logger.info({ jobId: job.id }, 'twilioSms: confirmHandler: checklist sent successfully');
}

// ── Damage detection — Feature 2.3 (PRD Section 7.4) ─────────────────────────

const DAMAGE_KEYWORDS = [
  'broken', 'damaged', 'cracked', 'shattered',
  'not working', "doesn't work", "won't work",
  'leak', 'leaking', 'flooded', 'flooding',
  'stain', 'stained', 'burn', 'burned',
  'torn', 'missing', 'hole',
];

function stripDoneAndLow(body: string): string {
  let s = body.replace(/^done[,.\s]*/i, '').trim();
  const lowIdx = s.toLowerCase().indexOf('low:');
  if (lowIdx !== -1) s = s.slice(0, lowIdx).trim();
  return s;
}

function detectDamage(body: string): boolean {
  const target = stripDoneAndLow(body).toLowerCase();
  return DAMAGE_KEYWORDS.some(kw => target.includes(kw));
}

// ── doneHandler — Feature 2.3 (PRD Section 7.4) ──────────────────────────────

export async function doneHandler(job: OpenJob, body: string): Promise<void> {
  const cleaningJob = await prisma.cleaning_jobs.findUnique({
    where:   { id: job.id },
    include: {
      cleaner:  { select: { phone: true, name: true } },
      account:  true,
      property: { select: { name: true, id: true } },
    },
  });

  if (!cleaningJob) {
    logger.warn({ jobId: job.id }, 'twilioSms: doneHandler: job not found');
    return;
  }

  // Completed → discard silently; other invalid statuses → discard with warn
  if (cleaningJob.status === 'completed') {
    logger.info({ jobId: job.id }, 'twilioSms: doneHandler: already completed — discarding');
    return;
  }
  if (cleaningJob.status !== 'scheduled' && cleaningJob.status !== 'confirmed') {
    logger.warn(
      { jobId: job.id, status: cleaningJob.status },
      'twilioSms: doneHandler: invalid status — discarding',
    );
    return;
  }

  // Scan for damage keywords BEFORE the DB write so we can include the flag
  // atomically in the same UPDATE statement (PRD Section 7.4 ISSUE-29 fix).
  const hasDamage = detectDamage(body);

  // ⚠️ CRITICAL: damage_fyi_sent = true is included in THIS update call —
  // the same statement that sets status = 'completed'. It must never be a
  // separate call. If the FYI alert send later fails, the flag stays true.
  await prisma.cleaning_jobs.update({
    where: { id: job.id },
    data: {
      status:             'completed',
      completed_at:       new Date(),
      closed_by:          'cleaner_sms',
      completion_sms_raw: body,
      ...(hasDamage ? { damage_fyi_sent: true } : {}),
    },
  });

  // Mark property guest-ready
  await prisma.properties.update({
    where: { id: cleaningJob.property_id },
    data:  { property_status: 'guest_ready' },
  });

  // Send damage FYI to manager — failure is logged but does NOT revert the flag
  if (hasDamage) {
    const fiyText =
      `DAMAGE REPORT: ${cleaningJob.cleaner.name} reported possible damage at ` +
      `${cleaningJob.property.name}. Review in the VRM Agent dashboard. ` +
      `- ${cleaningJob.account.business_name}`;
    await sendManagerSms(cleaningJob.account, fiyText).catch((err: unknown) =>
      logger.error({ err, jobId: job.id }, 'twilioSms: doneHandler: damage FYI alert failed'),
    );
  }

  // Call lowHandler if 'low:' is present in the body
  const lowerBody = body.toLowerCase();
  const lowIdx    = lowerBody.indexOf('low:');
  if (lowIdx !== -1) {
    const items = body.slice(lowIdx + 4).trim();
    const low   = _hooks.lowHandler ?? lowHandler;
    await low(job, items);
  }

  // Send completion ack to cleaner (Rule 3)
  const ackText =
    `Thanks ${cleaningJob.cleaner.name}, the job at ${cleaningJob.property.name} ` +
    `has been marked complete. - ${cleaningJob.account.business_name}`;
  try {
    await sendCleanerSmsWithRetry(cleaningJob.account, cleaningJob.cleaner.phone, ackText);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'twilioSms: doneHandler: completion ack permanently failed');
  }

  // Send manager completion notification
  const managerText =
    `COMPLETED: ${cleaningJob.cleaner.name} completed the turnover at ` +
    `${cleaningJob.property.name}. Property is now guest ready. ` +
    `- ${cleaningJob.account.business_name}`;
  await sendManagerSms(cleaningJob.account, managerText).catch((err: unknown) =>
    logger.error({ err, jobId: job.id }, 'twilioSms: doneHandler: manager notification failed'),
  );

  logger.info({ jobId: job.id }, 'twilioSms: doneHandler: completion processed');
}

// ── lowHandler — Feature 2.4 (PRD Section 7.5) ───────────────────────────────

export async function lowHandler(job: OpenJob, items: string): Promise<void> {
  const cleaningJob = await prisma.cleaning_jobs.findUnique({
    where:   { id: job.id },
    include: {
      cleaner:  { select: { name: true, phone: true } },
      account:  true,
      property: { select: { name: true } },
    },
  });

  if (!cleaningJob) {
    logger.warn({ jobId: job.id }, 'twilioSms: lowHandler: job not found');
    return;
  }

  // Parse: split on comma, trim, discard empty, normalize to lowercase
  const parsed = items
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);

  // 0 items → generic alert; supply_alert_sent = true regardless of send outcome
  if (parsed.length === 0) {
    const genericText =
      `SUPPLY ALERT: ${cleaningJob.cleaner.name} at ${cleaningJob.property.name} ` +
      `reported supplies running low but did not specify items. ` +
      `Please check with them directly. - ${cleaningJob.account.business_name}`;
    await sendManagerSms(cleaningJob.account, genericText).catch((err: unknown) =>
      logger.error({ err, jobId: job.id }, 'twilioSms: lowHandler: generic alert failed'),
    );
    await prisma.cleaning_jobs.update({
      where: { id: job.id },
      data:  { supply_alert_sent: true },
    });
    logger.info({ jobId: job.id }, 'twilioSms: lowHandler: generic supply alert sent (0 items)');
    return;
  }

  // Merge into existing supply_flags, deduplicating by lowercase match
  const existing = (cleaningJob.supply_flags ?? []).map(s => s.toLowerCase());
  const merged   = [...existing];
  for (const item of parsed) {
    if (!merged.includes(item)) merged.push(item);
  }

  await prisma.cleaning_jobs.update({
    where: { id: job.id },
    data:  { supply_flags: merged },
  });

  // Build alert and send via alert_channel (Rule 3 applied inside sendManagerSms)
  const alertText =
    `SUPPLY ALERT: ${cleaningJob.cleaner.name} at ${cleaningJob.property.name} ` +
    `reported items running low: ${merged.join(', ')}. ` +
    `Please restock before the next guest. - ${cleaningJob.account.business_name}`;

  try {
    await sendManagerSms(cleaningJob.account, alertText);
    await prisma.cleaning_jobs.update({
      where: { id: job.id },
      data:  { supply_alert_sent: true, supply_alert_sent_at: new Date() },
    });
    logger.info({ jobId: job.id }, 'twilioSms: lowHandler: supply alert sent');
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'twilioSms: lowHandler: supply alert permanently failed');
    await prisma.cleaning_jobs.update({
      where: { id: job.id },
      data:  { supply_alert_permanently_failed: true },
    }).catch((updateErr: unknown) =>
      logger.error({ err: updateErr, jobId: job.id }, 'twilioSms: lowHandler: failed to flag permanently_failed'),
    );
  }
}

// ── Multi-job alert template (PRD Section 7.1) ────────────────────────────────

function buildMultiJobAlert({
  cleanerName,
  cleanerPhone,
  openJobCount,
  propertyList,
  businessName,
}: {
  cleanerName:  string;
  cleanerPhone: string;
  openJobCount: number;
  propertyList: string;
  businessName: string;
}): string {
  return (
    `MULTI-JOB CONFLICT: ${cleanerName} (${cleanerPhone}) replied to a turnover SMS ` +
    `but has ${openJobCount} open jobs: ${propertyList}\n` +
    `Their reply could not be auto-routed. Please contact them directly and close the ` +
    `correct job manually in the dashboard.\n` +
    `- ${businessName}`
  );
}

// ── Twilio payload shape ──────────────────────────────────────────────────────

type TwilioSmsPayload = {
  MessageSid: string;
  From:       string;
  Body:       string;
};

// ── Main handler ──────────────────────────────────────────────────────────────

export async function processTwilioSmsHandler(job: { data: unknown }): Promise<void> {
  const { MessageSid, From, Body } = job.data as TwilioSmsPayload;

  // ── Step 1: Deduplication via inbound_sms_sids ────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const duplicate = await prisma.cleaning_jobs.findFirst({
    where: {
      created_at:       { gte: sevenDaysAgo },
      inbound_sms_sids: { has: MessageSid },
    },
    select: { id: true },
  });

  if (duplicate) {
    logger.info({ MessageSid }, 'twilioSms: duplicate MessageSid — discarding');
    return;
  }

  // ── Step 2: Cleaner lookup by phone ──────────────────────────────────────
  const cleaner = await prisma.cleaners.findFirst({
    where:  { phone: From, is_active: true },
    select: { id: true, name: true, phone: true, account_id: true },
  });

  if (!cleaner) {
    logger.warn({ From }, 'twilioSms: unknown phone — discarding');
    return;
  }

  // ── Step 3: Open jobs for this cleaner ───────────────────────────────────
  const openJobs = await prisma.cleaning_jobs.findMany({
    where: {
      cleaner_id: cleaner.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status:     { in: ['scheduled', 'confirmed', 'no_response'] as any },
    },
    select: {
      id:               true,
      inbound_sms_sids: true,
      property:         { select: { name: true } },
    },
  });

  // ── Step 4: Multi-job guard (> 1 open job) ────────────────────────────────
  if (openJobs.length > 1) {
    await prisma.cleaning_jobs.update({
      where: { id: openJobs[0].id },
      data:  { inbound_sms_sids: { push: MessageSid } },
    });

    const account = await prisma.accounts.findUnique({
      where: { id: cleaner.account_id },
    });

    if (account) {
      const propertyList = openJobs.map(j => j.property.name).join(', ');
      const alertText = buildMultiJobAlert({
        cleanerName:  cleaner.name,
        cleanerPhone: cleaner.phone,
        openJobCount: openJobs.length,
        propertyList,
        businessName: account.business_name,
      });

      await sendManagerSms(account as accounts, alertText).catch((err: unknown) =>
        logger.error({ err }, 'twilioSms: multi-job manager alert failed'),
      );
    }

    return;
  }

  // ── Step 5: 0 open jobs — orphaned SMS ───────────────────────────────────
  if (openJobs.length === 0) {
    logger.warn({ From, MessageSid }, 'twilioSms: orphaned SMS — no open jobs for cleaner');
    return;
  }

  // ── Step 6: 1 open job — append MessageSid and route ─────────────────────
  const openJob = openJobs[0] as OpenJob;

  await prisma.cleaning_jobs.update({
    where: { id: openJob.id },
    data:  { inbound_sms_sids: { push: MessageSid } },
  });

  const normalized = Body.trim().toLowerCase();

  const confirm = _hooks.confirmHandler ?? confirmHandler;
  const done    = _hooks.doneHandler    ?? doneHandler;
  const low     = _hooks.lowHandler     ?? lowHandler;

  if (normalized === 'confirm' || normalized.startsWith('confirm ') || normalized.startsWith('confirm,')) {
    await confirm(openJob);
  } else if (normalized === 'done' || normalized.startsWith('done ') || normalized.startsWith('done,')) {
    await done(openJob, Body);
  } else if (normalized.startsWith('low:')) {
    const items = Body.trim().slice(4).trim();
    await low(openJob, items);
  } else {
    logger.warn({ Body, cleanerId: cleaner.id }, 'twilioSms: unrecognized body — discarding');
  }
}
