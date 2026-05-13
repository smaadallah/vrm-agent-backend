/**
 * T-048 — Review Response Draft Worker tests
 *
 * AC1  process-airbnb-review and process-vrbo-review registered in worker.ts.
 * AC2  Duplicate platform_review_id -> discarded.
 * AC3  Empty review_text -> static fallback, no_review_text=true, no AI call.
 * AC4  rating >= 4 -> positive prompt used.
 * AC5  rating <= 3 (including exactly 3) -> negative/neutral prompt used.
 * AC6  AI failure -> draft_response = null, ai_failed = true.
 * AC7  review_drafts row inserted with status = "pending".
 * AC8  Manager notification sent via alert_channel using DB values.
 */

import * as fs   from 'fs';
import * as path from 'path';

import prisma from '../lib/prisma';
import {
  processAirbnbReviewHandler,
  processVrboReviewHandler,
  buildStaticFallback,
  buildManagerNotification,
  _hooks,
} from './reviewResponseDraft';

// ── Prisma mock ───────────────────────────────────────────────────────────────

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    review_drafts: {
      findUnique: jest.fn(),
      create:     jest.fn(),
    },
    properties: {
      findFirst: jest.fn(),
    },
  },
}));

const mockFindUnique = (prisma.review_drafts as any).findUnique as jest.Mock;
const mockFindFirst  = (prisma.properties  as any).findFirst  as jest.Mock;
const mockCreate     = (prisma.review_drafts as any).create   as jest.Mock;

// ── Base fixtures ─────────────────────────────────────────────────────────────

const BASE_ACCOUNT = {
  id:                  'acc-t048-001',
  business_name:       'Lakeside Rentals',
  manager_phone:       '+15550001111',
  twilio_phone_number: '+15550002222',
  alert_channel:       'sms',
  communication_tone:  'professional',
  manager_email:       'mgr@lakeside.com',
};

const BASE_PROPERTY = {
  id:                 'prop-t048-001',
  account_id:         'acc-t048-001',
  name:               'Sunset Villa',
  airbnb_listing_id:  'bnb-listing-001',
  vrbo_listing_id:    'vrbo-listing-001',
  account:            BASE_ACCOUNT,
};

