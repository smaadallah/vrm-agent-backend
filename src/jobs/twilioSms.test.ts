/**
 * T-038 — twilioSms tests
 *
 * AC1: boss.work("process-twilio-sms") registered in worker.ts
 * AC2: Duplicate MessageSid → discarded
 * AC3: Unknown phone → logged and discarded
 * AC4: Cleaner with 2+ open jobs → multi-job guard alert; MessageSid appended; routing skipped
 * AC5: "confirm" → confirmHandler; "done" → doneHandler; "low:" → lowHandler
 * AC6: Unrecognized body → logged and discarded
 * AC7: Multi-job alert uses business_name from DB
 */

import fs from 'fs';
import path from 'path';

import { processTwilioSmsHandler, confirmHandler, doneHandler, lowHandler, _hooks } from './twilioSms';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockCleaningJobFindFirst  = jest.fn();
const mockCleaningJobFindMany   = jest.fn();
const mockCleaningJobFindUnique = jest.fn();
const mockCleaningJobUpdate     = jest.fn();
const mockCleanerFindFirst      = jest.fn();
const mockAccountFindUnique     = jest.fn();
const mockTurnoverChecklistFindFirst = jest.fn();
const mockPropertiesUpdate      = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    cleaning_jobs: {
      findFirst:  (...a: any[]) => mockCleaningJobFindFirst(...a),
      findMany:   (...a: any[]) => mockCleaningJobFindMany(...a),
      findUnique: (...a: any[]) => mockCleaningJobFindUnique(...a),
      update:     (...a: any[]) => mockCleaningJobUpdate(...a),
    },
    cleaners: {
      findFirst: (...a: any[]) => mockCleanerFindFirst(...a),
    },
    accounts: {
      findUnique: (...a: any[]) => mockAccountFindUnique(...a),
    },
    turnover_checklists: {
      findFirst: (...a: any[]) => mockTurnoverChecklistFindFirst(...a),
    },
    properties: {
      update: (...a: any[]) => mockPropertiesUpdate(...a),
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

function makePayload(overrides: Partial<{ MessageSid: string; From: string; Body: string }> = {}) {
  return {
    MessageSid: 'SM-test-001',
    From:       '+15557776666',
    Body:       'confirm',
    ...overrides,
  };
}

function makeCleaner(overrides: Record<string, any> = {}) {
  return {
    id:         'cleaner-1',
    name:       'Maria Garcia',
    phone:      '+15557776666',
    account_id: 'acct-1',
    is_active:  true,
    ...overrides,
  };
}

function makeAccount(overrides: Record<string, any> = {}) {
  return {
    id:                  'acct-1',
    business_name:       'Sunny Stays',
    manager_phone:       '+15550001111',
    twilio_phone_number: '+15559998888',
    alert_channel:       'sms',
    token_version:       1,
    ...overrides,
  };
}

function makeOpenJob(id = 'job-1', propertyName = 'The Beach House') {
  return {
    id,
    inbound_sms_sids: [] as string[],
    property: { name: propertyName },
  };
}

function makeCleaningJob(overrides: Record<string, any> = {}) {
  return {
    id:               'job-1',
    status:           'scheduled',
    checklist_sent:   false,
    checklist_sent_at: null,
    property_id:      'prop-1',
    account_id:       'acct-1',
    cleaner_id:       'cleaner-1',
    inbound_sms_sids: [] as string[],
    cleaner:  { name: 'Maria Garcia', phone: '+15557776666' },
    account:  makeAccount(),
    property: { name: 'The Beach House' },
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  mockCleaningJobFindFirst.mockResolvedValue(null);
  mockCleanerFindFirst.mockResolvedValue(makeCleaner());
  mockCleaningJobFindMany.mockResolvedValue([makeOpenJob()]);
  mockCleaningJobFindUnique.mockResolvedValue(makeCleaningJob());
  mockCleaningJobUpdate.mockResolvedValue({});
  mockAccountFindUnique.mockResolvedValue(makeAccount());
  mockTurnoverChecklistFindFirst.mockResolvedValue({ checklist_body: 'Check all rooms\nClean bathroom' });
  mockPropertiesUpdate.mockResolvedValue({});
  mockSendManagerSms.mockResolvedValue(undefined);

  _hooks.confirmHandler = undefined;
  _hooks.doneHandler    = undefined;
  _hooks.lowHandler     = undefined;
  _hooks.smsSend        = undefined;
  _hooks.retryDelayMs   = undefined;
});

afterEach(() => {
  _hooks.confirmHandler = undefined;
  _hooks.doneHandler    = undefined;
  _hooks.lowHandler     = undefined;
  _hooks.smsSend        = undefined;
  _hooks.retryDelayMs   = undefined;
});

// ── AC1: worker.ts registration ───────────────────────────────────────────────

describe('AC1 — worker.ts registration', () => {
  it('registers process-twilio-sms in WEBHOOK_JOBS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../worker.ts'), 'utf8');
    expect(src).toContain("'process-twilio-sms'");
    expect(src).toContain('processTwilioSmsHandler');
  });
});

