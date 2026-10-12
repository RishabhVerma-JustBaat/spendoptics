-- CreateTable
CREATE TABLE "inventory_packages" (
    "id" SERIAL NOT NULL,
    "package_name" TEXT NOT NULL,
    "details" TEXT,
    "floor_cpm" INTEGER NOT NULL,
    "geo" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "inventory_type" TEXT NOT NULL,
    "publishers" TEXT NOT NULL,
    "deal_type" TEXT NOT NULL,
    "remarks" TEXT,

    CONSTRAINT "inventory_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_ctv" (
    "id" SERIAL NOT NULL,
    "app_url" TEXT NOT NULL,
    "application_name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "total_impressions" BIGINT NOT NULL,
    "total_uniques" BIGINT NOT NULL,
    "creative_duration" TEXT NOT NULL,
    "cpm_open" INTEGER NOT NULL,
    "cpm_premium_audience" INTEGER NOT NULL,
    "cpm_advanced" INTEGER NOT NULL,
    "vcr" DOUBLE PRECISION NOT NULL,
    "avg_market_cpm" INTEGER NOT NULL,
    "audience_cohorts" TEXT,
    "audience_cohort_detail" TEXT,

    CONSTRAINT "inventory_ctv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_mobile_ott" (
    "id" SERIAL NOT NULL,
    "package_id" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "total_avails" BIGINT NOT NULL,
    "creative_duration" TEXT NOT NULL,
    "cpm_open" INTEGER NOT NULL,
    "cpm_premium_audience" INTEGER NOT NULL,
    "cpm_advanced" INTEGER NOT NULL,
    "vcr" DOUBLE PRECISION NOT NULL,
    "avg_market_cpm" INTEGER NOT NULL,
    "audience_cohorts" TEXT,
    "audience_cohort_detail" TEXT,

    CONSTRAINT "inventory_mobile_ott_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_web_display" (
    "id" SERIAL NOT NULL,
    "page_url" TEXT NOT NULL,
    "ad_format" TEXT NOT NULL,
    "iab_category" TEXT NOT NULL,
    "total_requests" BIGINT NOT NULL,
    "cpm" INTEGER NOT NULL,
    "avg_market_cpm" INTEGER NOT NULL,

    CONSTRAINT "inventory_web_display_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_web_video" (
    "id" SERIAL NOT NULL,
    "page_url" TEXT NOT NULL,
    "ad_format" TEXT NOT NULL,
    "iab_category" TEXT NOT NULL,
    "total_requests" BIGINT NOT NULL,
    "vcr" DOUBLE PRECISION NOT NULL,
    "ad_duration" TEXT NOT NULL,
    "cpm" INTEGER NOT NULL,
    "avg_market_cpm" INTEGER NOT NULL,

    CONSTRAINT "inventory_web_video_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_web_display_iab_category_idx" ON "inventory_web_display"("iab_category");

-- CreateIndex
CREATE INDEX "inventory_web_video_iab_category_idx" ON "inventory_web_video"("iab_category");
