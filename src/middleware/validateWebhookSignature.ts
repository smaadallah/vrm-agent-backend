import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

function timingSafeCompare(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function makeValidator(
  secretEnvKey: string,
  headerName: string,
  algorithm: string,
  encoding: crypto.BinaryToTextEncoding,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env[secretEnvKey];
    if (!secret) {
      res.status(401).json({ error: 'Webhook not configured' });
      return;
    }

    const sig = req.headers[headerName] as string | undefined;
    if (!sig) {
      res.status(401).json({ error: 'Missing webhook signature' });
      return;
    }

    const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const expected = crypto.createHmac(algorithm, secret).update(body).digest(encoding);

    if (!timingSafeCompare(sig, expected)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    next();
  };
}

// Airbnb: HMAC-SHA256 hex in X-Airbnb-Signature
export const verifyAirbnbSignature = makeValidator(
  'AIRBNB_WEBHOOK_SECRET', 'x-airbnb-signature', 'sha256', 'hex',
);

// VRBO: HMAC-SHA256 hex in X-Vrbo-Signature
export const verifyVrboSignature = makeValidator(
  'VRBO_WEBHOOK_SECRET', 'x-vrbo-signature', 'sha256', 'hex',
);

// Twilio: HMAC-SHA1 base64 in X-Twilio-Signature
export const verifyTwilioSignature = makeValidator(
  'TWILIO_WEBHOOK_SECRET', 'x-twilio-signature', 'sha1', 'base64',
);
