-- CreateTable
CREATE TABLE "media_plans" (
    "plan_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "source" JSONB NOT NULL,
    "brief" JSONB NOT NULL,
    "campaign" JSONB NOT NULL,
    "market" JSONB NOT NULL,
    "audience" JSONB NOT NULL,
    "inventory" JSONB NOT NULL,
    "forecast" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "saved_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_plans_pkey" PRIMARY KEY ("plan_id")
);
