import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let cachedCategories: string[] | null = null;

/**
 * The real IAB categories present in the ingested rate-card data (inventory_websites) — the
 * only valid targets for inventory.iabCategories in the ai-planner flow, so suggestions/filters
 * map to a category that actually has inventory behind it, never an invented one. Cached per
 * process — this is read-only reference data, refreshed only by re-running
 * scripts/ingest-inventory.js (which requires a restart anyway), not something that changes
 * mid-process.
 */
export const getIabCategories = async (): Promise<string[]> => {
    if (cachedCategories) return cachedCategories;
    // iab_categories is a Postgres array (a row often carries several categories at once) —
    // unnest it to get the distinct set.
    const rows = await prisma.$queryRawUnsafe<{ category: string }[]>(
        `SELECT DISTINCT unnest(iab_categories) AS category FROM inventory_websites ORDER BY category`
    );
    cachedCategories = rows.map(r => r.category);
    return cachedCategories;
};
