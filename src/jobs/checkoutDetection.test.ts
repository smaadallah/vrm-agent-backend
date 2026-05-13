/**
 * T-039 — checkout-detection tests
 *
 * AC1: boss.work("checkout-detection-sweep") registered in worker.ts
 * AC2: boss.work("process-airbnb-checkout") and boss.work("process-vrbo-checkout") registered
 * AC3: Atomic raw-SQL UPDATE prevents double-dispatch (0 rows → discard)
 * AC4: auto_schedule_cleaner_enabled = false → cleaner not dispatched, logged
 * AC5: No active primary cleaner → manager alert, no cleaning_jobs row
 * AC6: Duplicate booking_id on INSERT → discarded silently
 * AC7: SMS uses PRD Section 7.2 template with all {{variables}} from DB
 * AC8: job_notification_sent = true on SMS success
 */

import fs from 'fs';
import path from 'path';

import {
  dispatchCleaner,
  checkoutDetectionSweepHandler,
  processAirbnbCheckoutHandler,
  processVrboCheckoutHandler,
  buildCleanerSmsText,
  _hooks,
} from './checkoutDetection';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockExecuteRaw             = jest.fn();
const mockBookingFindUnique      = jest.fn();
const mockBookingFindFirst       = jest.fn();
const mockBookingFindMany        = jest.fn();
const mockPropertyUpdate         = jest.fn();
const mockPropertyFindFirst      = jest.fn();
const mockPropCleanerFindFirst   = jest.fn();
const mockCleaningJobCreate      = jest.fn();
const mockCleaningJobUpdate      = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    $executeRaw:       (...a: any[]) => mockExecuteRaw(...a),
    bookings:          {
      findUnique: (...a: any[]) => mockBookingFindUnique(...a),
      findFirst:  (...a: any[]) => mockBookingFindFirst(...a),
      findMany:   (...a: any[]) => mockBookingFindMany(...a),
    },
    properties:        { update: (...a: any[]) => mockPropertyUpdate(...a), findFirst: (...a: any[]) => mockPropertyFindFirst(...a) },
    property_cleaners: { findFirst: (...a: any[]) => mockPropCleanerFindFirst(...a) },
    cleaning_jobs:     {
      create: (...a: any[]) => mockCleaningJobCreate(...a),
      update: (...a: any[]) => mockCleaningJobUpdate(...a),
    },
  },
}));

// ── workOrderCreation mock ────────────────────────────────────────────────────

const mockSendManagerSms = jest.fn();

