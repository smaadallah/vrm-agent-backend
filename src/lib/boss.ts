/**
 * Shared PgBoss singleton.
 *
 * The API server (index.ts) and the worker process (worker.ts) each run in
 * separate Railway services. The API server only needs to *send* jobs; the
 * worker needs to *work* them. Both share this module so they each hold one
 * PgBoss connection rather than creating duplicates.
 *
 * Usage:
 *  - Worker process: call initBoss(boss) after boss.start() so the instance
 *    is available to any module that imports getBoss().
 *  - API server: call getBoss() inside an async handler; it initialises and
 *    starts a send-only instance on first use.
 */

import { PgBoss } from 'pg-boss';
import logger from './logger';

let _boss: PgBoss | null = null;

/**
 * Returns the shared PgBoss instance.
 * Creates and starts a new instance on first call (lazy initialisation).
 */
export async function getBoss(): Promise<PgBoss> {
  if (_boss) return _boss;
  _boss = new PgBoss(process.env.DATABASE_URL!);
  await _boss.start();
  logger.info('pg-boss started (API send-only mode)');
  return _boss;
}

/**
 * Inject an already-started instance — called by the worker process so it
 * shares the same connection it already opened for boss.work() registration.
 */
export function initBoss(boss: PgBoss): void {
  _boss = boss;
}
