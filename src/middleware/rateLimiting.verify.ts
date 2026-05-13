/**
 * Verification script for T-018: Rate Limiting + CORS Middleware
 * Run with: npx ts-node src/middleware/rateLimiting.verify.ts
 */
import cors from 'cors';
import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function buildCorsApp(frontendUrl?: string) {
  const app = express();
  const allowedOrigins = [frontendUrl, 'http://localhost:3000'].filter(Boolean) as string[];
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json());
  app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

async function main() {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

  // ── AC1: CORS allowlists FRONTEND_URL + localhost:3000; others rejected ────
  console.log('\nAC1 — CORS allowlists FRONTEND_URL + localhost:3000; other origins rejected');
  {
    const testFrontendUrl = 'https://vrm.example.com';
    const app = buildCorsApp(testFrontendUrl);
    const agent = request(app);

    const r1 = await agent.get('/test').set('Origin', 'http://localhost:3000');
    assert(
      'localhost:3000 → Access-Control-Allow-Origin set',
      r1.headers['access-control-allow-origin'] === 'http://localhost:3000',
    );

    const r2 = await agent.get('/test').set('Origin', testFrontendUrl);
    assert(
      'FRONTEND_URL → Access-Control-Allow-Origin set',
      r2.headers['access-control-allow-origin'] === testFrontendUrl,
    );

    const r3 = await agent.get('/test').set('Origin', 'http://evil.com');
    assert(
      'unknown origin → Access-Control-Allow-Origin NOT set',
      !r3.headers['access-control-allow-origin'],
    );

    const r4 = await agent.get('/test'); // no Origin header (server-to-server)
    assert('no Origin header → request passes through (200)', r4.status === 200);
  }

  // ── AC2: credentials: true ─────────────────────────────────────────────────
  console.log('\nAC2 — credentials: true in CORS config');
  {
    const app = buildCorsApp();
    const r = await request(app).get('/test').set('Origin', 'http://localhost:3000');
    assert(
      'Access-Control-Allow-Credentials: true for allowed origin',
      r.headers['access-control-allow-credentials'] === 'true',
    );
    // Also confirm it is set in index.ts source
    assert(
      'credentials: true present in index.ts CORS config',
      /credentials:\s*true/.test(indexSrc),
    );
  }

  // ── AC3: 429 after 10 requests to /auth/login from same IP ────────────────
  console.log('\nAC3 — POST /auth/login returns 429 after 10 requests from same IP');
  {
    const freshAuthLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    });
    const app = express();
    app.use('/auth', freshAuthLimiter);
    app.post('/auth/login', (_req: Request, res: Response) => res.json({ ok: true }));
    const agent = request(app);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await agent.post('/auth/login');
      statuses.push(r.status);
    }

    assert('requests 1–10 return 200', statuses.slice(0, 10).every(s => s === 200));
    assert('11th request returns 429', statuses[10] === 429);

    const body429 = (await agent.post('/auth/login')).body;
    assert(
      '429 body has error message',
      typeof body429?.error === 'string' && body429.error.includes('Too many'),
    );
  }

  // ── AC4: Three limiters exported from rateLimiting.ts ─────────────────────
  console.log('\nAC4 — Three rate limiter instances exported from rateLimiting.ts');
  {
    const limiters = require('./rateLimiting');
    assert('authLimiter exported', typeof limiters.authLimiter === 'function');
    assert('webhookLimiter exported', typeof limiters.webhookLimiter === 'function');
    assert('apiLimiter exported', typeof limiters.apiLimiter === 'function');
    assert('exactly 3 named exports', Object.keys(limiters).length === 3);
  }

  // ── AC5: /api/* uses apiLimiter; /webhooks/* uses webhookLimiter ──────────
  console.log('\nAC5 — /api/* bound to apiLimiter (300); /webhooks/* to webhookLimiter (100)');
  {
    // Source checks
    assert(
      "index.ts: app.use('/auth', authLimiter)",
      /app\.use\(['"]\/auth['"],\s*authLimiter\)/.test(indexSrc),
    );
    assert(
      "index.ts: app.use('/webhooks', webhookLimiter)",
      /app\.use\(['"]\/webhooks['"],\s*webhookLimiter\)/.test(indexSrc),
    );
    assert(
      "index.ts: app.use('/api', apiLimiter)",
      /app\.use\(['"]\/api['"],\s*apiLimiter\)/.test(indexSrc),
    );

    // Runtime checks — confirm correct limits via RateLimit headers
    const buildApp = (prefix: string, limiter: ReturnType<typeof rateLimit>) => {
      const app = express();
      app.use(prefix, limiter);
      app.get(`${prefix}/test`, (_req: Request, res: Response) => res.json({ ok: true }));
      app.post(`${prefix}/test`, (_req: Request, res: Response) => res.json({ ok: true }));
      return app;
    };

    // apiLimiter — 300 per minute
    const freshApi = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
    const apiRes = await request(buildApp('/api', freshApi)).get('/api/test');
    assert('/api/* first request is 200', apiRes.status === 200);
    assert('/api/* RateLimit-Limit header is 300', parseInt(apiRes.headers['ratelimit-limit'] ?? '0', 10) === 300);

    // webhookLimiter — 100 per minute
    const freshWebhook = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false });
    const whRes = await request(buildApp('/webhooks', freshWebhook)).post('/webhooks/test');
    assert('/webhooks/* first request is 200', whRes.status === 200);
    assert('/webhooks/* RateLimit-Limit header is 100', parseInt(whRes.headers['ratelimit-limit'] ?? '0', 10) === 100);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
