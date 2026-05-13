import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();
  try {
    // Keep only the latest record for this migration name
    const rows = await (prisma as any).$queryRaw`
      SELECT id FROM "_prisma_migrations"
      WHERE migration_name = '20260418000004_create_messages_table'
      ORDER BY started_at DESC
    `;
    const ids = (rows as any[]).map((r: any) => r.id);
    console.log(`Found ${ids.length} record(s).`);
    // Delete all but the most recent
    for (const id of ids.slice(1)) {
      await (prisma as any).$executeRawUnsafe(
        `DELETE FROM "_prisma_migrations" WHERE id = '${id}'`
      );
      console.log(`Deleted duplicate record ${id}`);
    }
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
})();
