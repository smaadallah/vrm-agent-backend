-- Partial unique index: only one primary cleaner allowed per property.
-- Prisma schema syntax cannot express WHERE-clause partial indexes,
-- so this is applied as raw SQL after the cleaners tables migration.
CREATE UNIQUE INDEX property_cleaners_one_primary_per_property
  ON property_cleaners (property_id)
  WHERE is_primary = true;
