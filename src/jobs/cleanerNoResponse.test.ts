/**
 * T-043 — cleaner-no-response-check tests
 *
 * AC1: boss.work("cleaner-no-response-check") registered in worker.ts
 * AC2: Jobs past the confirmation window -> status = "no_response"
 * AC3: Atomic update — no double-transition (0 rows affected -> skip)
 * AC4: Window uses properties.cleaner_confirmation_window_minutes from DB, not hardcoded 60
 * AC5: no_response_alert_sent = true after alert
 * AC6: SMS template uses {{variables}} from DB only
 */

import fs from 'fs';
import path from 'path';

import {
  cleanerNoResponseHandler,
  buildNoResponseAlert,
  _hooks,
} from './cleanerNoResponse';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockFindMany          = jest.fn();
const mockExecuteRaw        = jest.fn();
const mockCleaningJobUpdate = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    $executeRaw:    (...a: any[]) => mockExecuteRaw(...a),
    cleaning_jobs: {
      findMany: (...a: any[]) => mockFindMany(...a),
      update:   (...a: any[]) => mockCleaningJobUpdate(...a),
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

// Fixed reference time: 2026-07-15 20:00:00 UTC (4:00 PM EDT)
const BASE_NOW    = new Date('2026-07-15T20:00:00.000Z');
// Checkout: 2026-07-15T15:00:00.000Z = 11:00 AM EDT
const CHECKOUT_UTC = new Date('2026-07-15T15:00:00.000Z');

function minutesAgo(mins: number): Date {
  return new Date(BASE_NOW.getTime() - mins * 60_000);
}

function makeJob(overrides: Record<string, any> = {}): any {
  return {
    id:                      'job-1',
    status:                  'scheduled',
    account_id:              'acct-1',
    property_id:             'prop-1',
    booking_id:              'bk-1',
    cleaner_id:              'cleaner-1',
    job_notification_sent:   true,
    job_notification_sent_at: minutesAgo(90), // 90 min ago — past default 60-min window
    cleaner_confirmed_at:    null,
    no_response_alert_sent:  false,
    property: {
      id:                                 'prop-1',
      name:                               'The Beach House',
      cleaner_confirmation_window_minutes: 60,
    },
    account: {
      id:                  'acct-1',
      business_name:       'Sunny Stays',
      manager_phone:       '+15550001111',
      twilio_phone_number: '+15559998888',
      alert_channel:       'sms',
    },
    cleaner: {
      id:    'cleaner-1',
      name:  'Maria Garcia',
      phone: '+15557776666',
    },
    booking: {
      checkout_datetime: CHECKOUT_UTC,
    },
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.now     = () => BASE_NOW;
  _hooks.smsSend = undefined;

  mockFindMany.mockResolvedValue([]);
  mockExecuteRaw.mockResolvedValue(1);          // 1 row affected = success
  mockCleaningJobUpdate.mockResolvedValue({});
  mockSendManagerSms.mockResolvedValue(undefined);
});

afterEach(() => {
  _hooks.now     = undefined;
  _hooks.smsSend = undefined;
});

// ── AC1: worker.ts registration ───────────────────────────────────────────────

describe('AC1 — worker.ts registration', () => {
  it('registers cleaner-no-response-check in JOB_HANDLERS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain("'cleaner-no-response-check'");
    expect(src).toContain('cleanerNoResponseHandler');
  });

  it('imports cleanerNoResponseHandler from cleanerNoResponse', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain('./jobs/cleanerNoResponse');
  });
});

// ── AC2: Jobs past the window → status = "no_response" ───────────────────────

describe('AC2 — status transitions to no_response', () => {
  it('calls $executeRaw with UPDATE cleaning_jobs SET status = no_response', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const [strings] = mockExecuteRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join('');
    expect(sql).toMatch(/UPDATE cleaning_jobs SET status = 'no_response'/);
  });

  it('$executeRaw WHERE clause guards against non-scheduled status', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const [strings] = mockExecuteRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join('');
    expect(sql).toMatch(/AND status = 'scheduled'/);
  });

  it('sends manager alert after atomic update succeeds', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
  });

  it('sets no_response_alert_sent = true after alert', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { no_response_alert_sent: true },
    });
  });

  it('processes multiple candidates independently', async () => {
    const job1 = makeJob({ id: 'job-1' });
    const job2 = makeJob({ id: 'job-2' });
    mockFindMany.mockResolvedValue([job1, job2]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    expect(mockSendManagerSms).toHaveBeenCalledTimes(2);
    expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no candidates returned from DB', async () => {
    mockFindMany.mockResolvedValue([]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockSendManagerSms).not.toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });
});

