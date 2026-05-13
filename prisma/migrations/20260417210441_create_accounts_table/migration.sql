-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('sms', 'email', 'both');

-- CreateEnum
CREATE TYPE "CommunicationTone" AS ENUM ('casual', 'professional', 'luxury');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "manager_phone" TEXT NOT NULL,
    "manager_email" TEXT NOT NULL,
    "alert_channel" "AlertChannel" NOT NULL,
    "communication_tone" "CommunicationTone" NOT NULL,
    "twilio_phone_number" TEXT,
    "airbnb_access_token" TEXT,
    "airbnb_refresh_token" TEXT,
    "vrbo_access_token" TEXT,
    "vrbo_refresh_token" TEXT,
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "daily_ai_token_usage" INTEGER NOT NULL DEFAULT 0,
    "ai_token_daily_cap" INTEGER NOT NULL DEFAULT 500000,
    "ai_token_cap_reset_at" TIMESTAMP(3),
    "data_region" TEXT NOT NULL DEFAULT 'us',
    "password_hash" TEXT NOT NULL,
    "password_reset_token" TEXT,
    "password_reset_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
