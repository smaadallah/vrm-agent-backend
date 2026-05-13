/**
 * T-030 — review-request-sweep tests
 *
 * AC1: boss.work("review-request-sweep") registered in worker.ts
 * AC2: Message sent only to completed bookings within the ±0.5h window after checkout
 * AC3: review_request_enabled = false -> property skipped
 * AC4: No URL in the message under any circumstances
 * AC5: {{platform}} resolves to booking.platform value, not hardcoded
 * AC6: review_request_sent = true and review_request_sent_at set on success
 */

import fs from 'fs';
import path from 'path';

import {
  reviewRequestSweepHandler,
  buildReviewRequestMessage,
  platformDisplayName,
  _hooks,
} from './reviewRequest';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockFindMany = jest.fn();
const mockUpdate   = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    bookings: {
      findMany: (...a: any[]) => mockFindMany(...a),
      update:   (...a: any[]) => mockUpdate(...a),
    },
  },
}));

// ── workOrderCreation mock ────────────────────────────────────────────────────

const mockSendPlatformMessage = jest.fn();

jest.mock('./workOrderCreation', () => ({
  sendPlatformMessage: (...a: any[]) => mockSendPlatformMessage(...a),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fixed reference "now" — 2026-07-15 20:00:00 UTC
const BASE_NOW = new Date('2026-07-15T20:00:00.000Z');

function hoursAgo(h: number): Date {
  return new Date(BASE_NOW.getTime() - h * 60 * 60 * 1000);
}

function makeBooking(overrides: Record<string, any> = {}): any {
  return {
    id:                   'booking-1',
    platform:             'airbnb',
    guest_first_name:     'Alice',
    guest_last_name:      'Smith',
    guest_platform_id:    'guest-abc',
    checkout_datetime:    hoursAgo(2),   // exactly 2h ago — in window for hours_after=2
    review_request_sent:  false,
    status:               'completed',
    property: {
      id:                          'prop-1',
      name:                        'The Beach House',
      review_request_enabled:      true,
      review_request_hours_after:  2,
      review_request_template:     null,
    },
    account: {
      id:            'acct-1',
      business_name: 'Sunny Stays',
      manager_phone: '+15550001111',
    },
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.now          = () => BASE_NOW;
  _hooks.platformSend = undefined;
  mockFindMany.mockResolvedValue([]);
  mockUpdate.mockResolvedValue({});
  mockSendPlatformMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  _hooks.now          = undefined;
  _hooks.platformSend = undefined;
});

// ── AC1: worker.ts registration ───────────────────────────────────────────────

describe('AC1 — worker registration', () => {
  it('registers review-request-sweep in worker.ts JOB_HANDLERS', () => {
    const workerPath = path.resolve(__dirname, '../worker.ts');
    const src = fs.readFileSync(workerPath, 'utf8');
    expect(src).toContain("'review-request-sweep'");
    expect(src).toContain('reviewRequestSweepHandler');
  });
});

// ── AC2: window filtering ─────────────────────────────────────────────────────

describe('AC2 — window filtering', () => {
  it('sends to a completed booking whose checkout_datetime is exactly 2h ago (hours_after=2)', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('sends when checkout_datetime is 2.4h ago — within ±0.5h of hours_after=2', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2.4) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });

  it('skips when checkout_datetime is 2.6h ago — outside window (too old)', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2.6) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('skips when checkout_datetime is 1.4h ago — outside window (too recent)', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(1.4) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('respects per-property hours_after=3 — sends when checkout is 3h ago', async () => {
    const booking = makeBooking({
      checkout_datetime: hoursAgo(3),
      property: {
        id:                          'prop-2',
        name:                        'The Cabin',
        review_request_enabled:      true,
        review_request_hours_after:  3,
        review_request_template:     null,
      },
    });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });

  it('skips when no candidates returned from DB', async () => {
    mockFindMany.mockResolvedValue([]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
  });

  it('passes correct where clause to findMany', async () => {
    await reviewRequestSweepHandler();

    const [[args]] = mockFindMany.mock.calls;
    expect(args.where.status).toBe('completed');
    expect(args.where.review_request_sent).toBe(false);
    expect(args.where.checkout_datetime.gte).toBeInstanceOf(Date);
    expect(args.where.checkout_datetime.lt).toEqual(BASE_NOW);
    // broad lower bound is 72h before now
    const diff = BASE_NOW.getTime() - args.where.checkout_datetime.gte.getTime();
    expect(diff).toBe(72 * 60 * 60 * 1000);
  });
});

// ── AC3: review_request_enabled = false ──────────────────────────────────────

describe('AC3 — review_request_enabled', () => {
  it('skips booking when review_request_enabled = false', async () => {
    const booking = makeBooking({
      property: {
        id:                          'prop-1',
        name:                        'The Beach House',
        review_request_enabled:      false,
        review_request_hours_after:  2,
        review_request_template:     null,
      },
    });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sends only to enabled property when mixed', async () => {
    const enabled = makeBooking({ id: 'booking-1', checkout_datetime: hoursAgo(2) });
    const disabled = makeBooking({
      id:               'booking-2',
      checkout_datetime: hoursAgo(2),
      property: {
        id:                          'prop-2',
        name:                        'The Cabin',
        review_request_enabled:      false,
        review_request_hours_after:  2,
        review_request_template:     null,
      },
    });
    mockFindMany.mockResolvedValue([enabled, disabled]);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].where.id).toBe('booking-1');
  });
});

// ── AC4: No URL in message ────────────────────────────────────────────────────

describe('AC4 — no URL in message', () => {
  it('default template contains no URL', () => {
    const msg = buildReviewRequestMessage(null, {
      guestFirstName: 'Alice',
      propertyName:   'Beach House',
      platform:       'Airbnb',
      businessName:   'Sunny Stays',
    });
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).not.toMatch(/www\./);
  });

  it('the message sent to guest during sweep contains no URL', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    const sentText: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentText).not.toMatch(/https?:\/\//);
    expect(sentText).not.toMatch(/www\./);
  });
});

