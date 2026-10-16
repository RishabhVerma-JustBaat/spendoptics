import { Prisma, PrismaClient } from '@prisma/client';
import { CalendarDay, InventoryLine } from '../types/planner.types';

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

let cachedCountries: string[] | null = null;

/**
 * The real country/countries the ingested inventory actually covers — read from
 * inventory_mobile_ott.country (the only table with a literal country column; websites' own
 * "geography" column uses "PAN IN" as its equivalent of the same market, not a second one).
 * This is the only real, data-backed source of truth for "do we even have inventory for the
 * market this request is asking about" — never hardcoded, so it tracks whatever the ingested
 * sheets actually cover if that ever changes, instead of silently going stale.
 */
export const getSupportedCountries = async (): Promise<string[]> => {
    if (cachedCountries) return cachedCountries;
    const rows = await prisma.$queryRawUnsafe<{ country: string }[]>(
        `SELECT DISTINCT country FROM inventory_mobile_ott ORDER BY country`
    );
    cachedCountries = rows.map(r => r.country);
    return cachedCountries;
};

/** Every calendar day from `fromDate` (YYYY-MM-DD) on, in date order — not cached, so a newly ingested month shows up without a restart. */
export const getCalendar = async (fromDate: string): Promise<CalendarDay[]> => {
    let rows;
    try {
        rows = await prisma.calendar.findMany({
            where: { date: { gte: new Date(fromDate) } },
            orderBy: { date: 'asc' },
        });
    } catch (err) {
        // P2021 = table doesn't exist: the calendar migration hasn't been applied to this
        // database yet. No calendar data, so best dates fall back to the AI estimate.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2021') return [];
        throw err;
    }
    return rows.map(r => ({
        date: r.date.toISOString().slice(0, 10),
        event: r.event,
        multipliers: { ctv: r.ctvMultiplier, app: r.appMultiplier, web: r.webMultiplier },
    }));
};

export interface InventoryName {
    name: string;
    /** The raw technical id (app URL / package id / inventory URL) — '' for websites, which have none. */
    id: string;
    line: InventoryLine;
}

let cachedNames: InventoryName[] | null = null;

/** Every distinct property across the four inventory tables — what a name in preferredSitesApps / blockedSitesApps is checked against. Cached per process like getIabCategories. */
export const getInventoryNames = async (): Promise<InventoryName[]> => {
    if (cachedNames) return cachedNames;
    cachedNames = await prisma.$queryRawUnsafe<InventoryName[]>(
        `SELECT DISTINCT application_name AS name, app_url AS id,
                CASE WHEN type = 'OEM' THEN 'ctv-fast' ELSE 'ctv-ott' END AS line
           FROM inventory_ctv
         UNION SELECT DISTINCT app_name, package_id, 'mobile-ott' FROM inventory_mobile_ott
         UNION SELECT DISTINCT inventory_name, '', 'websites' FROM inventory_websites
         UNION SELECT DISTINCT app_name, inventory_url, 'in-app' FROM inventory_mobile_inapp`
    );
    return cachedNames;
};

export interface InventoryEmbedding {
    name: string;
    lines: InventoryLine[];
    vector: Float32Array;
}

let cachedEmbeddings: Map<string, InventoryEmbedding> | null = null;

/**
 * inventory_embeddings keyed by lowercased name, loaded once per process (~23k × 256 floats,
 * about 23 MB). Empty — semantic scoring then stays neutral — when the table hasn't been
 * migrated or filled yet.
 */
export const getInventoryEmbeddings = async (): Promise<Map<string, InventoryEmbedding>> => {
    if (cachedEmbeddings) return cachedEmbeddings;
    let rows: { name: string; lines: string[]; vector: Buffer }[];
    try {
        rows = await prisma.inventoryEmbedding.findMany({ select: { name: true, lines: true, vector: true } });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2021') return new Map();
        throw err;
    }
    cachedEmbeddings = new Map(
        rows.map(r => {
            // Copy out of the driver's buffer so the Float32Array is 4-byte aligned.
            const bytes = Uint8Array.from(r.vector);
            return [r.name, { name: r.name, lines: r.lines as InventoryLine[], vector: new Float32Array(bytes.buffer) }];
        })
    );
    return cachedEmbeddings;
};
