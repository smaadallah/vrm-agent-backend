import { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}

export function accountIsolationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.accountId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // If a route param names an account, it must match the JWT-derived accountId.
  // Covers both :accountId and :account_id param naming conventions.
  const paramId = req.params['accountId'] ?? req.params['account_id'];
  if (paramId !== undefined && paramId !== req.accountId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}
