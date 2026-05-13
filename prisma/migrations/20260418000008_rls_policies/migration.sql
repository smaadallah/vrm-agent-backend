-- T-012: Row Level Security policies for all 10 tables.
-- Every table is locked so that only rows whose account_id (or id for accounts)
-- matches the Supabase JWT subject are visible/writable.
-- This is the second line of defense: even a bug that omits the account_id
-- filter in application code cannot leak cross-account data.
--
-- Note: id/account_id columns are TEXT (Prisma default for String @id).
-- auth.uid() returns uuid, so we cast to text for comparison.

-- ── accounts ─────────────────────────────────────────────────────────────────
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_isolation ON accounts
  FOR ALL USING (id = auth.uid()::text);

-- ── properties ───────────────────────────────────────────────────────────────
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY properties_account_isolation ON properties
  FOR ALL USING (account_id = auth.uid()::text);

-- ── bookings ─────────────────────────────────────────────────────────────────
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY bookings_account_isolation ON bookings
  FOR ALL USING (account_id = auth.uid()::text);

-- ── messages ─────────────────────────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_account_isolation ON messages
  FOR ALL USING (account_id = auth.uid()::text);

-- ── cleaners ─────────────────────────────────────────────────────────────────
ALTER TABLE cleaners ENABLE ROW LEVEL SECURITY;
CREATE POLICY cleaners_account_isolation ON cleaners
  FOR ALL USING (account_id = auth.uid()::text);

-- ── property_cleaners ────────────────────────────────────────────────────────
ALTER TABLE property_cleaners ENABLE ROW LEVEL SECURITY;
CREATE POLICY property_cleaners_account_isolation ON property_cleaners
  FOR ALL USING (account_id = auth.uid()::text);

-- ── turnover_checklists ──────────────────────────────────────────────────────
ALTER TABLE turnover_checklists ENABLE ROW LEVEL SECURITY;
CREATE POLICY turnover_checklists_account_isolation ON turnover_checklists
  FOR ALL USING (account_id = auth.uid()::text);

-- ── cleaning_jobs ────────────────────────────────────────────────────────────
ALTER TABLE cleaning_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cleaning_jobs_account_isolation ON cleaning_jobs
  FOR ALL USING (account_id = auth.uid()::text);

-- ── work_orders ──────────────────────────────────────────────────────────────
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_orders_account_isolation ON work_orders
  FOR ALL USING (account_id = auth.uid()::text);

-- ── review_drafts ────────────────────────────────────────────────────────────
ALTER TABLE review_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_drafts_account_isolation ON review_drafts
  FOR ALL USING (account_id = auth.uid()::text);
