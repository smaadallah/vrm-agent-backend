-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('airbnb', 'vrbo', 'sms');

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('guest', 'agent', 'manager');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('auto_handled', 'escalated', 'failed', 'no_response_needed', 'processing', 'manager_handled');

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "platform_message_id" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "sender" "MessageSender" NOT NULL,
    "content" TEXT NOT NULL,
    "intent_classification" TEXT,
    "status" "MessageStatus" NOT NULL,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "escalation_reason" TEXT,
    "maintenance_triggered" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_platform_message_id_key" ON "messages"("platform_message_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
