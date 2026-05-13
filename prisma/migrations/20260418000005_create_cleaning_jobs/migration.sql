-- CreateEnum
CREATE TYPE "CleaningJobStatus" AS ENUM ('scheduled', 'confirmed', 'completed', 'no_response', 'failed');

-- CreateEnum
CREATE TYPE "ClosedBy" AS ENUM ('cleaner_sms', 'manager_manual');

-- CreateTable
CREATE TABLE "cleaning_jobs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "next_booking_id" TEXT,
    "cleaner_id" TEXT NOT NULL,
    "status" "CleaningJobStatus" NOT NULL,
    "scheduled_start" TIMESTAMP(3) NOT NULL,
    "deadline" TIMESTAMP(3),
    "job_notification_sent" BOOLEAN NOT NULL DEFAULT false,
    "job_notification_sent_at" TIMESTAMP(3),
    "cleaner_confirmed_at" TIMESTAMP(3),
    "checklist_sent" BOOLEAN NOT NULL DEFAULT false,
    "checklist_sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "closed_by" "ClosedBy",
    "completion_sms_raw" TEXT,
    "supply_flags" TEXT[],
    "supply_alert_sent" BOOLEAN NOT NULL DEFAULT false,
    "supply_alert_sent_at" TIMESTAMP(3),
    "supply_alert_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "supply_alert_permanently_failed" BOOLEAN NOT NULL DEFAULT false,
    "no_response_alert_sent" BOOLEAN NOT NULL DEFAULT false,
    "pre_checkin_alert_sent" BOOLEAN NOT NULL DEFAULT false,
    "damage_fyi_sent" BOOLEAN NOT NULL DEFAULT false,
    "damage_report_dismissed" BOOLEAN NOT NULL DEFAULT false,
    "inbound_sms_sids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cleaning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cleaning_jobs_booking_id_key" ON "cleaning_jobs"("booking_id");

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_next_booking_id_fkey" FOREIGN KEY ("next_booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_cleaner_id_fkey" FOREIGN KEY ("cleaner_id") REFERENCES "cleaners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Trigger: reuse shared set_updated_at() function created in T-008
CREATE TRIGGER cleaning_jobs_updated_at
  BEFORE UPDATE ON cleaning_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
