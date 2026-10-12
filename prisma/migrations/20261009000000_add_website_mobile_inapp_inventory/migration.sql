-- CreateTable
CREATE TABLE "inventory_websites" (
    "id" SERIAL NOT NULL,
    "inventory_name" TEXT NOT NULL,
    "ad_format" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "supported_ad_type" TEXT NOT NULL,
    "iab_categories" TEXT[],
    "geography" TEXT NOT NULL,
    "total_impressions" BIGINT NOT NULL,
    "total_unique_audience" BIGINT,
    "e_cpm" DOUBLE PRECISION NOT NULL,
    "buying_cpm" DOUBLE PRECISION NOT NULL,
    "floor_cpm" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "inventory_websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_mobile_inapp" (
    "id" SERIAL NOT NULL,
    "inventory_url" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "ad_format" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "total_requests" BIGINT NOT NULL,
    "e_cpm" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "inventory_mobile_inapp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_websites_iab_categories_idx" ON "inventory_websites" USING GIN ("iab_categories");
