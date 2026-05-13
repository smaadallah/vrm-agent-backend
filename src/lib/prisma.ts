// require() is intentionally used here instead of import so it runs inline,
// before any hoisted import statements execute. This guarantees DATABASE_URL
// is loaded from .env before new PrismaClient() reads it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config();

import { PrismaClient } from '@prisma/client';
import { prismaEncryptionMiddleware } from './prismaEncryptionMiddleware';

// Prevent multiple PrismaClient instances in development due to hot-reload.
// In production the module cache guarantees a single instance per process.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient();

// Register AES-256-GCM encryption middleware for sensitive columns on
// accounts and properties models.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$use(prismaEncryptionMiddleware);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
