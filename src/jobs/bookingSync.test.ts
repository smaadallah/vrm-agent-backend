/**
 * T-023 + T-024 — Booking Sync Worker + Cancellation Handler tests
 *
 * T-023 AC1: Airbnb webhook enqueues process-airbnb-booking job via pg-boss
 * T-023 AC2: VRBO webhook enqueues process-vrbo-booking job via pg-boss
 * T-023 AC3: Unknown listing_id → log.warn + return, no upsert
 * T-023 AC4: New booking → upsert with status 'upcoming', update does not overwrite status
 * T-023 AC5: Cancelled booking → handleBookingCancellation called (not upserted)
 * T-023 AC6: booking-sync-sweep handler exists and is registered in worker.ts
 *
 * T-024 AC1: Case A (upcoming) → bookings.status = 'cancelled', no other changes
 * T-024 AC2: Case B (active) → cancel + cleaning job failed + property_status = 'unknown' in transaction; manager alert sent
 * T-024 AC3: Case C (completed) → no DB changes, event logged
 * T-024 AC4: Case B alert uses accounts.business_name (not hardcoded)
 * T-024 AC5: Rule 3 retry applied to Case B alert send
 */

import {
  processAirbnbBookingHandler,
  processVrboBookingHandler,
  handleBookingCancellation,
  bookingSyncSweepHandler,
  BookingPayload,
  _hooks,
} from './bookingSync';

// ── Prisma mock ──────────────────────────────────────────────────────────────

const mockFindFirst       = jest.fn();
const mockBookingFindUnique = jest.fn();
const mockBookingUpsert   = jest.fn();
const mockBookingUpdate   = jest.fn();
const mockCleaningUpdateMany = jest.fn();
const mockPropertyUpdate  = jest.fn();
const mockTransaction     = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    properties: {
      findFirst: (...args: any[]) => mockFindFirst(...args),
      update:    (...args: any[]) => mockPropertyUpdate(...args),
    },
    bookings: {
      findUnique: (...args: any[]) => mockBookingFindUnique(...args),
      upsert:     (...args: any[]) => mockBookingUpsert(...args),
      update:     (...args: any[]) => mockBookingUpdate(...args),
    },
    cleaning_jobs: {
      updateMany: (...args: any[]) => mockCleaningUpdateMany(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

// ── Logger mock ──────────────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from '../lib/logger';

// ── twilio mock ───────────────────────────────────────────────────────────────

jest.mock('twilio', () => jest.fn());

// ── Fixtures ─────────────────────────────────────────────────────────────────

const airbnbPayload: BookingPayload = {
  platform_booking_id:    'BKG-001',
  listing_id:             'LISTING-A',
  guest_platform_user_id: 'GUEST-1',
  guest_first_name:       'Jane',
  guest_last_name:        'Doe',
  checkin_datetime:       '2026-07-01T15:00:00.000Z',
  checkout_datetime:      '2026-07-07T11:00:00.000Z',
  status:                 'upcoming',
};

const vrboPayload: BookingPayload = {
  ...airbnbPayload,
  platform_booking_id: 'BKG-002',
  listing_id:          'LISTING-V',
};

const mockPropertyRecord = { id: 'PROP-1', account_id: 'ACC-1' };

const mockAccount = {
  id:                  'ACC-1',
  business_name:       'Sunshine Stays',
  manager_phone:       '+15550001111',
  twilio_phone_number: '+15559999000',
  alert_channel:       'sms',
};

function makeBookingRecord(status: 'upcoming' | 'active' | 'completed' | 'cancelled') {
  return {
    id:               'BKID-1',
    status,
    account_id:       'ACC-1',
    guest_first_name: 'Jane',
    guest_last_name:  'Doe',
    property:         { id: 'PROP-1', name: 'Ocean View Cottage' },
    account:          mockAccount,
  };
}

// ── Reset state before each test ─────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.handleCancellation = undefined;
  _hooks.sendSms            = undefined;
  _hooks.retryDelayMs       = 0; // eliminate sleep in tests
});

// ════════════════════════════════════════════════════════════════════════════
// T-023 tests
// ════════════════════════════════════════════════════════════════════════════

