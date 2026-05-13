/**
 * T-044 — pre-checkin-alert-check tests
 *
 * AC1: boss.work("pre-checkin-alert-check") registered in worker.ts
 * AC2: Standard alert sent when deadline >= NOW() and within alert window
 * AC3: Overdue alert sent when deadline < NOW()
 * AC4: Jobs outside alert window skipped
 * AC5: pre_checkin_alert_sent = true after alert attempted
 * AC6: {{next_checkin_eastern}} converts checkin_datetime to Eastern Time
 */

import fs from 'fs';
import path from 'path';

import {
  preCheckinAlertHandler,
  buildStandardAlert,
  buildOverdueAlert,
  _hooks,
} from './preCheckinAlert';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockFindMany           = jest.fn();
const mockCleaningJobUpdate  = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
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
const BASE_NOW = new Date('2026-07-15T20:00:00.000Z');

function minutesFromNow(mins: number): Date {
  return new Date(BASE_NOW.getTime() + mins * 60_000);
}

function makeJob(overrides: Record<string, any> = {}): any {
  return {
    id:                     'job-1',
    status:                 'scheduled',
    next_booking_id:        'next-bk-1',
    deadline:               minutesFromNow(20),   // 20min away — within default 30min window
    pre_checkin_alert_sent: false,
    property: {
      id:                       'prop-1',
      name:                     'The Beach House',
      pre_checkin_alert_minutes: 30,
    },
    account: {
      id:                  'acct-1',
      business_name:       'Sunny Stays',
      manager_phone:       '+15550001111',
      twilio_phone_number: '+15559998888',
      alert_channel:       'sms',
    },
    cleaner: {
      id:   'cleaner-1',
      name: 'Maria Garcia',
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
  mockCleaningJobUpdate.mockResolvedValue({});
  mockSendManagerSms.mockResolvedValue(undefined);
});

afterEach(() => {
  _hooks.now     = undefined;
  _hooks.smsSend = undefined;
});

// ── AC1: worker.ts registration ───────────────────────────────────────────────

describe('AC1 — worker registration', () => {
  it('registers pre-checkin-alert-check in worker.ts JOB_HANDLERS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain("'pre-checkin-alert-check'");
    expect(src).toContain('preCheckinAlertHandler');
  });
});

// ── AC2: Standard alert (deadline >= NOW(), within window) ───────────────────

describe('AC2 — standard alert', () => {
  it('sends standard alert when deadline is 20min away (within 30min window)', async () => {
    const job = makeJob({ deadline: minutesFromNow(20) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('ALERT:');
    expect(alertText).not.toContain('OVERDUE');
  });

  it('standard alert contains cleaner name from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob({ deadline: minutesFromNow(20) })]);
    await preCheckinAlertHandler();
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Maria Garcia');
  });

  it('standard alert contains property name from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob({ deadline: minutesFromNow(20) })]);
    await preCheckinAlertHandler();
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('The Beach House');
  });

  it('standard alert contains business name from DB', async () => {
    mockFindMany.mockResolvedValue([makeJob({ deadline: minutesFromNow(20) })]);
    await preCheckinAlertHandler();
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Sunny Stays');
  });

  it('sends standard alert when deadline equals NOW() exactly (boundary)', async () => {
    // deadline = now: not overdue (not strictly < now), so standard alert
    const job = makeJob({ deadline: BASE_NOW });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('ALERT:');
    expect(alertText).not.toContain('OVERDUE');
  });

  it('fires for all three incomplete statuses: scheduled, confirmed, no_response', async () => {
    const statuses = ['scheduled', 'confirmed', 'no_response'];
    for (const status of statuses) {
      jest.clearAllMocks();
      mockFindMany.mockResolvedValue([makeJob({ status, deadline: minutesFromNow(20) })]);
      mockCleaningJobUpdate.mockResolvedValue({});
      mockSendManagerSms.mockResolvedValue(undefined);

      await preCheckinAlertHandler();

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    }
  });
});

