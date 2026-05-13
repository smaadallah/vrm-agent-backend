-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('airbnb', 'vrbo');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('upcoming', 'active', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platform_booking_id" TEXT NOT NULL,
    "guest_first_name" TEXT NOT NULL,
    "guest_last_name" TEXT NOT NULL,
    "guest_platform_id" TEXT NOT NULL,
    "checkin_datetime" TIMESTAMP(3) NOT NULL,
    "checkout_datetime" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "checkin_message_sent" BOOLEAN NOT NULL DEFAULT false,
    "checkin_message_sent_at" TIMESTAMP(3),
    "checkout_reminder_sent" BOOLEAN NOT NULL DEFAULT false,
    "checkout_reminder_sent_at" TIMESTAMP(3),
    "review_request_sent" BOOLEAN NOT NULL DEFAULT false,
    "review_request_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_account_id_platform_platform_booking_id_key" ON "bookings"("account_id", "platform", "platform_booking_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