function makeJob(overrides: Record<string, unknown> = {}): { data: unknown } {
  return {
    data: {
      platform_review_id: 'rev-t048-001',
      listing_id:         'bnb-listing-001',
      reviewer_name:      'Alice Smith',
      rating:             5,
      review_text:        'Amazing stay! Spotless and beautifully decorated.',
      ...overrides,
    },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('T-048 — Review Response Draft Worker', () => {

  let mockSmsSend: jest.Mock;
  let mockAiCall:  jest.Mock;

  beforeEach(() => {
    mockSmsSend = jest.fn().mockResolvedValue(undefined);
    mockAiCall  = jest.fn().mockResolvedValue('A thoughtful AI-generated draft response.');

    _hooks.smsSend = mockSmsSend;
    _hooks.aiCall  = mockAiCall;

    // Default: no dedup match, property found, create succeeds
    mockFindUnique.mockResolvedValue(null);
    mockFindFirst.mockResolvedValue(BASE_PROPERTY);
    mockCreate.mockResolvedValue({ id: 'draft-t048-001' });
  });

  afterEach(() => {
    jest.clearAllMocks();
    _hooks.smsSend = undefined;
    _hooks.aiCall  = undefined;
  });

  // ── AC1: boss.work registrations ─────────────────────────────────────────

  describe('AC1 — process-airbnb-review and process-vrbo-review registered in worker.ts', () => {
    it('exports processAirbnbReviewHandler as a function', () => {
      expect(typeof processAirbnbReviewHandler).toBe('function');
    });

    it('exports processVrboReviewHandler as a function', () => {
      expect(typeof processVrboReviewHandler).toBe('function');
    });

    it('worker.ts registers process-airbnb-review', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'worker.ts'), 'utf8');
      expect(src).toContain('process-airbnb-review');
    });

    it('worker.ts registers process-vrbo-review', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'worker.ts'), 'utf8');
      expect(src).toContain('process-vrbo-review');
    });

    it('worker.ts imports processAirbnbReviewHandler', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'worker.ts'), 'utf8');
      expect(src).toContain('processAirbnbReviewHandler');
    });

    it('worker.ts imports processVrboReviewHandler', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'worker.ts'), 'utf8');
      expect(src).toContain('processVrboReviewHandler');
    });
  });

  // ── AC2: Dedup ────────────────────────────────────────────────────────────

  describe('AC2 — Duplicate platform_review_id discarded', () => {
    it('does not insert when platform_review_id already exists', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: 'existing-draft' });

      await processAirbnbReviewHandler(makeJob());

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('does not notify manager when duplicate discarded', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: 'existing-draft' });

      await processAirbnbReviewHandler(makeJob());

      expect(mockSmsSend).not.toHaveBeenCalled();
    });

    it('does not call AI when duplicate discarded', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: 'existing-draft' });

      await processAirbnbReviewHandler(makeJob());

      expect(mockAiCall).not.toHaveBeenCalled();
    });

    it('proceeds normally when no duplicate exists', async () => {
      await processAirbnbReviewHandler(makeJob());

      expect(mockCreate).toHaveBeenCalled();
    });

    it('discards when vrbo review is duplicate', async () => {
      mockFindUnique.mockResolvedValueOnce({ id: 'existing-draft' });

      await processVrboReviewHandler(makeJob({ listing_id: 'vrbo-listing-001' }));

      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── AC3: Empty review_text ────────────────────────────────────────────────

  describe('AC3 — Empty review_text -> static fallback, no_review_text=true, no AI call', () => {
    it('sets no_review_text=true when review_text is null', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: null }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.no_review_text).toBe(true);
    });

    it('sets no_review_text=true when review_text is empty string', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: '' }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.no_review_text).toBe(true);
    });

    it('sets no_review_text=true when review_text is whitespace only', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: '   ' }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.no_review_text).toBe(true);
    });

    it('uses static fallback template as draft_response when review_text is empty', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: null }));

      const data = mockCreate.mock.calls[0][0].data;
      const expected = buildStaticFallback(BASE_PROPERTY.name, 'Alice Smith', BASE_ACCOUNT.business_name);
      expect(data.draft_response).toBe(expected);
    });

    it('static fallback contains property name, reviewer name, and business name', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: '' }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.draft_response).toContain(BASE_PROPERTY.name);
      expect(data.draft_response).toContain('Alice Smith');
      expect(data.draft_response).toContain(BASE_ACCOUNT.business_name);
    });

    it('does NOT call AI when review_text is empty', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: '' }));

      expect(mockAiCall).not.toHaveBeenCalled();
    });

    it('sets no_review_text=false when review_text is present', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: 'Great place!' }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.no_review_text).toBe(false);
    });
  });

  // ── AC4: rating >= 4 → positive prompt ───────────────────────────────────

  describe('AC4 — rating >= 4 uses positive prompt', () => {
    it('uses positive prompt for rating = 5', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 5 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain('warm, genuine response');
    });

    it('uses positive prompt for rating = 4', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 4 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain('warm, genuine response');
    });

    it('positive prompt includes property name', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 4 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain(BASE_PROPERTY.name);
    });

    it('positive prompt includes reviewer name', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 5, reviewer_name: 'Bob Jones' }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain('Bob Jones');
    });

    it('positive prompt does NOT contain negative/neutral language', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 4 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).not.toContain('professional, constructive response');
    });
  });

  // ── AC5: rating <= 3 → negative/neutral prompt ───────────────────────────

  describe('AC5 — rating <= 3 (including exactly 3) uses negative/neutral prompt', () => {
    it('uses negative prompt for rating = 3 (boundary case)', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 3 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain('professional, constructive response');
    });

    it('uses negative prompt for rating = 2', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 2 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain('professional, constructive response');
    });

    it('uses negative prompt for rating = 1', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 1 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain('professional, constructive response');
    });

    it('negative prompt does NOT contain positive language', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 3 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).not.toContain('warm, genuine response');
    });

    it('negative prompt includes business name for contact invitation', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 2 }));

      const prompt: string = mockAiCall.mock.calls[0][0];
      expect(prompt).toContain(BASE_ACCOUNT.business_name);
    });
  });

  // ── AC6: AI failure ───────────────────────────────────────────────────────

  describe('AC6 — AI failure -> draft_response = null, ai_failed = true', () => {
    it('sets draft_response=null on AI error', async () => {
      mockAiCall.mockRejectedValueOnce(new Error('AI service unavailable'));

      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.draft_response).toBeNull();
    });

    it('sets ai_failed=true on AI error', async () => {
      mockAiCall.mockRejectedValueOnce(new Error('AI service unavailable'));

      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.ai_failed).toBe(true);
    });

    it('still inserts the review_drafts row on AI failure', async () => {
      mockAiCall.mockRejectedValueOnce(new Error('timeout'));

      await processAirbnbReviewHandler(makeJob());

      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('still sends manager notification on AI failure', async () => {
      mockAiCall.mockRejectedValueOnce(new Error('timeout'));

      await processAirbnbReviewHandler(makeJob());

      expect(mockSmsSend).toHaveBeenCalled();
    });

    it('sets ai_failed=false when AI succeeds', async () => {
      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.ai_failed).toBe(false);
    });
  });

  // ── AC7: INSERT with status=pending ──────────────────────────────────────

  describe('AC7 — review_drafts row inserted with status = "pending"', () => {
    it('inserts with status = pending', async () => {
      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.status).toBe('pending');
    });

    it('inserts with booking_id = null (MVP constraint)', async () => {
      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.booking_id).toBeNull();
    });

    it('inserts with correct platform_review_id', async () => {
      await processAirbnbReviewHandler(makeJob({ platform_review_id: 'rev-unique-999' }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.platform_review_id).toBe('rev-unique-999');
    });

    it('inserts with platform = airbnb for airbnb handler', async () => {
      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.platform).toBe('airbnb');
    });

    it('inserts with platform = vrbo for vrbo handler', async () => {
      await processVrboReviewHandler(makeJob({ listing_id: 'vrbo-listing-001' }));

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.platform).toBe('vrbo');
    });

    it('inserts with correct account_id from DB property', async () => {
      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.account_id).toBe(BASE_ACCOUNT.id);
    });

    it('inserts with correct property_id from DB property', async () => {
      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.property_id).toBe(BASE_PROPERTY.id);
    });

    it('inserts with AI draft as draft_response on success', async () => {
      mockAiCall.mockResolvedValueOnce('Custom AI draft text.');

      await processAirbnbReviewHandler(makeJob());

      const data = mockCreate.mock.calls[0][0].data;
      expect(data.draft_response).toBe('Custom AI draft text.');
    });

    it('discards and does not insert when property not found', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      await processAirbnbReviewHandler(makeJob());

      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── AC8: Manager notification via alert_channel ───────────────────────────

  describe('AC8 — Manager notification sent via alert_channel using DB values', () => {
    it('sends notification with correct reviewer name', async () => {
      await processAirbnbReviewHandler(makeJob({ reviewer_name: 'Carol White' }));

      const body: string = mockSmsSend.mock.calls[0][2];
      expect(body).toContain('Carol White');
    });

    it('sends notification with correct rating', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 4 }));

      const body: string = mockSmsSend.mock.calls[0][2];
      expect(body).toContain('4-star');
    });

    it('sends notification with correct property name from DB', async () => {
      await processAirbnbReviewHandler(makeJob());

      const body: string = mockSmsSend.mock.calls[0][2];
      expect(body).toContain(BASE_PROPERTY.name);
    });

    it('notification body matches expected template exactly', async () => {
      await processAirbnbReviewHandler(makeJob({ rating: 5, reviewer_name: 'Alice Smith' }));

      const body: string = mockSmsSend.mock.calls[0][2];
      const expected = buildManagerNotification('Alice Smith', 5, BASE_PROPERTY.name, BASE_ACCOUNT.business_name);
      expect(body).toBe(expected);
    });

    it('sends to manager_phone using twilio_phone_number as sender', async () => {
      await processAirbnbReviewHandler(makeJob());

      const [to, from] = mockSmsSend.mock.calls[0];
      expect(to).toBe(BASE_ACCOUNT.manager_phone);
      expect(from).toBe(BASE_ACCOUNT.twilio_phone_number);
    });

    it('notification sent even when empty review_text (static fallback path)', async () => {
      await processAirbnbReviewHandler(makeJob({ review_text: null }));

      expect(mockSmsSend).toHaveBeenCalled();
    });
  });

});
