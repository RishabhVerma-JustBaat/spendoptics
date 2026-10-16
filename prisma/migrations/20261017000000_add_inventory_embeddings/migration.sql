-- CreateTable
CREATE TABLE "inventory_embeddings" (
    "name" TEXT NOT NULL,
    "lines" TEXT[],
    "text" TEXT NOT NULL,
    "vector" BYTEA NOT NULL,

    CONSTRAINT "inventory_embeddings_pkey" PRIMARY KEY ("name")
);