// ── AC3: Atomic update — no double-transition ─────────────────────────────────

describe('AC3 — atomic update prevents double-transition', () => {
  it('skips alert and flag when $executeRaw returns 0 (already transitioned)', async () => {
    mockExecuteRaw.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    expect(mockSendManagerSms).not.toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });

  it('uses $executeRaw (not cleaning_jobs.update) for the status change', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    // The status change goes through $executeRaw only
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // cleaning_jobs.update is ONLY for setting no_response_alert_sent, not status
    const statusUpdateCall = mockCleaningJobUpdate.mock.calls.find(
      c => c[0].data?.status === 'no_response',
    );
    expect(statusUpdateCall).toBeUndefined();
  });

  it('processes remaining jobs even when one is skipped (0 rows)', async () => {
    mockExecuteRaw
      .mockResolvedValueOnce(0)   // job-1 already transitioned
      .mockResolvedValueOnce(1);  // job-2 succeeds

    mockFindMany.mockResolvedValue([
      makeJob({ id: 'job-1' }),
      makeJob({ id: 'job-2' }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(1);
    expect(mockCleaningJobUpdate.mock.calls[0][0].where.id).toBe('job-2');
  });
});

// ── AC4: Window from DB (cleaner_confirmation_window_minutes) ─────────────────

describe('AC4 — uses cleaner_confirmation_window_minutes from property, not hardcoded 60', () => {
  it('skips when sent_at is within the window (25min ago, 30min window)', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({
        job_notification_sent_at: minutesAgo(25),
        property: {
          id:                                 'prop-1',
          name:                               'The Beach House',
          cleaner_confirmation_window_minutes: 30,
        },
      }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockSendManagerSms).not.toHaveBeenCalled();
  });

  it('processes when sent_at is past the window (35min ago, 30min window)', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({
        job_notification_sent_at: minutesAgo(35),
        property: {
          id:                                 'prop-1',
          name:                               'The Beach House',
          cleaner_confirmation_window_minutes: 30,
        },
      }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
  });

  it('skips when sent_at is within a custom 120min window (90min ago)', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({
        job_notification_sent_at: minutesAgo(90),
        property: {
          id:                                 'prop-1',
          name:                               'The Beach House',
          cleaner_confirmation_window_minutes: 120,
        },
      }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('processes when sent_at is past a custom 120min window (150min ago)', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({
        job_notification_sent_at: minutesAgo(150),
        property: {
          id:                                 'prop-1',
          name:                               'The Beach House',
          cleaner_confirmation_window_minutes: 120,
        },
      }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('handles mixed jobs with different window sizes correctly', async () => {
    // job-1: 30min window, sent 25min ago → skip
    // job-2: 30min window, sent 35min ago → process
    mockFindMany.mockResolvedValue([
      makeJob({
        id: 'job-1',
        job_notification_sent_at: minutesAgo(25),
        property: { id: 'p1', name: 'House A', cleaner_confirmation_window_minutes: 30 },
      }),
      makeJob({
        id: 'job-2',
        job_notification_sent_at: minutesAgo(35),
        property: { id: 'p2', name: 'House B', cleaner_confirmation_window_minutes: 30 },
      }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
  });

  it('skips when job_notification_sent_at is null', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({ job_notification_sent_at: null }),
    ]);

    await cleanerNoResponseHandler();

    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

// ── AC5: no_response_alert_sent = true ───────────────────────────────────────

describe('AC5 — no_response_alert_sent = true after alert', () => {
  it('sets no_response_alert_sent = true on successful alert', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { no_response_alert_sent: true },
    });
  });

  it('sets no_response_alert_sent = true even when sendManagerSms rejects', async () => {
    mockSendManagerSms.mockRejectedValueOnce(new Error('SMS error'));
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { no_response_alert_sent: true },
    });
  });

  it('sets flag for each processed job individually', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({ id: 'job-1' }),
      makeJob({ id: 'job-2' }),
    ]);

    await cleanerNoResponseHandler();

    const updatedIds = mockCleaningJobUpdate.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).toContain('job-1');
    expect(updatedIds).toContain('job-2');
  });

  it('does NOT set flag for skipped (within-window) jobs', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({ job_notification_sent_at: minutesAgo(10) }), // 10 min ago, 60-min window → skip
    ]);

    await cleanerNoResponseHandler();

    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });
});

