import { Router, Request, Response } from 'express';
import logger from '../lib/logger';
import { getBoss } from '../lib/boss';
import {
  verifyAirbnbSignature,
  verifyVrboSignature,
  verifyTwilioSignature,
} from '../middleware/validateWebhookSignature';

const router = Router();

// ── Airbnb webhooks ───────────────────────────────────────────────────────────

// POST /webhooks/airbnb/booking-update — booking created / modified / cancelled
router.post('/airbnb/booking-update', verifyAirbnbSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'airbnb booking-update received');
  try {
    const boss = await getBoss();
    await boss.send('process-airbnb-booking', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-airbnb-booking');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/airbnb/message — inbound guest message
router.post('/airbnb/message', verifyAirbnbSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'airbnb message received');
  try {
    const boss = await getBoss();
    await boss.send('process-airbnb-message', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-airbnb-message');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/airbnb/checkout — guest has checked out; dispatch cleaner
router.post('/airbnb/checkout', verifyAirbnbSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'airbnb checkout received');
  try {
    const boss = await getBoss();
    await boss.send('process-airbnb-checkout', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-airbnb-checkout');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/airbnb/review — guest review posted
router.post('/airbnb/review', verifyAirbnbSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'airbnb review received');
  try {
    const boss = await getBoss();
    await boss.send('process-airbnb-review', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-airbnb-review');
  }
  res.status(200).json({ received: true });
});

// ── VRBO webhooks ─────────────────────────────────────────────────────────────

// POST /webhooks/vrbo/booking-update — booking created / modified / cancelled
router.post('/vrbo/booking-update', verifyVrboSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'vrbo booking-update received');
  try {
    const boss = await getBoss();
    await boss.send('process-vrbo-booking', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-vrbo-booking');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/vrbo/message — inbound guest message
router.post('/vrbo/message', verifyVrboSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'vrbo message received');
  try {
    const boss = await getBoss();
    await boss.send('process-vrbo-message', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-vrbo-message');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/vrbo/checkout — guest has checked out; dispatch cleaner
router.post('/vrbo/checkout', verifyVrboSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'vrbo checkout received');
  try {
    const boss = await getBoss();
    await boss.send('process-vrbo-checkout', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-vrbo-checkout');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/vrbo/review — guest review posted
router.post('/vrbo/review', verifyVrboSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'vrbo review received');
  try {
    const boss = await getBoss();
    await boss.send('process-vrbo-review', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-vrbo-review');
  }
  res.status(200).json({ received: true });
});

// ── Twilio webhooks ───────────────────────────────────────────────────────────

// POST /webhooks/twilio/inbound-sms — cleaner or guest SMS reply
router.post('/twilio/inbound-sms', verifyTwilioSignature, async (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'twilio inbound-sms received');
  try {
    const boss = await getBoss();
    await boss.send('process-twilio-sms', req.body);
  } catch (err) {
    logger.error({ err }, 'failed to enqueue process-twilio-sms');
  }
  res.status(200).json({ received: true });
});

// POST /webhooks/twilio/status-callback — SMS delivery status update
router.post('/twilio/status-callback', verifyTwilioSignature, (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'twilio status-callback received');
  res.status(200).json({ received: true });
});

// POST /webhooks/twilio/opt-out — STOP / UNSTOP handling
router.post('/twilio/opt-out', verifyTwilioSignature, (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'twilio opt-out received');
  res.status(200).json({ received: true });
});

export default router;
