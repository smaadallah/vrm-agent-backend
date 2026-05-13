/**
 * T-049 — Review Draft Read Endpoints
 *
 * GET    /api/review-drafts           → pending (created_at DESC) + resolved paginated
 * GET    /api/review-drafts/:id       → single draft with account isolation
 * PATCH  /api/review-drafts/:id       → update status to copied or dismissed only
 * POST   /api/review-drafts/:id/retry → re-run AI if ai_failed=true
 */

import Anthropic from '@anthropic-ai/sdk';
import { Router, Request, Response } from 'express';
import { ReviewDraftStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';
import { buildPositivePrompt, buildNegativePrompt } from '../jobs/reviewResponseDraft';

const router = Router();

export const _hooks: {
  aiCall: ((prompt: string) => Promise<string>) | undefined;
} = { aiCall: undefined };

const RESOLVED_PAGE_SIZE    = 50;
const VALID_PATCH_STATUSES: ReviewDraftStatus[] = ['copied', 'dismissed'];

// ── Default AI call ────────────────────────────────────────────────────────────

async function defaultAiCall(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const anthropic = new Anthropic({ apiKey });
  const response  = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages:   [{ role: 'user', content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected AI response type');
  return block.text.trim();
}

// ── GET /api/review-drafts ─────────────────────────────────────────────────────

router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const page      = Math.max(1, parseInt(req.query.page as string) || 1);
      const include   = { property: { select: { name: true } } };

      const [pending, resolved, resolved_total] = await Promise.all([
        prisma.review_drafts.findMany({
          where:   { account_id: accountId, status: 'pending' },
          include,
          orderBy: { created_at: 'desc' },
        }),
        prisma.review_drafts.findMany({
          where:   { account_id: accountId, status: { in: ['copied', 'dismissed'] } },
          include,
          orderBy: { updated_at: 'desc' },
          skip:    (page - 1) * RESOLVED_PAGE_SIZE,
          take:    RESOLVED_PAGE_SIZE,
        }),
        prisma.review_drafts.count({
          where: { account_id: accountId, status: { in: ['copied', 'dismissed'] } },
        }),
      ]);

      res.json({ data: { pending, resolved, resolved_total, page } });
    } catch (err) {
      logger.error({ err }, 'GET /api/review-drafts error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── GET /api/review-drafts/:id ─────────────────────────────────────────────────

router.get(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id }    = req.params;

      const draft = await prisma.review_drafts.findUnique({
        where:   { id },
        include: { property: { select: { name: true } } },
      });

      if (!draft || draft.account_id !== accountId) {
        res.status(404).json({ error: 'Review draft not found' });
        return;
      }

      res.json({ data: draft });
    } catch (err) {
      logger.error({ err }, 'GET /api/review-drafts/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── PATCH /api/review-drafts/:id ──────────────────────────────────────────────

router.patch(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId   = req.accountId!;
      const { id }      = req.params;
      const { status }  = req.body ?? {};

      if (!status || !VALID_PATCH_STATUSES.includes(status as ReviewDraftStatus)) {
        res.status(400).json({ error: 'status must be copied or dismissed' });
        return;
      }

      const existing = await prisma.review_drafts.findUnique({
        where:  { id },
        select: { id: true, account_id: true },
      });

      if (!existing || existing.account_id !== accountId) {
        res.status(404).json({ error: 'Review draft not found' });
        return;
      }

      const updated = await prisma.review_drafts.update({
        where: { id },
        data:  { status: status as ReviewDraftStatus },
      });

      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/review-drafts/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── POST /api/review-drafts/:id/retry ─────────────────────────────────────────

router.post(
  '/:id/retry',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id }    = req.params;

      const draft = await prisma.review_drafts.findUnique({
        where:   { id },
        include: { property: { include: { account: true } } },
      });

      if (!draft || draft.account_id !== accountId) {
        res.status(404).json({ error: 'Review draft not found' });
        return;
      }

      if (!draft.ai_failed) {
        res.status(400).json({ error: 'AI draft generation has not failed for this review' });
        return;
      }

      const { property } = draft as typeof draft & {
        property: { name: string; account: { business_name: string; communication_tone: string } };
      };

      const aiPrompt = draft.rating >= 4
        ? buildPositivePrompt(
            property.account.business_name,
            property.account.communication_tone,
            property.name,
            draft.reviewer_name,
            draft.rating,
            draft.review_text!,
          )
        : buildNegativePrompt(
            property.account.business_name,
            property.account.communication_tone,
            property.name,
            draft.reviewer_name,
            draft.rating,
            draft.review_text!,
          );

      const callFn = _hooks.aiCall ?? defaultAiCall;

      let newDraftText: string;
      try {
        newDraftText = await Promise.race([
          callFn(aiPrompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('AI retry timeout')), 10_000),
          ),
        ]);
      } catch (err) {
        logger.warn({ err }, 'AI review draft retry failed');
        res.status(500).json({ error: 'AI generation failed' });
        return;
      }

      const updated = await prisma.review_drafts.update({
        where: { id },
        data:  { draft_response: newDraftText, ai_failed: false },
      });

      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'POST /api/review-drafts/:id/retry error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
