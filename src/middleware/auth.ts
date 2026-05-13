import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}

interface JwtPayload {
  accountId: string;
  tokenVersion: number;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = header.slice(7);
  let payload: JwtPayload;

  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const account = await prisma.accounts.findUnique({
      where: { id: payload.accountId },
      select: { token_version: true },
    });

    if (!account || account.token_version !== payload.tokenVersion) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    req.accountId = payload.accountId;
    next();
  } catch (err) {
    logger.error({ err }, 'auth middleware db error');
    res.status(401).json({ error: 'Unauthorized' });
  }
}