describe('T-023 AC1 — Airbnb booking job handler', () => {
  it('calls upsert when property is found', async () => {
    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingUpsert.mockResolvedValue({});

    await processAirbnbBookingHandler({ data: airbnbPayload });

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { airbnb_listing_id: 'LISTING-A' } }),
    );
    expect(mockBookingUpsert).toHaveBeenCalledTimes(1);
    const call = mockBookingUpsert.mock.calls[0][0];
    expect(call.where.account_id_platform_platform_booking_id).toMatchObject({
      account_id:          'ACC-1',
      platform:            'airbnb',
      platform_booking_id: 'BKG-001',
    });
    expect(call.create.status).toBe('upcoming');
  });
});

describe('T-023 AC2 — VRBO booking job handler', () => {
  it('calls upsert with vrbo platform and vrbo listing field', async () => {
    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingUpsert.mockResolvedValue({});

    await processVrboBookingHandler({ data: vrboPayload });

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vrbo_listing_id: 'LISTING-V' } }),
    );
    expect(mockBookingUpsert).toHaveBeenCalledTimes(1);
    expect(mockBookingUpsert.mock.calls[0][0].where.account_id_platform_platform_booking_id.platform).toBe('vrbo');
  });
});

describe('T-023 AC3 — unknown listing_id', () => {
  it('logs a warning and does not call upsert', async () => {
    mockFindFirst.mockResolvedValue(null);

    await processAirbnbBookingHandler({ data: airbnbPayload });

    expect(mockBookingUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ listing_id: 'LISTING-A' }),
      expect.stringContaining('no property found'),
    );
  });
});

describe('T-023 AC4 — upsert shape', () => {
  it('create block always uses status upcoming', async () => {
    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingUpsert.mockResolvedValue({});

    await processAirbnbBookingHandler({ data: airbnbPayload });

    expect(mockBookingUpsert.mock.calls[0][0].create.status).toBe('upcoming');
  });

  it('update block does not contain status field', async () => {
    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingUpsert.mockResolvedValue({});

    await processAirbnbBookingHandler({ data: airbnbPayload });

    expect(mockBookingUpsert.mock.calls[0][0].update).not.toHaveProperty('status');
  });

  it('maps guest_platform_user_id to guest_platform_id', async () => {
    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingUpsert.mockResolvedValue({});

    await processAirbnbBookingHandler({ data: airbnbPayload });

    const call = mockBookingUpsert.mock.calls[0][0];
    expect(call.create.guest_platform_id).toBe('GUEST-1');
    expect(call.update.guest_platform_id).toBe('GUEST-1');
  });
});

describe('T-023 AC5 — cancellation routing', () => {
  it('calls injected handleCancellation when booking exists', async () => {
    const mockCancel = jest.fn().mockResolvedValue(undefined);
    _hooks.handleCancellation = mockCancel;

    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingFindUnique.mockResolvedValue({ id: 'BOOKING-1' });

    await processAirbnbBookingHandler({ data: { ...airbnbPayload, status: 'cancelled' } });

    expect(mockBookingUpsert).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith('BOOKING-1', 'ACC-1');
  });

  it('warns and skips when cancelled booking does not exist in DB', async () => {
    mockFindFirst.mockResolvedValue(mockPropertyRecord);
    mockBookingFindUnique.mockResolvedValue(null);

    await processAirbnbBookingHandler({ data: { ...airbnbPayload, status: 'cancelled' } });

    expect(mockBookingUpsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ platform_booking_id: 'BKG-001' }),
      expect.stringContaining('cancellation received for unknown booking'),
    );
  });
});