// ── AC5: {{platform}} resolves from booking.platform ─────────────────────────

describe('AC5 — platform display name', () => {
  it('resolves airbnb → Airbnb', () => {
    expect(platformDisplayName('airbnb')).toBe('Airbnb');
  });

  it('resolves vrbo → VRBO', () => {
    expect(platformDisplayName('vrbo')).toBe('VRBO');
  });

  it('airbnb booking: message contains "Airbnb" from booking.platform', async () => {
    const booking = makeBooking({ platform: 'airbnb', checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    const sentText: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentText).toContain('Airbnb');
    expect(sentText).not.toContain('VRBO');
  });

  it('vrbo booking: message contains "VRBO" from booking.platform', async () => {
    const booking = makeBooking({ platform: 'vrbo', checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    const sentText: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentText).toContain('VRBO');
    expect(sentText).not.toContain('Airbnb');
  });
});

// ── AC6: flags updated on success ────────────────────────────────────────────

describe('AC6 — flags updated', () => {
  it('sets review_request_sent = true on success', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'booking-1' },
      data: expect.objectContaining({ review_request_sent: true }),
    });
  });

  it('sets review_request_sent_at to a Date on success', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    const [[call]] = mockUpdate.mock.calls;
    expect(call.data.review_request_sent_at).toBeInstanceOf(Date);
  });

  it('does not set flags when send fails', async () => {
    const booking = makeBooking({ checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([booking]);
    mockSendPlatformMessage.mockRejectedValue(new Error('platform error'));

    await reviewRequestSweepHandler();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('continues to next booking after individual failure', async () => {
    const failing  = makeBooking({ id: 'booking-1', checkout_datetime: hoursAgo(2) });
    const succeeds = makeBooking({ id: 'booking-2', checkout_datetime: hoursAgo(2) });
    mockFindMany.mockResolvedValue([failing, succeeds]);
    mockSendPlatformMessage
      .mockRejectedValueOnce(new Error('platform error'))
      .mockResolvedValueOnce(undefined);

    await reviewRequestSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].where.id).toBe('booking-2');
  });
});

// ── Template builder unit tests ───────────────────────────────────────────────

describe('buildReviewRequestMessage', () => {
  const vars = {
    guestFirstName: 'Alice',
    propertyName:   'The Beach House',
    platform:       'Airbnb',
    businessName:   'Sunny Stays',
  };

  it('substitutes all placeholders with no unreplaced tokens', () => {
    const msg = buildReviewRequestMessage(null, vars);
    expect(msg).not.toMatch(/\{\{/);
    expect(msg).toContain('Alice');
    expect(msg).toContain('The Beach House');
    expect(msg).toContain('Airbnb');
    expect(msg).toContain('Sunny Stays');
  });

  it('uses custom template when provided', () => {
    const custom = 'Thanks {{guest_first_name}} for staying at {{property_name}}! — {{business_name}}';
    const msg = buildReviewRequestMessage(custom, vars);
    expect(msg).toBe('Thanks Alice for staying at The Beach House! — Sunny Stays');
  });

  it('uses default template when custom is null', () => {
    const msg = buildReviewRequestMessage(null, vars);
    expect(msg).toContain('wonderful stay');
    expect(msg).toContain('past trips');
  });

  it('DB values appear in sweep-sent message', async () => {
    const booking = makeBooking({
      checkout_datetime: hoursAgo(2),
      guest_first_name: 'Bob',
      property: {
        id:                          'prop-1',
        name:                        'The Cabin',
        review_request_enabled:      true,
        review_request_hours_after:  2,
        review_request_template:     null,
      },
      account: { id: 'acct-1', business_name: 'Mountain Hosts' },
    });
    mockFindMany.mockResolvedValue([booking]);

    await reviewRequestSweepHandler();

    const sentText: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentText).toContain('Bob');
    expect(sentText).toContain('The Cabin');
    expect(sentText).toContain('Mountain Hosts');
  });
});