jest.mock('./workOrderCreation', () => ({
  sendManagerSms: (...a: any[]) => mockSendManagerSms(...a),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CHECKOUT_UTC = new Date('2026-07-15T15:00:00.000Z'); // 11:00 AM EDT
const NEXT_CHECKIN_UTC = new Date('2026-07-16T15:00:00.000Z'); // next day

function makeAccount(overrides: Record<string, any> = {}): any {
  return {
    id:                  'acct-1',
    business_name:       'Sunny Stays',
    manager_phone:       '+15550001111',
    twilio_phone_number: '+15559998888',
    alert_channel:       'sms',
    ...overrides,
  };
}

function makeProperty(overrides: Record<string, any> = {}): any {
  return {
    id:                           'prop-1',
    name:                         'The Beach House',
    address:                      '123 Ocean Dr, Miami FL 33101',
    auto_schedule_cleaner_enabled: true,
    airbnb_listing_id:             'airbnb-listing-1',
    vrbo_listing_id:               'vrbo-listing-1',
    ...overrides,
  };
}

function makeCleaner(overrides: Record<string, any> = {}): any {
  return {
    id:        'cleaner-1',
    name:      'Maria Garcia',
    phone:     '+15557776666',
    is_active: true,
    ...overrides,
  };
}

function makeBooking(overrides: Record<string, any> = {}): any {
  const account  = makeAccount();
  const property = makeProperty();
  return {
    id:                  'booking-1',
    platform:            'airbnb',
    platform_booking_id: 'airbnb-bk-123',
    guest_first_name:    'Alice',
    guest_last_name:     'Smith',
    checkout_datetime:   CHECKOUT_UTC,
    status:              'active',
    property_id:         property.id,
    account_id:          account.id,
    property,
    account,
    ...overrides,
  };
}

function makePrimaryAssignment(cleanerOverrides: Record<string, any> = {}): any {
  return {
    id:          'pc-1',
    property_id: 'prop-1',
    cleaner_id:  'cleaner-1',
    is_primary:  true,
    cleaner:     makeCleaner(cleanerOverrides),
  };
}

// P2002 error factory
function p2002Error(): Error {
  const err: any = new Error('Unique constraint failed');
  err.code = 'P2002';
  return err;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.smsSend       = jest.fn().mockResolvedValue(undefined);
  _hooks.retryDelayMs  = 0;

  // Happy-path defaults
  mockExecuteRaw.mockResolvedValue(1);
  mockBookingFindUnique.mockResolvedValue(makeBooking());
  mockBookingFindFirst.mockResolvedValue({ id: 'next-booking-1', checkin_datetime: NEXT_CHECKIN_UTC });
  mockBookingFindMany.mockResolvedValue([]);
  mockPropertyUpdate.mockResolvedValue({});
  mockPropertyFindFirst.mockResolvedValue({ id: 'prop-1' });
  mockPropCleanerFindFirst.mockResolvedValue(makePrimaryAssignment());
  mockCleaningJobCreate.mockResolvedValue({ id: 'job-1' });
  mockCleaningJobUpdate.mockResolvedValue({});
  mockSendManagerSms.mockResolvedValue(undefined);
});

afterEach(() => {
  _hooks.smsSend      = undefined;
  _hooks.retryDelayMs = undefined;
});

// ── AC1 + AC2: worker.ts registration ────────────────────────────────────────

describe('AC1 + AC2 — worker.ts registration', () => {
  it('registers checkout-detection-sweep in JOB_HANDLERS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain("'checkout-detection-sweep'");
    expect(src).toContain('checkoutDetectionSweepHandler');
  });

  it('registers process-airbnb-checkout in WEBHOOK_JOBS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain("'process-airbnb-checkout'");
    expect(src).toContain('processAirbnbCheckoutHandler');
  });

  it('registers process-vrbo-checkout in WEBHOOK_JOBS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain("'process-vrbo-checkout'");
    expect(src).toContain('processVrboCheckoutHandler');
  });
});

// ── AC3: Atomic raw-SQL UPDATE ────────────────────────────────────────────────

describe('AC3 — atomic raw-SQL update', () => {
  it('calls $executeRaw (not bookings.update) for the status transition', async () => {
    await dispatchCleaner('booking-1');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('$executeRaw template contains UPDATE bookings SET status = completed', async () => {
    await dispatchCleaner('booking-1');
    const [strings] = mockExecuteRaw.mock.calls[0] as [string[]];
    const sqlTemplate = strings.join('');
    expect(sqlTemplate).toMatch(/UPDATE bookings SET status = 'completed'/);
    expect(sqlTemplate).toMatch(/AND status = 'active'/);
  });

  it('discards when $executeRaw returns 0 — nothing else runs', async () => {
    mockExecuteRaw.mockResolvedValue(0);

    await dispatchCleaner('booking-1');

    expect(mockBookingFindUnique).not.toHaveBeenCalled();
    expect(mockPropertyUpdate).not.toHaveBeenCalled();
    expect(mockPropCleanerFindFirst).not.toHaveBeenCalled();
    expect(mockCleaningJobCreate).not.toHaveBeenCalled();
    expect(_hooks.smsSend).not.toHaveBeenCalled();
  });

  it('discards when $executeRaw returns BigInt(0)', async () => {
    mockExecuteRaw.mockResolvedValue(BigInt(0));

    await dispatchCleaner('booking-1');

    expect(mockPropertyUpdate).not.toHaveBeenCalled();
  });
});

// ── AC4: auto_schedule_cleaner_enabled = false ───────────────────────────────

describe('AC4 — auto_schedule_cleaner_enabled = false', () => {
  it('skips cleaner dispatch when auto-schedule disabled', async () => {
    const booking = makeBooking({
      property: makeProperty({ auto_schedule_cleaner_enabled: false }),
    });
    mockBookingFindUnique.mockResolvedValue(booking);

    await dispatchCleaner('booking-1');

    // property marked needs_cleaning even if auto-schedule is off
    expect(mockPropertyUpdate).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data:  { property_status: 'needs_cleaning' },
    });

    // but dispatch stops here
    expect(mockPropCleanerFindFirst).not.toHaveBeenCalled();
    expect(mockCleaningJobCreate).not.toHaveBeenCalled();
    expect(_hooks.smsSend).not.toHaveBeenCalled();
  });
});

