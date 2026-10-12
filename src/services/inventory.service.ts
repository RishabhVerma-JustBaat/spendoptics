import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

let cachedCategories: string[] | null = null;

/**
 * The real IAB categories present in the ingested rate-card data (inventory_web_display /
 * inventory_web_video) — the only valid targets for campaign.category / targeting
 * .matchedIabCategory, so the model maps free text to one of these rather than inventing a
 * category that has no inventory behind it. Cached per process — this is read-only reference
 * data, refreshed only by re-running scripts/ingest-inventory.js (which requires a restart
 * anyway), not something that changes mid-process.
 */
export const getIabCategories = async (): Promise<string[]> => {
    if (cachedCategories) return cachedCategories;
    // inventory_websites.iab_categories is a Postgres array (a row often carries several
    // categories at once) — unnest it to get the distinct set. inventory_web_display/
    // inventory_web_video (the tables this used to query) are the deprecated Oct-5 sheets,
    // no longer re-ingested — querying them here would silently serve a stale category list.
    const rows = await prisma.$queryRawUnsafe<{ category: string }[]>(
        `SELECT DISTINCT unnest(iab_categories) AS category FROM inventory_websites ORDER BY category`
    );
    cachedCategories = rows.map(r => r.category);
    return cachedCategories;
};

export interface RealInventorySite {
    identifier: string;
    name: string;
    platform: string;
    impressions: number;
    uniques: number;
    audioImpressions: number;
    displayImpressions: number;
    videoImpressions: number;
}

export interface RealChannelMatch {
    cpm: number;
    availableImpressions: number;
    availableUniques: number;
    sites: RealInventorySite[];
}

/** Has the brief said anything at all about who to target, beyond just where? Decides which CPM tier (open vs. audience-targeted) applies — these sheets only price two tiers, not a sliding scale. */
const hasAudienceSignal = (audience: {
    ageRange: number[] | null;
    genderSkew: string | null;
    affinitySegments: string[];
    audienceSegments: string[];
}): boolean =>
    audience.ageRange !== null ||
    audience.genderSkew !== null ||
    audience.affinitySegments.length > 0 ||
    audience.audienceSegments.length > 0;

export const matchCtvInventory = async (targeted: boolean): Promise<RealChannelMatch | null> => {
    const rows = await prisma.inventoryCtvInventory.findMany();
    if (rows.length === 0) return null;

    const availableImpressions = rows.reduce((sum, r) => sum + Number(r.totalImpressions), 0);
    const availableUniques = rows.reduce((sum, r) => sum + Number(r.totalUniques), 0);
    const cpmSum = rows.reduce(
        (sum, r) => sum + (targeted ? r.cpmPremiumAudience : r.cpmOpen),
        0
    );
    const cpm = Math.round(cpmSum / rows.length);

    const top = [...rows]
        .sort((a, b) => Number(b.totalImpressions) - Number(a.totalImpressions))
        .slice(0, 8);
    const sites: RealInventorySite[] = top.map(r => ({
        identifier: r.appUrl,
        name: r.applicationName,
        platform: 'ctv',
        impressions: Number(r.totalImpressions),
        uniques: Number(r.totalUniques),
        audioImpressions: 0,
        displayImpressions: 0,
        videoImpressions: Number(r.totalImpressions),
    }));

    return { cpm, availableImpressions, availableUniques, sites };
};

export const matchMobileOttInventory = async (targeted: boolean): Promise<RealChannelMatch | null> => {
    const rows = await prisma.inventoryMobileOttInventory.findMany();
    if (rows.length === 0) return null;

    const availableImpressions = rows.reduce((sum, r) => sum + Number(r.totalAvails), 0);
    const cpmSum = rows.reduce(
        (sum, r) => sum + (targeted ? r.cpmPremiumAudience : r.cpmOpen),
        0
    );
    const cpm = Math.round(cpmSum / rows.length);

    const top = [...rows]
        .sort((a, b) => Number(b.totalAvails) - Number(a.totalAvails))
        .slice(0, 8);
    const sites: RealInventorySite[] = top.map(r => ({
        identifier: r.packageId,
        name: r.appName,
        platform: 'mobile-ott',
        impressions: Number(r.totalAvails),
        // No separate uniques column for this sheet — avails is the only volume figure it gives.
        uniques: Math.round(Number(r.totalAvails) / 4),
        audioImpressions: 0,
        displayImpressions: 0,
        videoImpressions: Number(r.totalAvails),
    }));

    return {
        cpm,
        availableImpressions,
        availableUniques: Math.round(availableImpressions / 4),
        sites,
    };
};

