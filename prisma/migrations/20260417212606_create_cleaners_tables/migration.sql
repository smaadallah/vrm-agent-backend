-- CreateTable
CREATE TABLE "cleaners" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cleaners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_cleaners" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "cleaner_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_cleaners_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cleaners" ADD CONSTRAINT "cleaners_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_cleaners" ADD CONSTRAINT "property_cleaners_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_cleaners" ADD CONSTRAINT "property_cleaners_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_cleaners" ADD CONSTRAINT "property_cleaners_cleaner_id_fkey" FOREIGN KEY ("cleaner_id") REFERENCES "cleaners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