// ── AC6: SMS template uses {{variables}} from DB only ────────────────────────

describe('AC6 — alert uses all {{variables}} from DB', () => {
  it('alert text contains cleaner_name from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Maria Garcia');
  });

  it('alert text contains property_name from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('The Beach House');
  });

  it('alert text contains cleaner_phone from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('+15557776666');
  });

  it('alert text contains business_name from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Sunny Stays');
  });

  it('different business_name produces different alert text', async () => {
    mockFindMany.mockResolvedValue([
      makeJob({ account: { id: 'acct-2', business_name: 'Premier Stays LLC', manager_phone: '+15550002222', twilio_phone_number: '+15559997777', alert_channel: 'sms' } }),
    ]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Premier Stays LLC');
    expect(alertText).not.toContain('Sunny Stays');
  });

  it('checkout_time_eastern is formatted in Eastern Time from bookings.checkout_datetime', async () => {
    // CHECKOUT_UTC = 2026-07-15T15:00:00Z = 11:00 AM EDT (UTC-4 in July)
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('11:00 AM');
    expect(alertText).toContain('Jul 15, 2026');
  });

  it('alert starts with "NO RESPONSE:" prefix', async () => {
    mockFindMany.mockResolvedValue([makeJob()]);

    await cleanerNoResponseHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toMatch(/^NO RESPONSE:/);
  });

  it('findMany query filters the correct fields', async () => {
    await cleanerNoResponseHandler();

    const [[args]] = mockFindMany.mock.calls;
    expect(args.where.status).toBe('scheduled');
    expect(args.where.job_notification_sent).toBe(true);
    expect(args.where.cleaner_confirmed_at).toBeNull();
    expect(args.where.no_response_alert_sent).toBe(false);
  });
});

// ── buildNoResponseAlert unit tests ──────────────────────────────────────────

describe('buildNoResponseAlert', () => {
  it('matches PRD Section 7.6 template exactly', () => {
    const msg = buildNoResponseAlert({
      cleanerName:         'Maria Garcia',
      cleanerPhone:        '+15557776666',
      propertyName:        'The Beach House',
      checkoutTimeEastern: 'Jul 15, 2026 11:00 AM EDT',
      businessName:        'Sunny Stays',
    });
    expect(msg).toBe(
      'NO RESPONSE: Maria Garcia has not confirmed the turnover job at The Beach House.\n' +
      'Guest checkout was Jul 15, 2026 11:00 AM EDT.\n' +
      'Please contact Maria Garcia directly at +15557776666, or assign a replacement ' +
      'and close the job manually in the dashboard.\n' +
      '- Sunny Stays',
    );
  });

  it('contains no hardcoded values', () => {
    const msg = buildNoResponseAlert({
      cleanerName:         'Custom Cleaner',
      cleanerPhone:        '+19999999999',
      propertyName:        'Custom Property',
      checkoutTimeEastern: 'some time',
      businessName:        'Custom Biz',
    });
    expect(msg).toContain('Custom Cleaner');
    expect(msg).toContain('Custom Property');
    expect(msg).toContain('Custom Biz');
    expect(msg).toContain('+19999999999');
    expect(msg).not.toContain('Maria Garcia');
    expect(msg).not.toContain('The Beach House');
    expect(msg).not.toContain('Sunny Stays');
  });

  it('includes cleaner_name twice (appears in subject line and contact instruction)', () => {
    const msg = buildNoResponseAlert({
      cleanerName:         'Maria Garcia',
      cleanerPhone:        '+15557776666',
      propertyName:        'Beach House',
      checkoutTimeEastern: 'Jul 15, 2026 11:00 AM EDT',
      businessName:        'Sunny Stays',
    });
    const occurrences = (msg.match(/Maria Garcia/g) ?? []).length;
    expect(occurrences).toBe(2);
  });
});