describe('T-023 AC6 — booking-sync-sweep', () => {
  it('bookingSyncSweepHandler resolves without error', async () => {
    await expect(bookingSyncSweepHandler()).resolves.toBeUndefined();
  });

  it('booking-sync-sweep is in the JOBS array in worker.ts', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../worker.ts'), 'utf8');
    expect(src).toMatch(/booking-sync-sweep/);
    expect(src).toMatch(/bookingSyncSweepHandler/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// T-024 tests
// ════════════════════════════════════════════════════════════════════════════

describe('T-024 AC1 — Case A: upcoming booking cancelled', () => {
  it('updates status to cancelled and makes no other DB changes', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('upcoming'));
    mockBookingUpdate.mockResolvedValue({});

    await handleBookingCancellation('BKID-1', 'ACC-1');

    expect(mockBookingUpdate).toHaveBeenCalledWith({
      where: { id: 'BKID-1' },
      data:  { status: 'cancelled' },
    });
    // No transaction, no cleaning job update, no property update
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCleaningUpdateMany).not.toHaveBeenCalled();
    expect(mockPropertyUpdate).not.toHaveBeenCalled();
  });
});

describe('T-024 AC2 — Case B: active booking — transactional cancel + alert', () => {
  it('executes prisma.$transaction with booking cancel, cleaning fail, property unknown', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('active'));
    mockTransaction.mockResolvedValue([{}, {}, {}]);

    const mockSend = jest.fn().mockResolvedValue(undefined);
    _hooks.sendSms = mockSend;

    await handleBookingCancellation('BKID-1', 'ACC-1');

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const txArgs = mockTransaction.mock.calls[0][0];
    // Transaction receives an array of 3 operations
    expect(Array.isArray(txArgs)).toBe(true);
    expect(txArgs).toHaveLength(3);
  });

  it('passes booking cancel, cleaning fail, property unknown to $transaction', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('active'));
    mockTransaction.mockResolvedValue([{}, {}, {}]);
    _hooks.sendSms = jest.fn().mockResolvedValue(undefined);

    await handleBookingCancellation('BKID-1', 'ACC-1');

    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'BKID-1' }, data: { status: 'cancelled' } }),
    );
    expect(mockCleaningUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ booking_id: 'BKID-1' }),
        data:  { status: 'failed' },
      }),
    );
    expect(mockPropertyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'PROP-1' }, data: { property_status: 'unknown' } }),
    );
  });

  it('sends manager alert after transaction completes', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('active'));
    mockTransaction.mockResolvedValue([{}, {}, {}]);

    const mockSend = jest.fn().mockResolvedValue(undefined);
    _hooks.sendSms = mockSend;

    await handleBookingCancellation('BKID-1', 'ACC-1');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      mockAccount.manager_phone,
      mockAccount.twilio_phone_number,
      expect.stringContaining('BOOKING CANCELLED'),
    );
  });
});

describe('T-024 AC3 — Case C: completed booking — no DB changes, event logged', () => {
  it('makes no DB changes and logs the event', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('completed'));

    await handleBookingCancellation('BKID-1', 'ACC-1');

    expect(mockBookingUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCleaningUpdateMany).not.toHaveBeenCalled();
    expect(mockPropertyUpdate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
      expect.stringContaining('completed booking'),
    );
  });
});

describe('T-024 AC4 — Case B alert uses accounts.business_name', () => {
  it('alert text contains business_name from account record, not hardcoded text', async () => {
    const customAccount = { ...mockAccount, business_name: 'Coastal Getaways LLC' };
    mockBookingFindUnique.mockResolvedValue({
      ...makeBookingRecord('active'),
      account: customAccount,
    });
    mockTransaction.mockResolvedValue([{}, {}, {}]);

    const mockSend = jest.fn().mockResolvedValue(undefined);
    _hooks.sendSms = mockSend;

    await handleBookingCancellation('BKID-1', 'ACC-1');

    const sentBody: string = mockSend.mock.calls[0][2];
    expect(sentBody).toContain('Coastal Getaways LLC');
    expect(sentBody).not.toContain('Sunshine Stays');
  });

  it('alert text contains guest name from booking record', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('active'));
    mockTransaction.mockResolvedValue([{}, {}, {}]);

    const mockSend = jest.fn().mockResolvedValue(undefined);
    _hooks.sendSms = mockSend;

    await handleBookingCancellation('BKID-1', 'ACC-1');

    const sentBody: string = mockSend.mock.calls[0][2];
    expect(sentBody).toContain('Jane Doe');
    expect(sentBody).toContain('Ocean View Cottage');
  });
});

describe('T-024 AC5 — Rule 3 retry on Case B alert', () => {
  it('retries once after first SMS failure', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('active'));
    mockTransaction.mockResolvedValue([{}, {}, {}]);

    const mockSend = jest.fn()
      .mockRejectedValueOnce(new Error('Twilio timeout'))
      .mockResolvedValueOnce(undefined);
    _hooks.sendSms = mockSend;

    await handleBookingCancellation('BKID-1', 'ACC-1');

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('logs error when both attempts fail, does not throw', async () => {
    mockBookingFindUnique.mockResolvedValue(makeBookingRecord('active'));
    mockTransaction.mockResolvedValue([{}, {}, {}]);

    const mockSend = jest.fn().mockRejectedValue(new Error('Twilio down'));
    _hooks.sendSms = mockSend;

    await expect(handleBookingCancellation('BKID-1', 'ACC-1')).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'ACC-1' }),
      expect.stringContaining('permanently failed'),
    );
  });
});
