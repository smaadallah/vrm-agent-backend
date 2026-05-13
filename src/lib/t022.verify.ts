/**
 * Verification script for T-022: Webhook Endpoint Stubs — All 9 Routes with Signature Validation
 *
 * AC1  All 9 webhook routes exist and return 200 { received: true } with valid signature
 * AC2  Missing signature header → 401
 * AC3  Invalid (wrong) signature → 401
 * AC4  Signature validation uses timing-safe comparison (source check)
 * AC5  Airbnb routes use HMAC-SHA256 / X-Airbnb-Signature
 * AC6  VRBO routes use HMAC-SHA256 / X-Vrbo-Signature
 * AC7  Twilio routes use HMAC-SHA1 base64 / X-Twilio-Signature
 * AC8  Webhook routes receive raw body buffer (rawBody set before JSON parse)
 * AC9  webhooksRouter mounted in index.ts with webhookLimiter; before express.json()
 *
 * Run with: npx ts-node src/lib/t022.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import webhooksRouter from '../routes/webhooks';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

const backendRoot = path.join(__dirname, '..', '..');

// Build the same raw-body → JSON pipeline used in index.ts
function makeApp(): express.Express {
  const app = express();
  app.use('/webhooks',
    express.raw({ type: 'application/json' }),
    (req: Request, _res: Response, next: NextFunction) => {
      if (Buffer.isBuffer(req.body)) {
        (req as any).rawBody = req.body;
        try { req.body = JSON.parse(req.body.toString('utf8')); } catch { req.body = {}; }
      }
      next();
    },
    webhooksRouter,
  );
  return app;
}

// Helper: compute HMAC signature matching each provider's algorithm
function sign(
  algorithm: 'sha256' | 'sha1',
  secret: string,
  body: string,
  encoding: 'hex' | 'base64',
): string {
  return crypto.createHmac(algorithm, secret).update(Buffer.from(body)).digest(encoding);
}

const AIRBNB_SECRET = process.env.AIRBNB_WEBHOOK_SECRET!;
const VRBO_SECRET   = process.env.VRBO_WEBHOOK_SECRET!;
const TWILIO_SECRET = process.env.TWILIO_WEBHOOK_SECRET!;

const PAYLOAD = JSON.stringify({ event: 'test', data: {} });

const ROUTES: Array<{
  path: string;
  secretKey: string;
  headerName: string;
  algorithm: 'sha256' | 'sha1';
  encoding: 'hex' | 'base64';
}> = [
  { path: '/webhooks/airbnb/booking-update', secretKey: AIRBNB_SECRET, headerName: 'x-airbnb-signature', algorithm: 'sha256', encoding: 'hex' },
  { path: '/webhooks/airbnb/message',        secretKey: AIRBNB_SECRET, headerName: 'x-airbnb-signature', algorithm: 'sha256', encoding: 'hex' },
  { path: '/webhooks/airbnb/review',         secretKey: AIRBNB_SECRET, headerName: 'x-airbnb-signature', algorithm: 'sha256', encoding: 'hex' },
  { path: '/webhooks/vrbo/booking-update',   secretKey: VRBO_SECRET,   headerName: 'x-vrbo-signature',   algorithm: 'sha256', encoding: 'hex' },
  { path: '/webhooks/vrbo/message',          secretKey: VRBO_SECRET,   headerName: 'x-vrbo-signature',   algorithm: 'sha256', encoding: 'hex' },
  { path: '/webhooks/vrbo/review',           secretKey: VRBO_SECRET,   headerName: 'x-vrbo-signature',   algorithm: 'sha256', encoding: 'hex' },
  { path: '/webhooks/twilio/inbound-sms',    secretKey: TWILIO_SECRET, headerName: 'x-twilio-signature', algorithm: 'sha1',   encoding: 'base64' },
  { path: '/webhooks/twilio/status-callback',secretKey: TWILIO_SECRET, headerName: 'x-twilio-signature', algorithm: 'sha1',   encoding: 'base64' },
  { path: '/webhooks/twilio/opt-out',        secretKey: TWILIO_SECRET, headerName: 'x-twilio-signature', algorithm: 'sha1',   encoding: 'base64' },
];

(async () => {
  const app = makeApp();

  // ── AC1: all 9 routes return 200 with valid signature ─────────────────────
  console.log('\nAC1 — All 9 routes return 200 { received: true } with valid signature');
  for (const route of ROUTES) {
    const sig = sign(route.algorithm, route.secretKey, PAYLOAD, route.encoding);
    const r = await request(app)
      .post(route.path)
      .set('Content-Type', 'application/json')
      .set(route.headerName, sig)
      .send(PAYLOAD);
    assert(`${route.path} → 200`, r.status === 200);
    assert(`${route.path} → { received: true }`, r.body?.received === true);
  }

  // ── AC2: missing signature header → 401 ──────────────────────────────────
  console.log('\nAC2 — Missing signature header → 401');
  for (const route of ROUTES) {
    const r = await request(app)
      .post(route.path)
      .set('Content-Type', 'application/json')
      .send(PAYLOAD);
    assert(`${route.path} missing header → 401`, r.status === 401);
  }

  // ── AC3: wrong signature → 401 ────────────────────────────────────────────
  console.log('\nAC3 — Invalid signature → 401');
  for (const route of ROUTES) {
    const r = await request(app)
      .post(route.path)
      .set('Content-Type', 'application/json')
      .set(route.headerName, 'badsignature000000000000000000000000000000000000000000000000000000')
      .send(PAYLOAD);
    assert(`${route.path} bad sig → 401`, r.status === 401);
  }

  // ── AC4–AC8: source inspection ────────────────────────────────────────────
  console.log('\nAC4–AC8 — Source inspection');
  {
    const valSrc = fs.readFileSync(
      path.join(backendRoot, 'src', 'middleware', 'validateWebhookSignature.ts'), 'utf8',
    );
    assert('AC4 — timingSafeEqual used', /timingSafeEqual/.test(valSrc));
    assert('AC5 — Airbnb uses sha256 + x-airbnb-signature',
      /sha256/.test(valSrc) && /x-airbnb-signature/i.test(valSrc));
    assert('AC6 — VRBO uses sha256 + x-vrbo-signature',
      /sha256/.test(valSrc) && /x-vrbo-signature/i.test(valSrc));
    assert('AC7 — Twilio uses sha1 + base64 + x-twilio-signature',
      /sha1/.test(valSrc) && /base64/.test(valSrc) && /x-twilio-signature/i.test(valSrc));
    assert('AC4 — secrets read from env vars (not hardcoded)',
      /process\.env/.test(valSrc) && !/=\s*['"][0-9a-f]{20}/.test(valSrc));

    const webhookSrc = fs.readFileSync(
      path.join(backendRoot, 'src', 'routes', 'webhooks.ts'), 'utf8',
    );
    assert('all 9 routes defined in webhooks.ts',
      (webhookSrc.match(/router\.post\(/g) ?? []).length === 9);
    assert('all 3 Airbnb routes present',
      /airbnb\/booking-update/.test(webhookSrc) &&
      /airbnb\/message/.test(webhookSrc) &&
      /airbnb\/review/.test(webhookSrc));
    assert('all 3 VRBO routes present',
      /vrbo\/booking-update/.test(webhookSrc) &&
      /vrbo\/message/.test(webhookSrc) &&
      /vrbo\/review/.test(webhookSrc));
    assert('all 3 Twilio routes present',
      /twilio\/inbound-sms/.test(webhookSrc) &&
      /twilio\/status-callback/.test(webhookSrc) &&
      /twilio\/opt-out/.test(webhookSrc));

    const indexSrc = fs.readFileSync(
      path.join(backendRoot, 'src', 'index.ts'), 'utf8',
    );
    assert('AC9 — webhooksRouter imported in index.ts', /webhooksRouter/.test(indexSrc));
    assert('AC9 — webhookLimiter applied to /webhooks', /webhookLimiter/.test(indexSrc));
    assert('AC8/AC9 — express.raw() used for /webhooks', /express\.raw/.test(indexSrc));
    assert('AC8/AC9 — rawBody set before JSON parse', /rawBody/.test(indexSrc));
    // Webhooks must be mounted before express.json() — check order in source
    const rawIdx  = indexSrc.indexOf('express.raw');
    const jsonIdx = indexSrc.indexOf('app.use(express.json())');
    assert('AC9 — webhooks raw-body middleware appears before app.use(express.json())',
      rawIdx !== -1 && jsonIdx !== -1 && rawIdx < jsonIdx);
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
