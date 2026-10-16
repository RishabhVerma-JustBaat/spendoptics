-- CreateTable
CREATE TABLE "calendar" (
    "date" DATE NOT NULL,
    "event" TEXT,
    "ctv_multiplier" DOUBLE PRECISION NOT NULL,
    "app_multiplier" DOUBLE PRECISION NOT NULL,
    "web_multiplier" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "calendar_pkey" PRIMARY KEY ("date")
);
