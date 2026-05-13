import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';
dotenv.config();

import { PgBoss } from 'pg-boss';
import logger from './lib/logger';
import { aiTokenCapResetHandler, guestPiiPurgeHandler } from './jobs/maintenance';
import {
  processAirbnbBookingHandler,
  processVrboBookingHandler,
  bookingSyncSweepHandler,
} from './jobs/bookingSync';
import { bookingActivationSweepHandler } from './jobs/bookingActivation';
import { processAirbnbMessageHandler, processVrboMessageHandler } from './jobs/inquiryResponse';
import { checkinMessageSweepHandler } from './jobs/checkinMessage';
import { checkoutReminderSweepHandler } from './jobs/checkoutReminder';
import { reviewRequestSweepHandler } from './jobs/reviewRequest';
import {
  checkoutDetectionSweepHandler,
  processAirbnbCheckoutHandler,
  processVrboCheckoutHandler,
} from './jobs/checkoutDetection';
import { preCheckinAlertHandler } from './jobs/preCheckinAlert';
import { cleanerNoResponseHandler } from './jobs/cleanerNoResponse';
import { processTwilioSmsHandler } from './jobs/twilioSms';
import {
  processAirbnbReviewHandler,
  processVrboReviewHandler,
} from './jobs/reviewResponseDraft';
import { initBoss } from './lib/boss';

const JOBS: Array<{ name: string; cron: string }> = [
  { name: 'checkin-message-sweep',      cron: '0 * * * *' },
  { name: 'checkout-reminder-sweep',    cron: '0 * * * *' },
  { name: 'review-request-sweep',       cron: '0 * * * *' },
  { name: 'cleaner-no-response-check',  cron: '0 * * * *' },
  { name: 'pre-checkin-alert-check',    cron: '0 * * * *' },
  { name: 'checkout-detection-sweep',   cron: '0 * * * *' },
  { name: 'booking-activation-sweep',   cron: '0 * * * *' },
  { name: 'booking-sync-sweep',         cron: '0 * * * *' },
  { name: 'ai-token-cap-reset',         cron: '0 5 * * *' },  // 00:00 ET
  { name: 'guest-pii-retention-purge',  cron: '0 8 * * *' },  // 03:00 ET
];

// Named handlers replace the generic stub for scheduled jobs.
const JOB_HANDLERS: Record<string, () => Promise<void>> = {
  'ai-token-cap-reset':        aiTokenCapResetHandler,
  'guest-pii-retention-purge': guestPiiPurgeHandler,
  'booking-sync-sweep':        bookingSyncSweepHandler,
  'booking-activation-sweep':  bookingActivationSweepHandler,
  'checkin-message-sweep':     checkinMessageSweepHandler,
  'checkout-reminder-sweep':    checkoutReminderSweepHandler,
  'review-request-sweep':       reviewRequestSweepHandler,
  'cleaner-no-response-check':  cleanerNoResponseHandler,
  'checkout-detection-sweep':   checkoutDetectionSweepHandler,
  'pre-checkin-alert-check':    preCheckinAlertHandler,
};

// Ad-hoc webhook-triggered jobs — queued by the API server, worked here.
const WEBHOOK_JOBS: Array<{ name: string; handler: (job: { data: unknown }) => Promise<void> }> = [
  { name: 'process-airbnb-booking', handler: processAirbnbBookingHandler },
  { name: 'process-vrbo-booking',   handler: processVrboBookingHandler },
  { name: 'process-airbnb-message',   handler: processAirbnbMessageHandler },
  { name: 'process-vrbo-message',     handler: processVrboMessageHandler },
  { name: 'process-airbnb-checkout',  handler: processAirbnbCheckoutHandler },
  { name: 'process-vrbo-checkout',    handler: processVrboCheckoutHandler },
  { name: 'process-twilio-sms',         handler: processTwilioSmsHandler },
  { name: 'process-airbnb-review',      handler: processAirbnbReviewHandler },
  { name: 'process-vrbo-review',        handler: processVrboReviewHandler },
];

export async function startWorker(): Promise<PgBoss> {
  const boss = new PgBoss(process.env.DATABASE_URL!);

  boss.on('error', (err: Error) => {
    logger.error({ err }, 'pg-boss error');
    Sentry.captureException(err);
  });

  await boss.start();
  initBoss(boss);
  logger.info('pg-boss started');

  for (const { name, cron } of JOBS) {
    await boss.createQueue(name);
    await boss.schedule(name, cron);
    const stub = async () => { logger.info(`Job ${name} fired`); };
    const handler = JOB_HANDLERS[name] ?? stub;
    await boss.work(name, handler);
    logger.debug({ job: name, cron }, 'job registered');
  }

  logger.info({ count: JOBS.length }, 'scheduled jobs registered');

  for (const { name, handler } of WEBHOOK_JOBS) {
    await boss.createQueue(name);
    // pg-boss v12 passes Job<T>[] batches; each Job has .data — iterate and dispatch one at a time
    await boss.work(name, async (jobs) => {
      for (const job of jobs) {
        await handler(job as { data: unknown });
      }
    });
    logger.debug({ job: name }, 'webhook job registered');
  }

  logger.info({ count: WEBHOOK_JOBS.length }, 'webhook jobs registered');
  return boss;
}

// Run directly when invoked as a script
if (require.main === module) {
  startWorker().catch((err: Error) => {
    logger.error({ err }, 'worker startup failed');
    Sentry.captureException(err);
    process.exit(1);
  });
}
