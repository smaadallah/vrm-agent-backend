/**
 * T-037 — GET /api/account + PATCH /api/settings
 */

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

// E.164: + followed by a non-zero country digit, then 1–14 more digits
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const VALID_ALERT_CHANNELS = ['sms', 'email', 'both'] as const;
const VALID_TONES          = ['casual', 'professional', 'luxury'] as const;

// Sensitive fields never returned to the client
const SENSITIVE = [
  'password_hash',
  'password_reset_token',
  'password_reset_expires_at',
  'airbnb_access_token',
  'airbnb_refresh_token',
  'vrbo_access_token',
  'vrbo_refresh_token',
] as const;

function sanitize(account: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(account)) {
    if (!(SENSITIVE as readonly string[]).includes(k)) out[k] = v;
  }
  out.airbnb_connected = account.airbnb_access_token != null;
  out.vrbo_connected   = account.vrbo_access_token   != null;
  return out;
}

// ── GET /api/account ────────────────────────────────────────────────────────

export const accountRouter = Router();

accountRouter.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;

      const account = await prisma.accounts.findUnique({ where: { id: accountId } });
      if (!account) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      res.json({ data: sanitize(account as unknown as Record<string, unknown>) });
    } catch (err) {
      logger.error({ err }, 'GET /api/account error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── PATCH /api/settings ─────────────────────────────────────────────────────

export const settingsRouter = Router();

settingsRouter.patch(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const body = req.body ?? {};

      const updateData: Record<string, unknown> = {};

      // Scalar field updates
      if (body.business_name !== undefined) updateData.business_name = body.business_name;
      if (body.manager_email !== undefined) updateData.manager_email = body.manager_email;

      if (body.manager_phone !== undefined) {
        if (!E164_REGEX.test(body.manager_phone)) {
          res.status(400).json({
            error: 'manager_phone must be in E.164 format (e.g. +13055550001)',
          });
          return;
        }
        updateData.manager_phone = body.manager_phone;
      }

      if (body.alert_channel !== undefined) {
        if (!(VALID_ALERT_CHANNELS as readonly string[]).includes(body.alert_channel)) {
          res.status(400).json({
            error: `alert_channel must be one of: ${VALID_ALERT_CHANNELS.join(', ')}`,
          });
          return;
        }
        updateData.alert_channel = body.alert_channel;
      }

      if (body.communication_tone !== undefined) {
        if (!(VALID_TONES as readonly string[]).includes(body.communication_tone)) {
          res.status(400).json({
            error: `communication_tone must be one of: ${VALID_TONES.join(', ')}`,
          });
          return;
        }
        updateData.communication_tone = body.communication_tone;
      }

      // OAuth disconnections — each increments token_version
      let tokenVersionIncrement = 0;

      if (body.disconnect_airbnb === true) {
        updateData.airbnb_access_token  = null;
        updateData.airbnb_refresh_token = null;
        tokenVersionIncrement++;
      }

      if (body.disconnect_vrbo === true) {
        updateData.vrbo_access_token  = null;
        updateData.vrbo_refresh_token = null;
        tokenVersionIncrement++;
      }

      if (tokenVersionIncrement > 0) {
        updateData.token_version = { increment: tokenVersionIncrement };
      }

      if (Object.keys(updateData).length === 0) {
        res.json({ data: { updated: false } });
        return;
      }

      const updated = await prisma.accounts.update({
        where: { id: accountId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data:  updateData as any,
      });

      res.json({ data: sanitize(updated as unknown as Record<string, unknown>) });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/settings error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);