// ── AC5: No active primary cleaner ───────────────────────────────────────────

describe('AC5 — no active primary cleaner', () => {
  it('sends manager alert when no primary cleaner found', async () => {
    mockPropCleanerFindFirst.mockResolvedValue(null);

    await dispatchCleaner('booking-1');

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('NO CLEANER');
    expect(alertText).toContain('The Beach House');
    expect(alertText).toContain('Sunny Stays');
  });

  it('does NOT create cleaning_jobs row when no primary cleaner', async () => {
    mockPropCleanerFindFirst.mockResolvedValue(null);

    await dispatchCleaner('booking-1');

    expect(mockCleaningJobCreate).not.toHaveBeenCalled();
    expect(_hooks.smsSend).not.toHaveBeenCalled();
  });
});

// ── AC6: Duplicate booking_id → discard silently ─────────────────────────────

describe('AC6 — duplicate booking_id discarded silently', () => {
  it('does not throw when cleaning_jobs.create throws P2002', async () => {
    mockCleaningJobCreate.mockRejectedValue(p2002Error());

    await expect(dispatchCleaner('booking-1')).resolves.not.toThrow();
  });

  it('does not send cleaner SMS when INSERT is a duplicate', async () => {
    mockCleaningJobCreate.mockRejectedValue(p2002Error());

    await dispatchCleaner('booking-1');

    expect(_hooks.smsSend).not.toHaveBeenCalled();
  });

  it('re-throws non-P2002 errors from cleaning_jobs.create', async () => {
    const unexpectedErr = new Error('DB connection lost');
    mockCleaningJobCreate.mockRejectedValue(unexpectedErr);

    await expect(dispatchCleaner('booking-1')).rejects.toThrow('DB connection lost');
  });
});

// ── AC7: SMS template with DB values ─────────────────────────────────────────

describe('AC7 — SMS template uses DB values', () => {
  it('SMS contains cleaner name from DB', async () => {
    await dispatchCleaner('booking-1');
    const [to, from, body] = (_hooks.smsSend as jest.Mock).mock.calls[0];
    expect(body).toContain('Maria Garcia');
  });

  it('SMS contains property name from DB', async () => {
    await dispatchCleaner('booking-1');
    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    expect(body).toContain('The Beach House');
  });

  it('SMS contains property address from DB', async () => {
    await dispatchCleaner('booking-1');
    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    expect(body).toContain('123 Ocean Dr, Miami FL 33101');
  });

  it('SMS contains business_name from DB', async () => {
    await dispatchCleaner('booking-1');
    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    expect(body).toContain('Sunny Stays');
  });

  it('SMS contains checkout time in Eastern Time', async () => {
    await dispatchCleaner('booking-1');
    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    // CHECKOUT_UTC = 2026-07-15T15:00Z = 11:00 AM EDT
    expect(body).toContain('Jul 15, 2026 11:00 AM');
  });

  it('SMS contains next check-in line when next booking exists', async () => {
    await dispatchCleaner('booking-1');
    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    expect(body).toContain('Next check-in:');
    expect(body).toContain('Jul 16, 2026 11:00 AM');
  });

  it('SMS omits next check-in line when no next booking', async () => {
    mockBookingFindFirst.mockResolvedValue(null);

    await dispatchCleaner('booking-1');

    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    expect(body).not.toContain('Next check-in');
  });

  it('SMS is sent to cleaner phone (not manager phone)', async () => {
    await dispatchCleaner('booking-1');
    const [to] = (_hooks.smsSend as jest.Mock).mock.calls[0];
    expect(to).toBe('+15557776666');  // cleaner phone
  });

  it('SMS is sent from account twilio_phone_number', async () => {
    await dispatchCleaner('booking-1');
    const [, from] = (_hooks.smsSend as jest.Mock).mock.calls[0];
    expect(from).toBe('+15559998888');  // account twilio phone
  });

  it('SMS includes "Reply CONFIRM to accept"', async () => {
    await dispatchCleaner('booking-1');
    const body: string = (_hooks.smsSend as jest.Mock).mock.calls[0][2];
    expect(body).toContain('Reply CONFIRM to accept.');
  });
});

