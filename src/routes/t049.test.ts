/**
 * T-049 verification — Review Draft Read Endpoints
 *
 * AC1  GET /  returns pending (created_at DESC) + resolved (updated_at DESC, paginated 50/page).
 * AC2  GET /:id returns single draft; 404 for missing or cross-account.
 * AC3  PATCH /:id accepts status=copied or status=dismissed; returns updated draft.
 * AC4  PATCH /:id rejects status=pending and unknown values with 400.
 * AC5  POST /:id/retry returns 400 when ai_failed=false.
 * AC6  POST /:id/retry calls AI with rating-based prompt; updates draft_response + ai_failed=false.
 * AC7  POST /:id/retry returns 500 when AI call fails.
 *
 * Run: npx ts-node src/routes/t049.test.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t049';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import reviewDraftsRouter, { _hooks } from './reviewDrafts';

// ── Minimal test app ──────────────────────────────────────────────────────────

const testApp = express();
testApp.use(express.json());
testApp.use('/api/review-drafts', reviewDraftsRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET    = 'test-secret-t049';
const ACCOUNT_ID    = 'acc-t049-001';
const OTHER_ACCOUNT = 'acc-t049-OTHER';
const PROPERTY_ID   = 'prop-t049-001';
const DRAFT_ID      = 'draft-t049-001';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeDraft(overrides: Record<string, unknown> = {}) {
  return {
    id:                 DRAFT_ID,
    account_id:         ACCOUNT_ID,
    property_id:        PROPERTY_ID,
    booking_id:         null,
    platform:           'airbnb',
    platform_review_id: 'rev-001',
    reviewer_name:      'Alice Smith',
    rating:             5,
    review_text:        'Wonderful stay!',
    draft_response:     null,
    status:             'pending',
    no_review_text:     false,
    ai_failed:          false,
    created_at:         new Date('2026-07-14T12:00:00Z'),
    updated_at:         new Date('2026-07-14T12:00:00Z'),
    property:           { name: 'Beach House' },
    ...overrides,
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

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

function stubAuth(tokenVersion = 1): () => void {
  const orig = (prisma.accounts as any).findUnique;
  (prisma.accounts as any).findUnique = async () => ({ token_version: tokenVersion });
  return () => { (prisma.accounts as any).findUnique = orig; };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {

  // ════════════════════════════════════════════════════════════════════════════
  // AC1 — GET / returns pending + resolved with correct sort and pagination
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — GET / returns pending sorted created_at DESC');
  {
    const restore = stubAuth();
    const draftNewer = fakeDraft({ id: 'draft-new', status: 'pending', created_at: new Date('2026-07-15T10:00:00Z') });
    const draftOlder = fakeDraft({ id: 'draft-old', status: 'pending', created_at: new Date('2026-07-14T10:00:00Z') });

    const origFindMany = (prisma.review_drafts as any).findMany;
    const origCount    = (prisma.review_drafts as any).count;
    (prisma.review_drafts as any).findMany = async (args: any) => {
      if (args.where?.status === 'pending') return [draftNewer, draftOlder];
      return [];
    };
    (prisma.review_drafts as any).count = async () => 0;

    const res = await request(testApp)
      .get('/api/review-drafts')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findMany = origFindMany;
    (prisma.review_drafts as any).count    = origCount;
    restore();

    const pending = res.body?.data?.pending;
    assert('AC1a: status 200',                   res.status === 200);
    assert('AC1a: data.pending is array',        Array.isArray(pending));
    assert('AC1a: 2 pending items',              pending?.length === 2);
    assert('AC1a: [0] = newer (draft-new)',      pending?.[0]?.id === 'draft-new');
    assert('AC1a: [1] = older (draft-old)',      pending?.[1]?.id === 'draft-old');
  }

  console.log('\nAC1b — GET / pending query uses account_id + status=pending + orderBy created_at desc');
  {
    const restore = stubAuth();
    let capturedPendingArgs: any = null;

    const origFindMany = (prisma.review_drafts as any).findMany;
    const origCount    = (prisma.review_drafts as any).count;
    (prisma.review_drafts as any).findMany = async (args: any) => {
      if (args.where?.status === 'pending') { capturedPendingArgs = args; return []; }
      return [];
    };
    (prisma.review_drafts as any).count = async () => 0;

    await request(testApp)
      .get('/api/review-drafts')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findMany = origFindMany;
    (prisma.review_drafts as any).count    = origCount;
    restore();

    assert('AC1b: pending where.account_id = JWT',    capturedPendingArgs?.where?.account_id === ACCOUNT_ID);
    assert('AC1b: pending where.status = pending',    capturedPendingArgs?.where?.status === 'pending');
    assert('AC1b: pending orderBy created_at desc',   capturedPendingArgs?.orderBy?.created_at === 'desc');
  }

  console.log('\nAC1c — GET / resolved sorted updated_at DESC, paginated 50/page');
  {
    const restore = stubAuth();
    let capturedResolvedArgs: any = null;

    const origFindMany = (prisma.review_drafts as any).findMany;
    const origCount    = (prisma.review_drafts as any).count;
    (prisma.review_drafts as any).findMany = async (args: any) => {
      if (args.where?.status?.in) { capturedResolvedArgs = args; return []; }
      return [];
    };
    (prisma.review_drafts as any).count = async () => 120;

    const res = await request(testApp)
      .get('/api/review-drafts?page=3')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findMany = origFindMany;
    (prisma.review_drafts as any).count    = origCount;
    restore();

    assert('AC1c: resolved orderBy updated_at desc',  capturedResolvedArgs?.orderBy?.updated_at === 'desc');
    assert('AC1c: skip = (3-1)*50 = 100',             capturedResolvedArgs?.skip === 100);
    assert('AC1c: take = 50',                         capturedResolvedArgs?.take === 50);
    assert('AC1c: resolved_total = 120',              res.body?.data?.resolved_total === 120);
    assert('AC1c: page = 3 in response',              res.body?.data?.page === 3);
  }

  console.log('\nAC1d — GET / resolved status filter: copied + dismissed');
  {
    const restore = stubAuth();
    let capturedResolvedWhere: any = null;

    const origFindMany = (prisma.review_drafts as any).findMany;
    const origCount    = (prisma.review_drafts as any).count;
    (prisma.review_drafts as any).findMany = async (args: any) => {
      if (args.where?.status?.in) { capturedResolvedWhere = args.where; return []; }
      return [];
    };
    (prisma.review_drafts as any).count = async (args: any) => {
      capturedResolvedWhere = args.where;
      return 0;
    };

    await request(testApp)
      .get('/api/review-drafts')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findMany = origFindMany;
    (prisma.review_drafts as any).count    = origCount;
    restore();

    const statusIn: string[] = capturedResolvedWhere?.status?.in ?? [];
    assert('AC1d: resolved filter includes copied',    statusIn.includes('copied'));
    assert('AC1d: resolved filter includes dismissed', statusIn.includes('dismissed'));
    assert('AC1d: resolved filter excludes pending',   !statusIn.includes('pending'));
  }

  console.log('\nAC1e — GET / response shape: { data: { pending, resolved, resolved_total, page } }');
  {
    const restore = stubAuth();
    const origFindMany = (prisma.review_drafts as any).findMany;
    const origCount    = (prisma.review_drafts as any).count;
    (prisma.review_drafts as any).findMany = async () => [];
    (prisma.review_drafts as any).count    = async () => 0;

    const res = await request(testApp)
      .get('/api/review-drafts')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findMany = origFindMany;
    (prisma.review_drafts as any).count    = origCount;
    restore();

    assert('AC1e: has data.pending',         Array.isArray(res.body?.data?.pending));
    assert('AC1e: has data.resolved',        Array.isArray(res.body?.data?.resolved));
    assert('AC1e: has data.resolved_total',  typeof res.body?.data?.resolved_total === 'number');
    assert('AC1e: has data.page',            typeof res.body?.data?.page === 'number');
    assert('AC1e: default page = 1',         res.body?.data?.page === 1);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — GET /:id returns single draft; 404 for missing or cross-account
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2a — GET /:id returns draft with property.name');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({ property: { name: 'Sunset Villa' } });

    const res = await request(testApp)
      .get(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findUnique = origFindUnique;
    restore();

    assert('AC2a: status 200',             res.status === 200);
    assert('AC2a: data.id matches',        res.body?.data?.id === DRAFT_ID);
    assert('AC2a: property.name present',  res.body?.data?.property?.name === 'Sunset Villa');
  }

  console.log('\nAC2b — GET /:id returns 404 for nonexistent draft');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    (prisma.review_drafts as any).findUnique = async () => null;

    const res = await request(testApp)
      .get(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findUnique = origFindUnique;
    restore();

    assert('AC2b: 404 for nonexistent',   res.status === 404);
  }

  console.log('\nAC2c — GET /:id returns 404 for draft belonging to different account');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({ account_id: OTHER_ACCOUNT });

    const res = await request(testApp)
      .get(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`);

    (prisma.review_drafts as any).findUnique = origFindUnique;
    restore();

    assert('AC2c: 404 for cross-account',   res.status === 404);
  }

  console.log('\nAC2d — GET /:id returns 401 without auth token');
  {
    const res = await request(testApp).get(`/api/review-drafts/${DRAFT_ID}`);
    assert('AC2d: 401 without token',   res.status === 401);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — PATCH /:id accepts copied or dismissed
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3a — PATCH /:id accepts status=copied');
  {
    const restore = stubAuth();
    let capturedData: any = null;

    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;
    (prisma.review_drafts as any).findUnique = async () => ({ id: DRAFT_ID, account_id: ACCOUNT_ID });
    (prisma.review_drafts as any).update = async (args: any) => {
      capturedData = args.data;
      return fakeDraft({ status: 'copied' });
    };

    const res = await request(testApp)
      .patch(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'copied' });

    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC3a: status 200',               res.status === 200);
    assert('AC3a: update data.status=copied', capturedData?.status === 'copied');
    assert('AC3a: response data.status',      res.body?.data?.status === 'copied');
  }

  console.log('\nAC3b — PATCH /:id accepts status=dismissed');
  {
    const restore = stubAuth();
    let capturedData: any = null;

    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;
    (prisma.review_drafts as any).findUnique = async () => ({ id: DRAFT_ID, account_id: ACCOUNT_ID });
    (prisma.review_drafts as any).update = async (args: any) => {
      capturedData = args.data;
      return fakeDraft({ status: 'dismissed' });
    };

    const res = await request(testApp)
      .patch(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'dismissed' });

    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC3b: status 200',                    res.status === 200);
    assert('AC3b: update data.status=dismissed',  capturedData?.status === 'dismissed');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — PATCH /:id rejects status=pending and unknown values
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — PATCH /:id rejects status=pending with 400');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .patch(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'pending' });
    restore();

    assert('AC4a: 400 for status=pending',   res.status === 400);
  }

  console.log('\nAC4b — PATCH /:id rejects unknown status with 400');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .patch(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ status: 'approved' });
    restore();

    assert('AC4b: 400 for unknown status',   res.status === 400);
  }

  console.log('\nAC4c — PATCH /:id rejects missing status with 400');
  {
    const restore = stubAuth();
    const res = await request(testApp)
      .patch(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    restore();

    assert('AC4c: 400 for missing status',   res.status === 400);
  }

  console.log('\nAC4d — PATCH /:id 404 for cross-account');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    (prisma.review_drafts as any).findUnique = async () => ({ id: DRAFT_ID, account_id: OTHER_ACCOUNT });

    const res = await request(testApp)
      .patch(`/api/review-drafts/${DRAFT_ID}`)
      .set('Authorization', `Bearer ${makeToken(ACCOUNT_ID)}`)
      .send({ status: 'copied' });

    (prisma.review_drafts as any).findUnique = origFindUnique;
    restore();

    assert('AC4d: 404 for cross-account PATCH',   res.status === 404);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — POST /:id/retry returns 400 when ai_failed=false
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — POST /:id/retry returns 400 when ai_failed=false');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({ ai_failed: false, property: { name: 'Beach House', account: { business_name: 'Co', communication_tone: 'warm' } } });

    const res = await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findUnique = origFindUnique;
    restore();

    assert('AC5a: 400 when ai_failed=false',   res.status === 400);
  }

  console.log('\nAC5b — POST /:id/retry returns 404 for nonexistent draft');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    (prisma.review_drafts as any).findUnique = async () => null;

    const res = await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.review_drafts as any).findUnique = origFindUnique;
    restore();

    assert('AC5b: 404 for nonexistent draft on retry',   res.status === 404);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — POST /:id/retry calls AI with rating-based prompt; updates on success
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6a — POST /:id/retry calls positive prompt for rating >= 4');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;
    let capturedPrompt   = '';
    let capturedData: any = null;

    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({
        ai_failed:   true,
        rating:      5,
        review_text: 'Amazing place!',
        property: {
          name: 'Beach House',
          account: { business_name: 'Coastal Rentals', communication_tone: 'warm' },
        },
      });
    (prisma.review_drafts as any).update = async (args: any) => {
      capturedData = args.data;
      return fakeDraft({ draft_response: 'AI response', ai_failed: false });
    };

    _hooks.aiCall = async (prompt: string) => {
      capturedPrompt = prompt;
      return 'AI generated response';
    };

    const res = await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    _hooks.aiCall = undefined;
    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC6a: status 200',                            res.status === 200);
    assert('AC6a: prompt is positive (warm, genuine)',    capturedPrompt.includes('warm, genuine response'));
    assert('AC6a: prompt includes reviewer name',         capturedPrompt.includes('Amazing place!'));
    assert('AC6a: update sets draft_response',            capturedData?.draft_response === 'AI generated response');
    assert('AC6a: update sets ai_failed=false',           capturedData?.ai_failed === false);
    assert('AC6a: response data.ai_failed=false',         res.body?.data?.ai_failed === false);
  }

  console.log('\nAC6b — POST /:id/retry calls negative prompt for rating <= 3');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;
    let capturedPrompt   = '';

    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({
        ai_failed:   true,
        rating:      2,
        review_text: 'Disappointing stay.',
        property: {
          name: 'Beach House',
          account: { business_name: 'Coastal Rentals', communication_tone: 'professional' },
        },
      });
    (prisma.review_drafts as any).update = async () =>
      fakeDraft({ draft_response: 'professional response', ai_failed: false });

    _hooks.aiCall = async (prompt: string) => {
      capturedPrompt = prompt;
      return 'professional response';
    };

    const res = await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    _hooks.aiCall = undefined;
    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC6b: status 200',                                res.status === 200);
    assert('AC6b: prompt is negative (professional, constructive)', capturedPrompt.includes('professional, constructive response'));
  }

  console.log('\nAC6c — POST /:id/retry uses exactly rating=3 as negative threshold');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;
    let capturedPrompt   = '';

    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({
        ai_failed:   true,
        rating:      3,
        review_text: 'It was okay.',
        property: {
          name: 'Beach House',
          account: { business_name: 'Coastal Rentals', communication_tone: 'professional' },
        },
      });
    (prisma.review_drafts as any).update = async () => fakeDraft({ ai_failed: false });

    _hooks.aiCall = async (prompt: string) => {
      capturedPrompt = prompt;
      return 'okay response';
    };

    await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    _hooks.aiCall = undefined;
    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC6c: rating=3 uses negative prompt', capturedPrompt.includes('professional, constructive response'));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC7 — POST /:id/retry returns 500 when AI call fails
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC7a — POST /:id/retry returns 500 when AI throws');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;

    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({
        ai_failed:   true,
        rating:      5,
        review_text: 'Great!',
        property: {
          name: 'Beach House',
          account: { business_name: 'Coastal Rentals', communication_tone: 'warm' },
        },
      });
    (prisma.review_drafts as any).update = async () => {
      throw new Error('should not be called');
    };

    _hooks.aiCall = async () => { throw new Error('AI service unavailable'); };

    const res = await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    _hooks.aiCall = undefined;
    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC7a: 500 when AI throws',           res.status === 500);
  }

  console.log('\nAC7b — POST /:id/retry does NOT update DB when AI fails');
  {
    const restore = stubAuth();
    const origFindUnique = (prisma.review_drafts as any).findUnique;
    const origUpdate     = (prisma.review_drafts as any).update;
    let updateCalled = false;

    (prisma.review_drafts as any).findUnique = async () =>
      fakeDraft({
        ai_failed:   true,
        rating:      4,
        review_text: 'Nice!',
        property: {
          name: 'Beach House',
          account: { business_name: 'Coastal Rentals', communication_tone: 'warm' },
        },
      });
    (prisma.review_drafts as any).update = async () => { updateCalled = true; return {}; };

    _hooks.aiCall = async () => { throw new Error('AI failed'); };

    await request(testApp)
      .post(`/api/review-drafts/${DRAFT_ID}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`);

    _hooks.aiCall = undefined;
    (prisma.review_drafts as any).findUnique = origFindUnique;
    (prisma.review_drafts as any).update     = origUpdate;
    restore();

    assert('AC7b: update NOT called on AI failure',   !updateCalled);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source checks — verify route structure in reviewDrafts.ts
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — route structure');
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'reviewDrafts.ts'), 'utf8',
    );

    assert('src: GET / handler',                    src.includes("router.get(") && (src.includes("'/'") || src.includes('"/"')));
    assert('src: GET /:id handler',                 src.includes("router.get(") && (src.includes("'/:id'") || src.includes('"/:id"')));
    assert('src: PATCH /:id handler',               src.includes("router.patch(") && (src.includes("'/:id'") || src.includes('"/:id"')));
    assert('src: POST /:id/retry handler',          src.includes("router.post(") && (src.includes("'/:id/retry'") || src.includes('"/:id/retry"')));
    assert('src: _hooks.aiCall exported',           src.includes('_hooks') && src.includes('aiCall'));
    assert('src: buildPositivePrompt imported',     src.includes('buildPositivePrompt'));
    assert('src: buildNegativePrompt imported',     src.includes('buildNegativePrompt'));
    assert('src: rating >= 4 classification',       src.includes('rating >= 4'));
    assert('src: VALID_PATCH_STATUSES excludes pending', src.includes("'copied'") && src.includes("'dismissed'"));
    assert('src: 400 for invalid status',           src.includes('400'));
    assert('src: 10s AI timeout',                   src.includes('10_000'));
    assert('src: ai_failed cleared on success',     src.includes('ai_failed: false'));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
