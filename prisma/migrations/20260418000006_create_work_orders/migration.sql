-- CreateEnum
CREATE TYPE "ReportedBy" AS ENUM ('guest', 'cleaner', 'manager');

-- CreateEnum
CREATE TYPE "WorkOrderPriority" AS ENUM ('urgent', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('open', 'in_progress', 'resolved');

-- CreateEnum
CREATE TYPE "ResolvedBy" AS ENUM ('manager');

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "reported_by" "ReportedBy" NOT NULL,
    "description" TEXT NOT NULL,
    "ai_summary" TEXT,
    "priority" "WorkOrderPriority" NOT NULL,
    "status" "WorkOrderStatus" NOT NULL,
    "source_message_id" TEXT,
    "source_cleaning_job_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" "ResolvedBy",
    "manager_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_source_cleaning_job_id_fkey" FOREIGN KEY ("source_cleaning_job_id") REFERENCES "cleaning_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Trigger: reuse shared set_updated_at() function created in T-008
CREATE TRIGGER work_orders_updated_at
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Partial unique index: prevents duplicate work orders from the same source message.
-- Only enforced when source_message_id IS NOT NULL.
CREATE UNIQUE INDEX work_orders_source_message_id_unique
  ON work_orders (source_message_id)
  WHERE source_message_id IS NOT NULL;
