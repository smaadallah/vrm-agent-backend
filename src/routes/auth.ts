import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Dummy hash used when account is not found — prevents timing-based user enumeration.
// Pre-computed: bcrypt.hashSync('__dummy__', 10)
const DUMMY_HASH = '$2b$10$eiqBla5LMl4PChLBBAbWTOCnGGEqzUdDf2wJHsHOuSuCLqz1SRFpu';

// POST /auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const account = await prisma.accounts.findFirst({
      where: { manager_email: email },
      select: { id: true, password_hash: true, token_version: true },
    });

    const hash = account?.password_hash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hash);

    if (!account || !valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { accountId: account.id, tokenVersion: account.token_version },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' },
    );

    res.json({ token });
  } catch (err) {
    logger.error({ err }, 'login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body ?? {};

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  try {
    const account = await prisma.accounts.findFirst({
      where: { manager_email: email },
      select: { id: true },
    });

    if (account) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.accounts.update({
        where: { id: account.id },
        data: {
          password_reset_token: tokenHash,
          password_reset_expires_at: expiresAt,
        },
      });

      // Email delivery is handled by a future service integration.
      // Log the raw token so it is accessible in development/testing.
      logger.info({ accountId: account.id, resetToken: rawToken }, 'password reset token generated');
    }
  } catch (err) {
    logger.error({ err }, 'forgot-password error');
  }

  // Always 200 — never reveal whether the email is registered
  res.status(200).json({ message: 'If that email is registered, a reset link has been sent.' });
});

// POST /auth/reset-password
router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  const { token, newPassword } = req.body ?? {};

  if (!token || !newPassword) {
    res.status(400).json({ error: 'token and newPassword are required' });
    return;
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const account = await prisma.accounts.findFirst({
      where: {
        password_reset_token: tokenHash,
        password_reset_expires_at: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!account) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.accounts.update({
      where: { id: account.id },
      data: {
        password_hash: passwordHash,
        token_version: { increment: 1 },
        password_reset_token: null,
        password_reset_expires_at: null,
      },
    });

    logger.info({ accountId: account.id }, 'password reset successful');
    res.status(200).json({ message: 'Password has been reset successfully.' });
  } catch (err) {
    logger.error({ err }, 'reset-password error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/logout
router.post('/logout', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await prisma.accounts.update({
      where: { id: req.accountId! },
      data: { token_version: { increment: 1 } },
    });
    res.status(204).send();
  } catch (err) {
    logger.error({ err }, 'logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
