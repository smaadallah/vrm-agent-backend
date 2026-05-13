-- CreateEnum
CREATE TYPE "ReviewDraftStatus" AS ENUM ('pending', 'copied', 'dismissed');

-- CreateTable
CREATE TABLE "review_drafts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "platform" "Platform" NOT NULL,
    "platform_review_id" TEXT NOT NULL,
    "reviewer_name" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "review_text" TEXT,
    "draft_response" TEXT,
    "status" "ReviewDraftStatus" NOT NULL,
    "no_review_text" BOOLEAN NOT NULL DEFAULT false,
    "ai_failed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_drafts_platform_review_id_key" ON "review_drafts"("platform_review_id");

-- AddForeignKey
ALTER TABLE "review_drafts" ADD CONSTRAINT "review_drafts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_drafts" ADD CONSTRAINT "review_drafts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_drafts" ADD CONSTRAINT "review_drafts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Trigger: reuse shared set_updated_at() function created in T-008
CREATE TRIGGER review_drafts_updated_at
  BEFORE UPDATE ON review_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
