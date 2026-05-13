import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';

dotenv.config();

// Sentry must be initialized before any Express setup or route registration
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});

import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import logger from './lib/logger';
import { authLimiter, webhookLimiter, apiLimiter } from './middleware/rateLimiting';
import authRouter from './routes/auth';
import webhooksRouter from './routes/webhooks';
import messagesRouter from './routes/messages';
import bookingsRouter from './routes/bookings';
import propertiesRouter from './routes/properties';
import cleanersRouter from './routes/cleaners';
import { accountRouter, settingsRouter } from './routes/settings';
import searchRouter from './routes/search';
import cleaningJobsRouter from './routes/cleaningJobs';
import workOrdersRouter from './routes/workOrders';
import reviewDraftsRouter from './routes/reviewDrafts';

const app = express();
const PORT = process.env.PORT ?? 3000;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
].filter(Boolean) as string[];

// Sentry request handler must be the very first middleware
app.use(Sentry.Handlers.requestHandler());

// CORS — allowlist only known frontend origin and localhost:3000
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }),
);

// Webhook routes are mounted before express.json() so they receive the raw body
// buffer needed for HMAC signature validation.
// express.raw captures all webhook content types as a Buffer so req.rawBody is
// always the exact bytes used for HMAC verification — critical for Twilio, which
// sends application/x-www-form-urlencoded instead of application/json.
app.use('/webhooks', webhookLimiter,
  express.raw({ type: ['application/json', 'application/x-www-form-urlencoded'] }),
  (req: Request, _res: Response, next: NextFunction) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('application/x-www-form-urlencoded')) {
        req.body = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
      } else {
        try { req.body = JSON.parse(req.body.toString('utf8')); } catch { req.body = {}; }
      }
    }
    next();
  },
  webhooksRouter,
);

app.use(express.json());

// Rate limiting by route group
app.use('/auth', authLimiter);
app.use('/api', apiLimiter);

app.use('/auth', authRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/properties', propertiesRouter);
app.use('/api/cleaners', cleanersRouter);
app.use('/api/account', accountRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/search', searchRouter);
app.use('/api/cleaning-jobs', cleaningJobsRouter);
app.use('/api/work-orders', workOrdersRouter);
app.use('/api/review-drafts', reviewDraftsRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Sentry error handler must come after all routes, before any other error handler
app.use(Sentry.Handlers.errorHandler());

// Generic error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  Sentry.captureException(reason);
});

app.listen(PORT, () => {
  logger.info(`Backend listening on port ${PORT}`);
});

export default app;
