/**
 * T-032 — PATCH /api/messages/:id — Manager Reply via Platform API
 * T-033 — GET /api/messages — Message log with status filters and pagination
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

const router = Router();

const MAX_REPLY_LENGTH = 2000;

// Injectable overrides — set in tests to avoid real I/O and eliminate 60s sleep.
export const _hooks = {
  platformSend: undefined as
    | ((platform: string, guestId: string, text: string) => Promise<void>)
    | undefined,
  retryDelayMs: 60_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function defaultPlatformSend(
  platform: string,
  guestPlatformId: string,
  text: string,
): Promise<void> {
  // Real Airbnb/VRBO API client implemented in T-027.
  logger.info(
    { platform, guestPlatformId, textLength: text.length },
    'platform message send (stub — T-027 implements)',
  );
}

// Sends with one Rule-3 retry. Throws on permanent failure.
async function sendWithRetry(
  platform: string,
  guestId: string,
  text: string,
): Promise<void> {
  const send = _hooks.platformSend ?? defaultPlatformSend;

  try {
    await send(platform, guestId, text);
  } catch (firstErr) {
    logger.warn({ err: firstErr }, 'platform send failed — retrying (Rule 3)');
    await sleep(_hooks.retryDelayMs);
    await send(platform, guestId, text);  // throws to caller on second failure
  }
}

// GET /api/messages
router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { status, booking_id, property_id, page, limit } = req.query;

      const pageNum  = Math.max(1, parseInt(String(page  ?? '1'),  10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(String(limit ?? '50'), 10) || 50));
      const skip     = (pageNum - 1) * limitNum;

      const where: Record<string, unknown> = { account_id: accountId };

      if (status) {
        const statuses = String(status).split(',').map(s => s.trim()).filter(Boolean);
        where.status = { in: statuses };
      }
      if (booking_id)  where.booking_id  = String(booking_id);
      if (property_id) where.property_id = String(property_id);

      // When filtering a single thread, show oldest first; otherwise newest first.
      const orderBy = booking_id
        ? { sent_at: 'asc' as const }
        : { created_at: 'desc' as const };

      const rows = await prisma.messages.findMany({
        where,
        orderBy,
        skip,
        take: limitNum,
        select: {
          id:                    true,
          account_id:            true,
          property_id:           true,
          booking_id:            true,
          platform_message_id:   true,
          direction:             true,
          channel:               true,
          sender:                true,
          content:               true,
          intent_classification: true,
          status:                true,
          is_urgent:             true,
          escalation_reason:     true,
          maintenance_triggered: true,
          sent_at:               true,
          created_at:            true,
          property: { select: { name: true } },
          booking:  { select: { guest_first_name: true, guest_last_name: true } },
        },
      });

      // Promote guest names to the top level; drop the nested booking sub-object.
      const messages = rows.map(({ booking, ...msg }) => ({
        ...msg,
        guest_first_name: booking?.guest_first_name ?? null,
        guest_last_name:  booking?.guest_last_name  ?? null,
      }));

      res.json({ data: messages, page: pageNum, limit: limitNum });
    } catch (err) {
      logger.error({ err }, 'GET /api/messages error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PATCH /api/messages/:id
router.patch(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { reply_text } = req.body ?? {};

    // Validate reply_text
    if (typeof reply_text !== 'string' || reply_text.trim().length === 0) {
      res.status(400).json({ error: 'reply_text is required' });
      return;
    }

    if (reply_text.length > MAX_REPLY_LENGTH) {
      res.status(400).json({
        error: `reply_text must be ${MAX_REPLY_LENGTH} characters or fewer`,
      });
      return;
    }

    try {
      // Look up source message and its booking for platform routing
      const sourceMsg = await prisma.messages.findUnique({
        where: { id },
        include: { booking: true },
      });

      if (!sourceMsg || sourceMsg.account_id !== req.accountId) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      // Deliver via platform API (Rule 3 retry)
      try {
        await sendWithRetry(
          sourceMsg.booking.platform,
          sourceMsg.booking.guest_platform_id,
          reply_text,
        );
      } catch (sendErr) {
        logger.error(
          { err: sendErr, messageId: id },
          'platform send permanently failed — no messages row inserted',
        );
        res.status(500).json({ error: 'Failed to deliver message via platform API' });
        return;
      }

      // Insert outbound messages row
      await prisma.messages.create({
        data: {
          account_id:          sourceMsg.account_id,
          property_id:         sourceMsg.property_id,
          booking_id:          sourceMsg.booking_id,
          platform_message_id: `mgr-${crypto.randomUUID()}`,
          direction:           'outbound',
          channel:             sourceMsg.channel,
          sender:              'manager',
          content:             reply_text,
          status:              'manager_handled',
          sent_at:             new Date(),
        },
      });

      // Update source message status
      await prisma.messages.update({
        where: { id },
        data:  { status: 'manager_handled' },
      });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err, messageId: id }, 'PATCH /api/messages/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