// ── AC8: job_notification_sent = true on SMS success ─────────────────────────

describe('AC8 — job_notification_sent flags', () => {
  it('sets job_notification_sent = true on successful SMS', async () => {
    await dispatchCleaner('booking-1');

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  expect.objectContaining({ job_notification_sent: true }),
    });
  });

  it('sets job_notification_sent_at to a Date on SMS success', async () => {
    await dispatchCleaner('booking-1');

    const [[call]] = mockCleaningJobUpdate.mock.calls;
    expect(call.data.job_notification_sent_at).toBeInstanceOf(Date);
  });

  it('does NOT set job_notification_sent when SMS permanently fails', async () => {
    (_hooks.smsSend as jest.Mock).mockRejectedValue(new Error('Twilio error'));

    await dispatchCleaner('booking-1');

    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });

  it('sends manager alert when cleaner SMS permanently fails', async () => {
    (_hooks.smsSend as jest.Mock).mockRejectedValue(new Error('Twilio error'));

    await dispatchCleaner('booking-1');

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('SEND FAILURE');
    expect(alertText).toContain('Maria Garcia');
  });
});

// ── buildCleanerSmsText unit tests ────────────────────────────────────────────

describe('buildCleanerSmsText', () => {
  const baseVars = {
    cleanerName:         'Maria Garcia',
    propertyName:        'The Beach House',
    propertyAddress:     '123 Ocean Dr, Miami FL 33101',
    checkoutTimeEastern: 'Jul 15, 2026 11:00 AM EDT',
    nextCheckinLine:     '',
    businessName:        'Sunny Stays',
  };

  it('produces all required lines without next check-in', () => {
    const sms = buildCleanerSmsText(baseVars);
    expect(sms).toContain('Hi Maria Garcia, turnover job at The Beach House.');
    expect(sms).toContain('Address: 123 Ocean Dr, Miami FL 33101');
    expect(sms).toContain('Guest checkout: Jul 15, 2026 11:00 AM EDT');
    expect(sms).toContain('Reply CONFIRM to accept.');
    expect(sms).toContain('- Sunny Stays');
    expect(sms).not.toContain('Next check-in');
  });

  it('includes next check-in line when provided', () => {
    const sms = buildCleanerSmsText({
      ...baseVars,
      nextCheckinLine: 'Next check-in: Jul 16, 2026 3:00 PM EDT',
    });
    expect(sms).toContain('Next check-in: Jul 16, 2026 3:00 PM EDT');
  });

  it('contains no hardcoded business or property names', () => {
    const sms = buildCleanerSmsText({
      ...baseVars,
      cleanerName:  'Custom Cleaner',
      propertyName: 'Custom Property',
      businessName: 'Custom Biz',
    });
    expect(sms).toContain('Custom Cleaner');
    expect(sms).toContain('Custom Property');
    expect(sms).toContain('Custom Biz');
    expect(sms).not.toContain('Maria Garcia');
    expect(sms).not.toContain('The Beach House');
    expect(sms).not.toContain('Sunny Stays');
  });
});

