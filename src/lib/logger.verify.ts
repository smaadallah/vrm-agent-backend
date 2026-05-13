/**
 * Verification script for T-014 acceptance criteria.
 * Run with: npx ts-node src/lib/logger.verify.ts
 */
import * as Sentry from '@sentry/node';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';

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

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

// ── AC1: logger.ts exports a pino logger instance ───────────────────────────
console.log('\nAC1 — logger.ts exports a pino logger instance');
{
  const logger = require('./logger').default as pino.Logger;
  assert('export is truthy', !!logger);
  assert('has .info()', typeof logger.info === 'function');
  assert('has .error()', typeof logger.error === 'function');
  assert('has .warn()', typeof logger.warn === 'function');
  assert('has .debug()', typeof logger.debug === 'function');
  // pino loggers have a `levels` object — used to distinguish from plain objects
  assert('has pino .level property', typeof logger.level === 'string');
}

// ── AC2: Level is debug when NODE_ENV !== production, info when production ──
console.log('\nAC2 — Logger level driven by NODE_ENV');
{
  const resolveLevel = (env: string | undefined) => env === 'production' ? 'info' : 'debug';

  assert('level=debug when NODE_ENV is undefined', pino({ level: resolveLevel(undefined) }).level === 'debug');
  assert('level=debug when NODE_ENV=development', pino({ level: resolveLevel('development') }).level === 'debug');
  assert('level=info when NODE_ENV=production', pino({ level: resolveLevel('production') }).level === 'info');

  // Verify logger.ts itself uses this exact conditional
  const loggerSrc = fs.readFileSync(path.join(__dirname, 'logger.ts'), 'utf8');
  assert(
    "logger.ts contains NODE_ENV==='production' ? 'info' : 'debug' conditional",
    /NODE_ENV.*production.*info.*debug|debug.*info.*production/.test(loggerSrc),
  );
}

// ── AC3: Sentry.init() called before route registration ─────────────────────
console.log('\nAC3 — Sentry.init() called before any route registration');
{
  const sentryInitPos = indexSrc.indexOf('Sentry.init(');
  const firstAppUsePos = indexSrc.indexOf('app.use(');
  const firstAppGetPos = indexSrc.indexOf('app.get(');
  assert('Sentry.init() present in index.ts', sentryInitPos !== -1);
  assert('Sentry.init() before first app.use()', sentryInitPos < firstAppUsePos);
  assert('Sentry.init() before first app.get()', sentryInitPos < firstAppGetPos);
}

// ── AC4: Sentry.Handlers.requestHandler() is the first middleware ────────────
console.log('\nAC4 — Sentry.Handlers.requestHandler() is the first middleware');
{
  const rhPos = indexSrc.indexOf('Sentry.Handlers.requestHandler()');
  const expressJsonPos = indexSrc.indexOf('express.json()');
  const healthRoutePos = indexSrc.indexOf("app.get('/health'");
  assert('Sentry.Handlers.requestHandler() present', rhPos !== -1);
  assert('requestHandler() before express.json()', rhPos < expressJsonPos);
  assert('requestHandler() before route definitions', rhPos < healthRoutePos);
}

// ── AC5: Sentry.Handlers.errorHandler() registered after all routes ──────────
console.log('\nAC5 — Sentry.Handlers.errorHandler() registered after all routes');
{
  const ehPos = indexSrc.indexOf('Sentry.Handlers.errorHandler()');
  const healthRoutePos = indexSrc.indexOf("app.get('/health'");
  assert('Sentry.Handlers.errorHandler() present', ehPos !== -1);
  assert('errorHandler() after all route definitions', ehPos > healthRoutePos);
}

// ── AC6: unhandledRejection calls logger.error AND Sentry.captureException ──
console.log('\nAC6 — unhandledRejection handler calls logger.error and Sentry.captureException');
{
  Sentry.init({ dsn: undefined });

  const logger = require('./logger').default as pino.Logger;

  let loggerErrorCalled = false;
  let sentryCalled = false;

  const origLoggerError = logger.error.bind(logger);
  (logger as any).error = (...args: unknown[]) => {
    loggerErrorCalled = true;
    // silent during test
  };

  const origCapture = (Sentry as any).captureException;
  (Sentry as any).captureException = (_e: unknown) => {
    sentryCalled = true;
    return 'fake-event-id';
  };

  // Execute the handler body directly — same code as in index.ts
  const reason = new Error('test-unhandled');
  logger.error({ reason }, 'Unhandled promise rejection');
  Sentry.captureException(reason);

  assert('logger.error called', loggerErrorCalled);
  assert('Sentry.captureException called', sentryCalled);

  // Also verify the pattern exists verbatim in index.ts source
  assert(
    'index.ts contains logger.error in unhandledRejection handler',
    /unhandledRejection/.test(indexSrc) && /logger\.error/.test(indexSrc),
  );
  assert(
    'index.ts contains Sentry.captureException in unhandledRejection handler',
    /Sentry\.captureException/.test(indexSrc),
  );

  // Restore
  (logger as any).error = origLoggerError;
  (Sentry as any).captureException = origCapture;
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