// ── AC2: Duplicate MessageSid ─────────────────────────────────────────────────

describe('AC2 — duplicate MessageSid discarded', () => {
  it('discards when MessageSid found in recent job', async () => {
    mockCleaningJobFindFirst.mockResolvedValue({ id: 'job-existing' });

    await processTwilioSmsHandler({ data: makePayload() });

    expect(mockCleanerFindFirst).not.toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });

  it('logs info on discard', async () => {
    mockCleaningJobFindFirst.mockResolvedValue({ id: 'job-existing' });

    await processTwilioSmsHandler({ data: makePayload({ MessageSid: 'SM-dup' }) });

    expect(require('../lib/logger').default.info).toHaveBeenCalledWith(
      expect.objectContaining({ MessageSid: 'SM-dup' }),
      expect.stringContaining('duplicate'),
    );
  });

  it('proceeds when MessageSid not found in any job', async () => {
    mockCleaningJobFindFirst.mockResolvedValue(null);

    await processTwilioSmsHandler({ data: makePayload() });

    expect(mockCleanerFindFirst).toHaveBeenCalledTimes(1);
  });
});

// ── AC3: Unknown phone discarded ─────────────────────────────────────────────

describe('AC3 — unknown phone discarded', () => {
  it('discards when cleaner not found', async () => {
    mockCleanerFindFirst.mockResolvedValue(null);

    await processTwilioSmsHandler({ data: makePayload({ From: '+19990001111' }) });

    expect(mockCleaningJobFindMany).not.toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });

  it('logs warn on unknown phone', async () => {
    mockCleanerFindFirst.mockResolvedValue(null);

    await processTwilioSmsHandler({ data: makePayload({ From: '+19990001111' }) });

    expect(require('../lib/logger').default.warn).toHaveBeenCalled();
  });
});

// ── AC4: Multi-job guard ──────────────────────────────────────────────────────

describe('AC4 — multi-job guard with 2+ open jobs', () => {
  beforeEach(() => {
    mockCleaningJobFindMany.mockResolvedValue([
      makeOpenJob('job-1', 'Beach House'),
      makeOpenJob('job-2', 'Mountain Cabin'),
    ]);
  });

  it('appends MessageSid to first open job', async () => {
    await processTwilioSmsHandler({ data: makePayload({ MessageSid: 'SM-multi' }) });

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { inbound_sms_sids: { push: 'SM-multi' } },
    });
  });

  it('sends manager alert', async () => {
    await processTwilioSmsHandler({ data: makePayload() });

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke confirm/done/low handlers', async () => {
    const confirmMock = jest.fn().mockResolvedValue(undefined);
    const doneMock    = jest.fn().mockResolvedValue(undefined);
    const lowMock     = jest.fn().mockResolvedValue(undefined);
    _hooks.confirmHandler = confirmMock;
    _hooks.doneHandler    = doneMock;
    _hooks.lowHandler     = lowMock;

    await processTwilioSmsHandler({ data: makePayload() });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(doneMock).not.toHaveBeenCalled();
    expect(lowMock).not.toHaveBeenCalled();
  });

  it('only appends MessageSid once (one update call total)', async () => {
    await processTwilioSmsHandler({ data: makePayload() });

    expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── AC5: Routing ──────────────────────────────────────────────────────────────

describe('AC5 — SMS body routing', () => {
  const confirmBodies = ['confirm', 'CONFIRM', 'Confirm', 'confirm yes', 'confirm,ok'];
  const doneBodies    = ['done', 'DONE', 'Done', 'done thanks', 'done,'];

  for (const body of confirmBodies) {
    it(`routes "${body}" to confirmHandler`, async () => {
      const mock = jest.fn().mockResolvedValue(undefined);
      _hooks.confirmHandler = mock;

      await processTwilioSmsHandler({ data: makePayload({ Body: body }) });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }));
    });
  }

  for (const body of doneBodies) {
    it(`routes "${body}" to doneHandler`, async () => {
      const mock = jest.fn().mockResolvedValue(undefined);
      _hooks.doneHandler = mock;

      await processTwilioSmsHandler({ data: makePayload({ Body: body }) });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), body);
    });
  }

  it('routes "low: items" to lowHandler', async () => {
    const mock = jest.fn().mockResolvedValue(undefined);
    _hooks.lowHandler = mock;

    await processTwilioSmsHandler({ data: makePayload({ Body: 'low: soap, shampoo' }) });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      'soap, shampoo',
    );
  });

  it('routes "LOW: items" (uppercase) to lowHandler', async () => {
    const mock = jest.fn().mockResolvedValue(undefined);
    _hooks.lowHandler = mock;

    await processTwilioSmsHandler({ data: makePayload({ Body: 'LOW: toilet paper' }) });

    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// ── AC6: Unrecognized body ────────────────────────────────────────────────────

describe('AC6 — unrecognized body', () => {
  it('logs warn for unrecognized body', async () => {
    await processTwilioSmsHandler({ data: makePayload({ Body: 'hello, is anyone there?' }) });

    expect(require('../lib/logger').default.warn).toHaveBeenCalled();
  });

  it('still appends MessageSid before discarding unrecognized body', async () => {
    await processTwilioSmsHandler({ data: makePayload({ Body: 'hello' }) });

    expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(1);
    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { inbound_sms_sids: { push: 'SM-test-001' } },
    });
  });

  it('does not call any routing handler for unrecognized body', async () => {
    const confirmMock = jest.fn().mockResolvedValue(undefined);
    const doneMock    = jest.fn().mockResolvedValue(undefined);
    const lowMock     = jest.fn().mockResolvedValue(undefined);
    _hooks.confirmHandler = confirmMock;
    _hooks.doneHandler    = doneMock;
    _hooks.lowHandler     = lowMock;

    await processTwilioSmsHandler({ data: makePayload({ Body: 'random text' }) });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(doneMock).not.toHaveBeenCalled();
    expect(lowMock).not.toHaveBeenCalled();
  });
});

