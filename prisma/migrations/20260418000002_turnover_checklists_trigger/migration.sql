-- Shared trigger function reused by cleaning_jobs, work_orders, review_drafts (T-009–T-011).
-- Created here (T-008) as the first table to need updated_at maintenance.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for turnover_checklists
CREATE TRIGGER turnover_checklists_updated_at
  BEFORE UPDATE ON turnover_checklists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
