-- CreateTable
CREATE TABLE "turnover_checklists" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "checklist_body" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turnover_checklists_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "turnover_checklists" ADD CONSTRAINT "turnover_checklists_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turnover_checklists" ADD CONSTRAINT "turnover_checklists_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