/** Web Display + Web Video combined (see plan-prompts.ts) — both roll up into the single "web-display" channel. */
export const matchWebInventory = async (category: string | null): Promise<RealChannelMatch | null> => {
    if (!category) return null;

    const [displayRows, videoRows] = await Promise.all([
        prisma.inventoryWebDisplayInventory.findMany({ where: { iabCategory: category } }),
        prisma.inventoryWebVideoInventory.findMany({ where: { iabCategory: category } }),
    ]);
    if (displayRows.length === 0 && videoRows.length === 0) return null;

    const allRows = [
        ...displayRows.map(r => ({ ...r, kind: 'display' as const })),
        ...videoRows.map(r => ({ ...r, kind: 'video' as const })),
    ];
    const availableImpressions = allRows.reduce((sum, r) => sum + Number(r.totalRequests), 0);
    const weightedCpmSum = allRows.reduce((sum, r) => sum + r.cpm * Number(r.totalRequests), 0);
    const cpm = availableImpressions > 0 ? Math.round(weightedCpmSum / availableImpressions) : 0;

    // The same domain usually has separate Display and Video rows (and sometimes several IAB
    // sub-categories) — group by pageUrl first so "sites" shows each property once, not the
    // same name twice with half the volume each.
    const byPageUrl = new Map<
        string,
        { displayImpressions: number; videoImpressions: number }
    >();
    for (const row of allRows) {
        const entry = byPageUrl.get(row.pageUrl) ?? { displayImpressions: 0, videoImpressions: 0 };
        if (row.kind === 'display') entry.displayImpressions += Number(row.totalRequests);
        else entry.videoImpressions += Number(row.totalRequests);
        byPageUrl.set(row.pageUrl, entry);
    }

    const top = [...byPageUrl.entries()]
        .sort(([, a], [, b]) => b.displayImpressions + b.videoImpressions - (a.displayImpressions + a.videoImpressions))
        .slice(0, 8);
    const sites: RealInventorySite[] = top.map(([pageUrl, { displayImpressions, videoImpressions }]) => {
        const impressions = displayImpressions + videoImpressions;
        return {
            identifier: pageUrl,
            name: pageUrl,
            platform: 'web-display',
            impressions,
            uniques: Math.round(impressions / 4),
            audioImpressions: 0,
            displayImpressions,
            videoImpressions,
        };
    });

    return {
        cpm,
        availableImpressions,
        availableUniques: Math.round(availableImpressions / 4),
        sites,
    };
};

export interface MatchedPackage {
    packageName: string;
    details: string | null;
    floorCpm: number;
    geo: string;
    device: string;
    publishers: string[];
}

/** The 6 curated PMP packages — simple geo/device filter, surfaced as a bonus (not per-channel grounding, these are pre-bundled deals a planner can just buy outright). */
export const matchPackages = async (geo: string, devices: string[]): Promise<MatchedPackage[]> => {
    const rows = await prisma.inventoryPackage.findMany({
        where: {
            geo: { equals: geo, mode: 'insensitive' },
            device: devices.length > 0 ? { in: devices, mode: 'insensitive' } : undefined,
        },
    });
    return rows.map(r => ({
        packageName: r.packageName,
        details: r.details,
        floorCpm: r.floorCpm,
        geo: r.geo,
        device: r.device,
        publishers: r.publishers.split('/').map(p => p.trim()).filter(Boolean),
    }));
};

export { hasAudienceSignal };