// ── AC3: Overdue alert (deadline < NOW()) ─────────────────────────────────────

describe('AC3 — overdue alert', () => {
  it('sends overdue alert when deadline is 10min in the past', async () => {
    const job = makeJob({ deadline: minutesFromNow(-10) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('OVERDUE ALERT:');
    expect(alertText).not.toMatch(/^ALERT:/);
  });

  it('overdue alert does NOT contain cleaner name (per PRD template)', async () => {
    const job = makeJob({ deadline: minutesFromNow(-10) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).not.toContain('Maria Garcia');
  });

  it('overdue alert contains property name and business name from DB', async () => {
    const job = makeJob({ deadline: minutesFromNow(-10) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('The Beach House');
    expect(alertText).toContain('Sunny Stays');
  });

  it('sends overdue alert for deadline 2 hours in the past', async () => {
    const job = makeJob({ deadline: minutesFromNow(-120) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('OVERDUE ALERT:');
  });
});

// ── AC4: Outside alert window — skipped ──────────────────────────────────────

describe('AC4 — outside alert window', () => {
  it('skips job when deadline is 45min away (outside 30min window)', async () => {
    const job = makeJob({ deadline: minutesFromNow(45) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).not.toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });

  it('skips job when deadline is exactly at window boundary +1min', async () => {
    const job = makeJob({ deadline: minutesFromNow(31) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).not.toHaveBeenCalled();
  });

  it('respects per-property pre_checkin_alert_minutes from DB (not hardcoded 30)', async () => {
    // Property with 60-minute window — 45min away should fire
    const job = makeJob({
      deadline: minutesFromNow(45),
      property: {
        id:                        'prop-2',
        name:                      'The Cabin',
        pre_checkin_alert_minutes: 60,
      },
    });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
  });

  it('skips job with 15-minute window when deadline is 20min away', async () => {
    const job = makeJob({
      deadline: minutesFromNow(20),
      property: {
        id:                        'prop-2',
        name:                      'The Cabin',
        pre_checkin_alert_minutes: 15,
      },
    });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).not.toHaveBeenCalled();
  });

  it('mixed jobs: alerts only the in-window ones', async () => {
    const inWindow  = makeJob({ id: 'job-1', deadline: minutesFromNow(20) });
    const outWindow = makeJob({ id: 'job-2', deadline: minutesFromNow(45) });
    mockFindMany.mockResolvedValue([inWindow, outWindow]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(1);
    expect(mockCleaningJobUpdate.mock.calls[0][0].where.id).toBe('job-1');
  });

  it('does nothing when no candidates returned', async () => {
    mockFindMany.mockResolvedValue([]);

    await preCheckinAlertHandler();

    expect(mockSendManagerSms).not.toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });
});

// ── AC5: pre_checkin_alert_sent = true ───────────────────────────────────────

describe('AC5 — pre_checkin_alert_sent', () => {
  it('sets pre_checkin_alert_sent = true on successful alert', async () => {
    mockFindMany.mockResolvedValue([makeJob({ deadline: minutesFromNow(20) })]);

    await preCheckinAlertHandler();

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { pre_checkin_alert_sent: true },
    });
  });

  it('sets pre_checkin_alert_sent = true even when sendManagerSms rejects', async () => {
    // sendManagerSms internally handles errors but its outer mock throws here
    mockSendManagerSms.mockRejectedValueOnce(new Error('SMS error'));
    mockFindMany.mockResolvedValue([makeJob({ deadline: minutesFromNow(20) })]);

    await preCheckinAlertHandler();

    // Flag is still set after the attempted send
    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { pre_checkin_alert_sent: true },
    });
  });

  it('sets flag for each job individually', async () => {
    const job1 = makeJob({ id: 'job-1', deadline: minutesFromNow(10) });
    const job2 = makeJob({ id: 'job-2', deadline: minutesFromNow(20) });
    mockFindMany.mockResolvedValue([job1, job2]);

    await preCheckinAlertHandler();

    expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(2);
    const updatedIds = mockCleaningJobUpdate.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).toContain('job-1');
    expect(updatedIds).toContain('job-2');
  });

  it('does NOT set flag for skipped (out-of-window) jobs', async () => {
    mockFindMany.mockResolvedValue([makeJob({ deadline: minutesFromNow(60) })]);

    await preCheckinAlertHandler();

    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });
});

// ── AC6: Eastern Time conversion ─────────────────────────────────────────────

describe('AC6 — Eastern Time conversion', () => {
  it('formats deadline in Eastern Time for standard alert', async () => {
    // BASE_NOW = 2026-07-15T20:00:00Z
    // deadline = T + 20min = 2026-07-15T20:20:00Z = 4:20 PM EDT
    const job = makeJob({ deadline: minutesFromNow(20) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('4:20 PM');
    expect(alertText).toContain('Jul 15, 2026');
  });

  it('formats deadline in Eastern Time for overdue alert', async () => {
    // deadline = T - 10min = 2026-07-15T19:50:00Z = 3:50 PM EDT
    const job = makeJob({ deadline: minutesFromNow(-10) });
    mockFindMany.mockResolvedValue([job]);

    await preCheckinAlertHandler();

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('3:50 PM');
    expect(alertText).toContain('Jul 15, 2026');
  });

  it('findMany query includes correct where clause', async () => {
    await preCheckinAlertHandler();

    const [[args]] = mockFindMany.mock.calls;
    expect(args.where.status).toEqual({ in: ['scheduled', 'confirmed', 'no_response'] });
    expect(args.where.next_booking_id).toEqual({ not: null });
    expect(args.where.deadline).toEqual({ not: null });
    expect(args.where.pre_checkin_alert_sent).toBe(false);
  });
});

// ── Alert builder unit tests ──────────────────────────────────────────────────

describe('buildStandardAlert', () => {
  it('matches PRD Section 7.4 template exactly', () => {
    const msg = buildStandardAlert(
      'Maria Garcia',
      'The Beach House',
      'Jul 15, 2026 4:20 PM EDT',
      'Sunny Stays',
    );
    expect(msg).toBe(
      'ALERT: Maria Garcia has not yet confirmed completion for The Beach House. ' +
      'Next guest checks in at Jul 15, 2026 4:20 PM EDT. ' +
      'Please confirm the property is ready. - Sunny Stays',
    );
  });

  it('contains no hardcoded values', () => {
    const msg = buildStandardAlert('Custom Cleaner', 'Custom Property', 'some time', 'Custom Biz');
    expect(msg).toContain('Custom Cleaner');
    expect(msg).toContain('Custom Property');
    expect(msg).toContain('Custom Biz');
    expect(msg).not.toContain('Maria Garcia');
    expect(msg).not.toContain('The Beach House');
    expect(msg).not.toContain('Sunny Stays');
  });
});

describe('buildOverdueAlert', () => {
  it('matches PRD Section 7.4 overdue template exactly', () => {
    const msg = buildOverdueAlert(
      'The Beach House',
      'Jul 15, 2026 3:50 PM EDT',
      'Sunny Stays',
    );
    expect(msg).toBe(
      'OVERDUE ALERT: Cleaning deadline has passed for The Beach House. ' +
      'Next guest check-in at Jul 15, 2026 3:50 PM EDT is at risk. ' +
      'Please verify property status immediately. - Sunny Stays',
    );
  });

  it('does not include cleaner name (overdue template has no cleaner_name placeholder)', () => {
    const msg = buildOverdueAlert('The Beach House', 'some time', 'Sunny Stays');
    expect(msg).not.toContain('cleaner');
    expect(msg).not.toMatch(/\{\{cleaner/);
  });
});