// ── checkoutDetectionSweepHandler ────────────────────────────────────────────

describe('checkoutDetectionSweepHandler', () => {
  it('calls dispatchCleaner for each candidate booking', async () => {
    mockBookingFindMany.mockResolvedValue([
      { id: 'booking-1' },
      { id: 'booking-2' },
    ]);
    // Each dispatchCleaner call uses the mocked defaults above (returns 1 row)
    mockBookingFindUnique
      .mockResolvedValueOnce(makeBooking({ id: 'booking-1' }))
      .mockResolvedValueOnce(makeBooking({ id: 'booking-2' }));
    mockCleaningJobCreate
      .mockResolvedValueOnce({ id: 'job-1' })
      .mockResolvedValueOnce({ id: 'job-2' });

    await checkoutDetectionSweepHandler();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no candidates', async () => {
    mockBookingFindMany.mockResolvedValue([]);

    await checkoutDetectionSweepHandler();

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('passes correct where clause to findMany', async () => {
    await checkoutDetectionSweepHandler();

    const [[args]] = mockBookingFindMany.mock.calls;
    expect(args.where.status).toBe('active');
    expect(args.where.checkout_datetime.lte).toBeInstanceOf(Date);
    expect(args.where.checkout_datetime.gte).toBeInstanceOf(Date);
    // 24h window
    const diff = args.where.checkout_datetime.lte.getTime() - args.where.checkout_datetime.gte.getTime();
    expect(diff).toBe(24 * 60 * 60 * 1000);
  });

  it('continues to next booking when one dispatch fails', async () => {
    mockBookingFindMany.mockResolvedValue([{ id: 'booking-1' }, { id: 'booking-2' }]);
    mockExecuteRaw
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce(1);
    mockBookingFindUnique.mockResolvedValue(makeBooking({ id: 'booking-2' }));

    await checkoutDetectionSweepHandler();

    // Second booking was still attempted
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
  });
});

// ── Webhook handlers ──────────────────────────────────────────────────────────

describe('processAirbnbCheckoutHandler', () => {
  it('looks up booking and calls dispatchCleaner', async () => {
    mockPropertyFindFirst.mockResolvedValue({ id: 'prop-1' });
    mockBookingFindFirst.mockResolvedValueOnce({ id: 'booking-1' });  // active booking lookup
    mockBookingFindFirst.mockResolvedValueOnce(null);                  // next booking lookup

    await processAirbnbCheckoutHandler({
      data: { platform_booking_id: 'airbnb-bk-123', listing_id: 'airbnb-listing-1' },
    });

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('discards when payload is missing fields', async () => {
    await processAirbnbCheckoutHandler({ data: {} });
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('discards when property not found', async () => {
    mockPropertyFindFirst.mockResolvedValue(null);

    await processAirbnbCheckoutHandler({
      data: { platform_booking_id: 'bk-x', listing_id: 'listing-x' },
    });

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('discards when no active booking found', async () => {
    mockPropertyFindFirst.mockResolvedValue({ id: 'prop-1' });
    mockBookingFindFirst.mockResolvedValueOnce(null);  // no active booking

    await processAirbnbCheckoutHandler({
      data: { platform_booking_id: 'bk-x', listing_id: 'listing-x' },
    });

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

describe('processVrboCheckoutHandler', () => {
  it('looks up by vrbo_listing_id and calls dispatchCleaner', async () => {
    mockPropertyFindFirst.mockResolvedValue({ id: 'prop-1' });
    mockBookingFindFirst.mockResolvedValueOnce({ id: 'booking-1' });
    mockBookingFindFirst.mockResolvedValueOnce(null);

    await processVrboCheckoutHandler({
      data: { platform_booking_id: 'vrbo-bk-123', listing_id: 'vrbo-listing-1' },
    });

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // Verify the property lookup used the vrbo field
    expect(mockPropertyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vrbo_listing_id: 'vrbo-listing-1' },
      }),
    );
  });
});
