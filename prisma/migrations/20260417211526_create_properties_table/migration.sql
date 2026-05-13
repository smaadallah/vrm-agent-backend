-- CreateEnum
CREATE TYPE "PropertyStatus" AS ENUM ('unknown', 'guest_ready', 'occupied', 'needs_cleaning');

-- CreateTable
CREATE TABLE "properties" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "checkin_time" TEXT NOT NULL,
    "checkout_time" TEXT NOT NULL,
    "door_access_instructions" TEXT,
    "parking_instructions" TEXT,
    "wifi_name" TEXT,
    "wifi_password" TEXT,
    "house_rules" TEXT,
    "amenities" TEXT,
    "local_recommendations" TEXT,
    "special_instructions" TEXT,
    "checkout_steps" TEXT,
    "checkin_message_template" TEXT,
    "checkout_reminder_template" TEXT,
    "review_request_template" TEXT,
    "checkin_message_enabled" BOOLEAN NOT NULL DEFAULT true,
    "checkout_reminder_enabled" BOOLEAN NOT NULL DEFAULT true,
    "review_request_enabled" BOOLEAN NOT NULL DEFAULT true,
    "checkin_message_hours_before" INTEGER NOT NULL DEFAULT 24,
    "checkout_reminder_send_time" TEXT NOT NULL DEFAULT '20:00',
    "review_request_hours_after" INTEGER NOT NULL DEFAULT 2,
    "airbnb_listing_id" TEXT,
    "vrbo_listing_id" TEXT,
    "property_status" "PropertyStatus" NOT NULL DEFAULT 'unknown',
    "auto_schedule_cleaner_enabled" BOOLEAN NOT NULL DEFAULT true,
    "cleaner_confirmation_window_minutes" INTEGER NOT NULL DEFAULT 60,
    "pre_checkin_alert_minutes" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