// ── AC7: Multi-job alert uses business_name from DB ──────────────────────────

describe('AC7 — multi-job alert uses DB business_name', () => {
  beforeEach(() => {
    mockCleaningJobFindMany.mockResolvedValue([
      makeOpenJob('job-1', 'Beach House'),
      makeOpenJob('job-2', 'Mountain Cabin'),
    ]);
  });

  it('alert contains business_name from DB (not hardcoded)', async () => {
    mockAccountFindUnique.mockResolvedValue(makeAccount({ business_name: 'Premier Stays LLC' }));

    await processTwilioSmsHandler({ data: makePayload() });

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Premier Stays LLC');
  });

  it('alert contains cleaner name from DB', async () => {
    await processTwilioSmsHandler({ data: makePayload() });

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Maria Garcia');
  });

  it('alert contains cleaner phone from DB', async () => {
    await processTwilioSmsHandler({ data: makePayload() });

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('+15557776666');
  });

  it('alert contains all property names from DB', async () => {
    await processTwilioSmsHandler({ data: makePayload() });

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Beach House');
    expect(alertText).toContain('Mountain Cabin');
  });

  it('different business_name produces different alert', async () => {
    mockAccountFindUnique.mockResolvedValue(makeAccount({ business_name: 'Dynamic Name XYZ' }));

    await processTwilioSmsHandler({ data: makePayload() });

    const alertText: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertText).toContain('Dynamic Name XYZ');
    expect(alertText).not.toContain('Sunny Stays');
  });
});

// ── 0 open jobs — orphaned ────────────────────────────────────────────────────

describe('0 open jobs — orphaned SMS', () => {
  it('logs warn and discards when no open jobs', async () => {
    mockCleaningJobFindMany.mockResolvedValue([]);

    await processTwilioSmsHandler({ data: makePayload() });

    expect(require('../lib/logger').default.warn).toHaveBeenCalled();
    expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
  });

  it('does not send manager alert for orphaned SMS', async () => {
    mockCleaningJobFindMany.mockResolvedValue([]);

    await processTwilioSmsHandler({ data: makePayload() });

    expect(mockSendManagerSms).not.toHaveBeenCalled();
  });
});

// ── MessageSid appended for single open job ───────────────────────────────────

describe('MessageSid appended on single open job', () => {
  it('appends MessageSid before routing', async () => {
    const mock = jest.fn().mockResolvedValue(undefined);
    _hooks.confirmHandler = mock;

    await processTwilioSmsHandler({ data: makePayload({ MessageSid: 'SM-confirm-001' }) });

    expect(mockCleaningJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data:  { inbound_sms_sids: { push: 'SM-confirm-001' } },
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T-040 — confirmHandler (Feature 2.2 — Turnover Checklist Delivery)
// ══════════════════════════════════════════════════════════════════════════════

describe('confirmHandler', () => {
  beforeEach(() => {
    _hooks.smsSend      = jest.fn().mockResolvedValue(undefined);
    _hooks.retryDelayMs = 0;
  });

  // ── AC1: not a stub ─────────────────────────────────────────────────────────

  describe('AC1 — confirmHandler is not a stub', () => {
    it('source no longer contains stub log message', () => {
      const src = fs.readFileSync(path.resolve(__dirname, './twilioSms.ts'), 'utf8');
      expect(src).not.toContain("'twilioSms: CONFIRM received (stub)'");
    });

    it('fetches the cleaning_job from DB (not a no-op)', async () => {
      await confirmHandler(makeOpenJob());
      expect(mockCleaningJobFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC2: Duplicate CONFIRM discarded ─────────────────────────────────────────

  describe('AC2 — duplicate CONFIRM discarded', () => {
    it('discards when status = confirmed AND checklist_sent = true', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({ status: 'confirmed', checklist_sent: true }),
      );

      await confirmHandler(makeOpenJob());

      // No status update, no SMS
      expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
      expect(_hooks.smsSend).not.toHaveBeenCalled();
    });

    it('does NOT discard when status = confirmed but checklist_sent = false', async () => {
      // confirmed + NOT sent → not a duplicate, should proceed (but status guard stops it)
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({ status: 'confirmed', checklist_sent: false }),
      );

      await confirmHandler(makeOpenJob());

      // Status guard: 'confirmed' is not in ['scheduled','no_response'] → discards with warn
      expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
    });
  });

  // ── AC3: status = confirmed + cleaner_confirmed_at set ──────────────────────

  describe('AC3 — status update', () => {
    it('sets status = confirmed on the cleaning job', async () => {
      await confirmHandler(makeOpenJob());

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data:  expect.objectContaining({ status: 'confirmed' }),
        }),
      );
    });

    it('sets cleaner_confirmed_at to a Date', async () => {
      await confirmHandler(makeOpenJob());

      const statusUpdateCall = mockCleaningJobUpdate.mock.calls.find(
        call => call[0].data?.status === 'confirmed',
      );
      expect(statusUpdateCall?.[0].data.cleaner_confirmed_at).toBeInstanceOf(Date);
    });

    it('also works when job has status = no_response', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({ status: 'no_response' }),
      );

      await confirmHandler(makeOpenJob());

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'confirmed' }),
        }),
      );
    });
  });

  // ── AC4: Blank/missing checklist → manager alerted; no SMS to cleaner ───────

  describe('AC4 — blank or missing checklist', () => {
    it('sends manager alert when checklist_body is empty string', async () => {
      mockTurnoverChecklistFindFirst.mockResolvedValue({ checklist_body: '' });

      await confirmHandler(makeOpenJob());

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
      expect(_hooks.smsSend).not.toHaveBeenCalled();
    });

    it('sends manager alert when checklist_body is whitespace only', async () => {
      mockTurnoverChecklistFindFirst.mockResolvedValue({ checklist_body: '   \n  ' });

      await confirmHandler(makeOpenJob());

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
      expect(_hooks.smsSend).not.toHaveBeenCalled();
    });

    it('sends manager alert when no checklist row exists', async () => {
      mockTurnoverChecklistFindFirst.mockResolvedValue(null);

      await confirmHandler(makeOpenJob());

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
      expect(_hooks.smsSend).not.toHaveBeenCalled();
    });

    it('job is still confirmed when checklist is blank', async () => {
      mockTurnoverChecklistFindFirst.mockResolvedValue({ checklist_body: '' });

      await confirmHandler(makeOpenJob());

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'confirmed' }),
        }),
      );
    });

    it('does NOT set checklist_sent = true when checklist is blank', async () => {
      mockTurnoverChecklistFindFirst.mockResolvedValue({ checklist_body: '' });

      await confirmHandler(makeOpenJob());

      const checklistSentCall = mockCleaningJobUpdate.mock.calls.find(
        call => call[0].data?.checklist_sent === true,
      );
      expect(checklistSentCall).toBeUndefined();
    });
  });

  // ── AC5: Checklist SMS sent with checklist_body from DB ──────────────────────

  describe('AC5 — checklist SMS body from DB', () => {
    it('sends SMS to cleaner phone', async () => {
      await confirmHandler(makeOpenJob());

      const [to] = (_hooks.smsSend as jest.Mock).mock.calls[0];
      expect(to).toBe('+15557776666');
    });

    it('sends SMS from account twilio_phone_number', async () => {
      await confirmHandler(makeOpenJob());

      const [, from] = (_hooks.smsSend as jest.Mock).mock.calls[0];
      expect(from).toBe('+15559998888');
    });

    it('SMS body contains checklist_body from DB', async () => {
      mockTurnoverChecklistFindFirst.mockResolvedValue({
        checklist_body: 'Bedroom: change sheets\nBathroom: scrub toilet',
      });

      await confirmHandler(makeOpenJob());

      const [, , body] = (_hooks.smsSend as jest.Mock).mock.calls[0];
      expect(body).toContain('Bedroom: change sheets');
      expect(body).toContain('Bathroom: scrub toilet');
    });
  });

  // ── AC6: checklist_sent = true on success ────────────────────────────────────

  describe('AC6 — checklist_sent flags on SMS success', () => {
    it('sets checklist_sent = true', async () => {
      await confirmHandler(makeOpenJob());

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data:  expect.objectContaining({ checklist_sent: true }),
        }),
      );
    });

    it('sets checklist_sent_at to a Date', async () => {
      await confirmHandler(makeOpenJob());

      const flagCall = mockCleaningJobUpdate.mock.calls.find(
        call => call[0].data?.checklist_sent === true,
      );
      expect(flagCall?.[0].data.checklist_sent_at).toBeInstanceOf(Date);
    });

    it('does NOT set checklist_sent = true when SMS permanently fails', async () => {
      (_hooks.smsSend as jest.Mock).mockRejectedValue(new Error('Twilio error'));

      await confirmHandler(makeOpenJob());

      const flagCall = mockCleaningJobUpdate.mock.calls.find(
        call => call[0].data?.checklist_sent === true,
      );
      expect(flagCall).toBeUndefined();
    });

    it('sends manager alert when SMS permanently fails', async () => {
      (_hooks.smsSend as jest.Mock).mockRejectedValue(new Error('Twilio error'));

      await confirmHandler(makeOpenJob());

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('SEND FAILURE');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T-041 — doneHandler (Feature 2.3 — Completion Confirmation / DONE Handler)
// ══════════════════════════════════════════════════════════════════════════════

describe('doneHandler', () => {
  beforeEach(() => {
    _hooks.smsSend      = jest.fn().mockResolvedValue(undefined);
    _hooks.retryDelayMs = 0;
    mockCleaningJobFindUnique.mockResolvedValue(makeCleaningJob({ status: 'confirmed' }));
  });

  // ── AC1: not a stub — DB calls are made ─────────────────────────────────────

  describe('AC1 — doneHandler is not a stub', () => {
    it('source no longer contains stub log message', () => {
      const src = fs.readFileSync(path.resolve(__dirname, './twilioSms.ts'), 'utf8');
      expect(src).not.toContain("'twilioSms: DONE received (stub)'");
    });

    it('fetches the cleaning_job from DB (not a no-op)', async () => {
      await doneHandler(makeOpenJob(), 'done');
      expect(mockCleaningJobFindUnique).toHaveBeenCalledTimes(1);
    });

    it('updates cleaning_job status in DB', async () => {
      await doneHandler(makeOpenJob(), 'done');
      expect(mockCleaningJobUpdate).toHaveBeenCalled();
    });
  });

  // ── AC2: status, closed_by, completion_sms_raw stored correctly ─────────────

  describe('AC2 — completion fields written to DB', () => {
    it('sets status = completed', async () => {
      await doneHandler(makeOpenJob(), 'done');

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data:  expect.objectContaining({ status: 'completed' }),
        }),
      );
    });

    it('sets closed_by = cleaner_sms', async () => {
      await doneHandler(makeOpenJob(), 'done');

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ closed_by: 'cleaner_sms' }),
        }),
      );
    });

    it('stores completion_sms_raw with original body text', async () => {
      const rawBody = 'done great job today!';
      await doneHandler(makeOpenJob(), rawBody);

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ completion_sms_raw: rawBody }),
        }),
      );
    });

    it('sets completed_at to a Date', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const call = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.status === 'completed',
      );
      expect(call?.[0].data.completed_at).toBeInstanceOf(Date);
    });

    it('marks property as guest_ready', async () => {
      await doneHandler(makeOpenJob(), 'done');

      expect(mockPropertiesUpdate).toHaveBeenCalledWith({
        where: { id: 'prop-1' },
        data:  { property_status: 'guest_ready' },
      });
    });

    it('also processes status = scheduled jobs', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(makeCleaningJob({ status: 'scheduled' }));

      await doneHandler(makeOpenJob(), 'done');

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'completed' }),
        }),
      );
    });

    it('discards silently when already completed', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(makeCleaningJob({ status: 'completed' }));

      await doneHandler(makeOpenJob(), 'done');

      expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
    });

    it('discards with warn for invalid status', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(makeCleaningJob({ status: 'cancelled' }));

      await doneHandler(makeOpenJob(), 'done');

      expect(mockCleaningJobUpdate).not.toHaveBeenCalled();
      expect(require('../lib/logger').default.warn).toHaveBeenCalled();
    });
  });

  // ── AC3: damage_fyi_sent = true in the SAME update call as status ────────────

  describe('AC3 — damage_fyi_sent is atomic with status update', () => {
    const damageBodies = [
      'done, the mirror is broken',
      'Done! There is a stain on the carpet',
      'done. Found a leak under the sink',
      'done cracked tile in bathroom',
      'done something is not working',
    ];

    for (const body of damageBodies) {
      it(`damage detected in "${body.slice(0, 40)}" — damage_fyi_sent = true in same update`, async () => {
        await doneHandler(makeOpenJob(), body);

        const statusCall = mockCleaningJobUpdate.mock.calls.find(
          c => c[0].data?.status === 'completed',
        );
        expect(statusCall).toBeDefined();
        expect(statusCall![0].data.damage_fyi_sent).toBe(true);
      });
    }

    it('damage_fyi_sent NOT included in update when no damage detected', async () => {
      await doneHandler(makeOpenJob(), 'done, everything looks good');

      const statusCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.status === 'completed',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![0].data.damage_fyi_sent).toBeUndefined();
    });

    it('damage NOT falsely detected in low: items section', async () => {
      await doneHandler(makeOpenJob(), 'done low: broken soap dispenser');

      const statusCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.status === 'completed',
      );
      // 'broken' is in the low: section, should NOT trigger damage flag
      expect(statusCall![0].data.damage_fyi_sent).toBeUndefined();
    });

    it('damage NOT falsely detected in done: prefix itself', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const statusCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.status === 'completed',
      );
      expect(statusCall![0].data.damage_fyi_sent).toBeUndefined();
    });
  });

  // ── AC4: FYI alert failure does not revert damage_fyi_sent ──────────────────

  describe('AC4 — FYI alert failure does not revert damage_fyi_sent', () => {
    it('damage_fyi_sent stays true even when sendManagerSms throws', async () => {
      mockSendManagerSms.mockRejectedValueOnce(new Error('SMS gateway down'));

      await doneHandler(makeOpenJob(), 'done, broken window');

      // The DB update with damage_fyi_sent = true was already committed before the alert
      const statusCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.status === 'completed',
      );
      expect(statusCall![0].data.damage_fyi_sent).toBe(true);
      // Only one DB update call (no revert call)
      expect(mockCleaningJobUpdate).toHaveBeenCalledTimes(1);
    });

    it('logs error when damage FYI alert fails, but does not rethrow', async () => {
      mockSendManagerSms.mockRejectedValueOnce(new Error('SMS gateway down'));

      await expect(doneHandler(makeOpenJob(), 'done, broken window')).resolves.toBeUndefined();
      expect(require('../lib/logger').default.error).toHaveBeenCalled();
    });

    it('sends manager damage FYI when damage detected', async () => {
      await doneHandler(makeOpenJob(), 'done, cracked tile');

      const damageSmsCall = mockSendManagerSms.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('DAMAGE REPORT'),
      );
      expect(damageSmsCall).toBeDefined();
    });

    it('does NOT send damage FYI when no damage detected', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const damageSmsCall = mockSendManagerSms.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('DAMAGE REPORT'),
      );
      expect(damageSmsCall).toBeUndefined();
    });
  });

  // ── AC5: lowHandler called when body contains "low:" ────────────────────────

  describe('AC5 — lowHandler called for low: content', () => {
    it('calls lowHandler when body contains "low:"', async () => {
      const lowMock = jest.fn().mockResolvedValue(undefined);
      _hooks.lowHandler = lowMock;

      await doneHandler(makeOpenJob(), 'done low: soap, shampoo');

      expect(lowMock).toHaveBeenCalledTimes(1);
      expect(lowMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1' }),
        'soap, shampoo',
      );
    });

    it('does NOT call lowHandler when body has no "low:"', async () => {
      const lowMock = jest.fn().mockResolvedValue(undefined);
      _hooks.lowHandler = lowMock;

      await doneHandler(makeOpenJob(), 'done, all clean');

      expect(lowMock).not.toHaveBeenCalled();
    });

    it('parses items correctly after "low:" prefix', async () => {
      const lowMock = jest.fn().mockResolvedValue(undefined);
      _hooks.lowHandler = lowMock;

      await doneHandler(makeOpenJob(), 'done low: toilet paper, hand soap, coffee pods');

      const items: string = lowMock.mock.calls[0][1];
      expect(items).toBe('toilet paper, hand soap, coffee pods');
    });
  });

  // ── AC6: completion ack and manager notification sent ────────────────────────

  describe('AC6 — completion ack and manager notification', () => {
    it('sends completion ack SMS to cleaner', async () => {
      await doneHandler(makeOpenJob(), 'done');

      expect(_hooks.smsSend).toHaveBeenCalled();
      const ackCall = (_hooks.smsSend as jest.Mock).mock.calls.find(
        c => typeof c[2] === 'string' && c[2].includes('marked complete'),
      );
      expect(ackCall).toBeDefined();
    });

    it('ack SMS is sent to cleaner phone', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const ackCall = (_hooks.smsSend as jest.Mock).mock.calls.find(
        c => typeof c[2] === 'string' && c[2].includes('marked complete'),
      );
      expect(ackCall?.[0]).toBe('+15557776666');
    });

    it('ack SMS is sent from account twilio_phone_number', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const ackCall = (_hooks.smsSend as jest.Mock).mock.calls.find(
        c => typeof c[2] === 'string' && c[2].includes('marked complete'),
      );
      expect(ackCall?.[1]).toBe('+15559998888');
    });

    it('sends manager completion notification', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const managerCall = mockSendManagerSms.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('COMPLETED'),
      );
      expect(managerCall).toBeDefined();
    });

    it('manager notification contains property name and cleaner name', async () => {
      await doneHandler(makeOpenJob(), 'done');

      const managerCall = mockSendManagerSms.mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('COMPLETED'),
      );
      expect(managerCall?.[1]).toContain('The Beach House');
      expect(managerCall?.[1]).toContain('Maria Garcia');
    });

    it('does not throw when completion ack SMS permanently fails (Rule 3)', async () => {
      (_hooks.smsSend as jest.Mock).mockRejectedValue(new Error('Twilio error'));

      await expect(doneHandler(makeOpenJob(), 'done')).resolves.toBeUndefined();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T-042 — lowHandler (Feature 2.4 — Supply Restocking Alert)
// ══════════════════════════════════════════════════════════════════════════════

describe('lowHandler', () => {
  beforeEach(() => {
    mockCleaningJobFindUnique.mockResolvedValue(
      makeCleaningJob({ supply_flags: null }),
    );
  });

  // ── AC1: supply_flags stored on cleaning job ─────────────────────────────────

  describe('AC1 — supply_flags stored on cleaning job', () => {
    it('"towels, soap" → supply_flags = ["towels", "soap"]', async () => {
      await lowHandler(makeOpenJob(), 'towels, soap');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['towels', 'soap']);
    });

    it('whitespace around items is trimmed', async () => {
      await lowHandler(makeOpenJob(), '  towels  ,  soap  ');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['towels', 'soap']);
    });

    it('items are normalized to lowercase', async () => {
      await lowHandler(makeOpenJob(), 'Towels, SOAP, Hand Lotion');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['towels', 'soap', 'hand lotion']);
    });

    it('single item stored correctly', async () => {
      await lowHandler(makeOpenJob(), 'toilet paper');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['toilet paper']);
    });
  });

  // ── AC2: deduplication (case-insensitive) when merging ───────────────────────

  describe('AC2 — deduplication against existing supply_flags', () => {
    it('existing item not duplicated (exact match)', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({ supply_flags: ['towels'] }),
      );

      await lowHandler(makeOpenJob(), 'towels, soap');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['towels', 'soap']);
    });

    it('existing item not duplicated (case-insensitive match)', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({ supply_flags: ['towels'] }),
      );

      await lowHandler(makeOpenJob(), 'Towels, Soap');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['towels', 'soap']);
    });

    it('duplicate items within the new message are deduplicated', async () => {
      await lowHandler(makeOpenJob(), 'soap, SOAP, Soap');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['soap']);
    });

    it('null supply_flags treated as empty list', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({ supply_flags: null }),
      );

      await lowHandler(makeOpenJob(), 'towels');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall![0].data.supply_flags).toEqual(['towels']);
    });
  });

  // ── AC3: zero parsed items → generic alert, supply_alert_sent = true ─────────

  describe('AC3 — zero items: generic alert + supply_alert_sent', () => {
    it('sends generic alert when items string is empty', async () => {
      await lowHandler(makeOpenJob(), '');

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    });

    it('sends generic alert when items string is whitespace only', async () => {
      await lowHandler(makeOpenJob(), '   ');

      expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    });

    it('sets supply_alert_sent = true when 0 items', async () => {
      await lowHandler(makeOpenJob(), '');

      expect(mockCleaningJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data:  expect.objectContaining({ supply_alert_sent: true }),
        }),
      );
    });

    it('does NOT update supply_flags when 0 items', async () => {
      await lowHandler(makeOpenJob(), '');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall).toBeUndefined();
    });

    it('generic alert contains business_name', async () => {
      await lowHandler(makeOpenJob(), '');

      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('Sunny Stays');
    });
  });

  // ── AC4: supply_alert_sent + supply_alert_sent_at on success ─────────────────

  describe('AC4 — supply_alert_sent and supply_alert_sent_at on success', () => {
    it('sets supply_alert_sent = true on success', async () => {
      await lowHandler(makeOpenJob(), 'towels, soap');

      const sentCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.supply_alert_sent === true,
      );
      expect(sentCall).toBeDefined();
    });

    it('sets supply_alert_sent_at to a Date on success', async () => {
      await lowHandler(makeOpenJob(), 'towels, soap');

      const sentCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.supply_alert_sent === true,
      );
      expect(sentCall![0].data.supply_alert_sent_at).toBeInstanceOf(Date);
    });

    it('supply_alert_sent NOT set when send fails', async () => {
      mockSendManagerSms.mockRejectedValueOnce(new Error('Twilio down'));

      await lowHandler(makeOpenJob(), 'towels, soap');

      const sentCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.supply_alert_sent === true,
      );
      expect(sentCall).toBeUndefined();
    });
  });

  // ── AC5: permanent failure → supply_alert_permanently_failed = true ──────────

  describe('AC5 — permanent failure sets supply_alert_permanently_failed', () => {
    it('sets supply_alert_permanently_failed = true when send fails', async () => {
      mockSendManagerSms.mockRejectedValueOnce(new Error('Twilio down'));

      await lowHandler(makeOpenJob(), 'towels, soap');

      const failCall = mockCleaningJobUpdate.mock.calls.find(
        c => c[0].data?.supply_alert_permanently_failed === true,
      );
      expect(failCall).toBeDefined();
    });

    it('does not throw on permanent failure', async () => {
      mockSendManagerSms.mockRejectedValueOnce(new Error('Twilio down'));

      await expect(lowHandler(makeOpenJob(), 'towels, soap')).resolves.toBeUndefined();
    });

    it('supply_flags still written to DB even when alert fails', async () => {
      mockSendManagerSms.mockRejectedValueOnce(new Error('Twilio down'));

      await lowHandler(makeOpenJob(), 'towels, soap');

      const flagsCall = mockCleaningJobUpdate.mock.calls.find(
        c => Array.isArray(c[0].data?.supply_flags),
      );
      expect(flagsCall).toBeDefined();
    });
  });

  // ── AC6: alert text uses business_name from DB ───────────────────────────────

  describe('AC6 — alert text uses business_name from DB', () => {
    it('alert contains business_name from DB', async () => {
      await lowHandler(makeOpenJob(), 'towels');

      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('Sunny Stays');
    });

    it('different business_name produces different alert text', async () => {
      mockCleaningJobFindUnique.mockResolvedValue(
        makeCleaningJob({
          supply_flags: null,
          account: makeAccount({ business_name: 'Premier Rentals LLC' }),
        }),
      );

      await lowHandler(makeOpenJob(), 'towels');

      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('Premier Rentals LLC');
      expect(alertText).not.toContain('Sunny Stays');
    });

    it('alert contains property name from DB', async () => {
      await lowHandler(makeOpenJob(), 'soap');

      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('The Beach House');
    });

    it('alert contains cleaner name from DB', async () => {
      await lowHandler(makeOpenJob(), 'soap');

      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('Maria Garcia');
    });

    it('alert contains the item names', async () => {
      await lowHandler(makeOpenJob(), 'shampoo, conditioner');

      const alertText: string = mockSendManagerSms.mock.calls[0][1];
      expect(alertText).toContain('shampoo');
      expect(alertText).toContain('conditioner');
    });
  });
});
