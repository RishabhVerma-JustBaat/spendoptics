import { PrismaClient } from '@prisma/client';
import {
    CandidateInventoryItem,
    InventoryLine,
    Platform,
    PlannerInput,
    RateTier,
} from '../types/planner.types';

const prisma = new PrismaClient();

/**
 * One platform can draw from more than one line (a bare "ctv" request wants both FAST and OTT
 * CTV inventory), so this maps to an array, not a single line. "Can keep changing" per product
 * direction, so this is a lookup table, not inlined branching.
 */
export const PLATFORM_LINE_MAP: Record<Platform, InventoryLine[]> = {
    ctv: ['ctv-fast', 'ctv-ott'],
    // The ingested data's "OEM" type is the closest real proxy to "FAST channel" — see
    // planner.types.ts's INVENTORY_LINES comment for why. "ctv-oem" and "ctv-fast" are
    // synonyms (see PLATFORMS's comment); "ctv-ott" is the distinct on-demand pool.
    'ctv-oem': ['ctv-fast'],
    'ctv-fast': ['ctv-fast'],
    'ctv-ott': ['ctv-ott'],
    'mobile-ott': ['mobile-ott'],
    web: ['websites'],
    mweb: ['websites'],
    'in-app': ['in-app'],
    youtube: [], // no real data — always routed to plannedByTeam, never a candidate
};

const caseInsensitiveMatch = (value: string, list: string[]): boolean => {
    const lower = value.toLowerCase();
    return list.some(entry => {
        const e = entry.toLowerCase().trim();
        return e.length > 0 && (lower.includes(e) || e.includes(lower));
    });
};

/**
 * A floor, not a configurable exclusion — applied regardless of what the input specifies.
 * Mainly covers In-App and CTV/Mobile OTT, which have no category data at all to filter on
 * (unlike Websites, which can be excluded by real IAB category instead) — without this, those
 * three lines have literally nothing stopping an obviously mismatched or brand-unsafe app
 * (e.g. a dating app) from scoring well on volume/cost alone and getting recommended.
 */
const DEFAULT_UNSAFE_KEYWORDS = [
    'dating',
    'gay',
    'lesbian',
    'adult',
    'porn',
    'casino',
    'gambling',
    'bet',
    'lottery',
    'escort',
];

const failsBrandSafety = (name: string, input: PlannerInput): boolean =>
    caseInsensitiveMatch(name, DEFAULT_UNSAFE_KEYWORDS) ||
    caseInsensitiveMatch(name, input.inventory.categoriesToAvoid) ||
    caseInsensitiveMatch(name, input.inventory.brandSafetyExclusions);

/**
 * Primarily data-driven (what targeting the inputs actually specify), not an LLM judgment call —
 * keeping this deterministic is what makes the whole plan reproducible for the same input. See
 * allocation.service.ts's top comment for why the plan removes LLM variance from decisions.
 */
export const computeRateTier = (input: PlannerInput): RateTier => {
    const hasAudienceTargeting =
        input.audience.ageGroups.length > 0 ||
        (input.audience.gender !== null && input.audience.gender !== 'all') ||
        input.audience.affluenceSec.length > 0 ||
        input.audience.interests.length > 0 ||
        input.audience.behaviours.length > 0 ||
        input.audience.lifeStage.length > 0;
    const hasContentTargeting =
        input.inventory.iabCategories.length > 0 || input.inventory.contentGenres.length > 0;

    let tier: RateTier = 'open';
    if (hasAudienceTargeting && hasContentTargeting) tier = 'advance';
    else if (hasAudienceTargeting) tier = 'premium';

    // quality_tier is a floor, not an override — it can only push the tier up, never down below
    // what the audience/content targeting itself already earns.
    if (input.inventory.qualityTier === 'premium-only' && tier === 'open') tier = 'premium';

    return tier;
};

const isBlocked = (name: string, input: PlannerInput): boolean =>
    caseInsensitiveMatch(name, input.inventory.blockedSitesApps);
const isMustInclude = (name: string, input: PlannerInput): boolean =>
    caseInsensitiveMatch(name, input.inventory.mustInclude);
const isPreferred = (name: string, input: PlannerInput): boolean =>
    caseInsensitiveMatch(name, input.inventory.preferredSitesApps);

const passesVolumeFilters = (
    avails: number,
    uniqueAudience: number | null,
    input: PlannerInput
): boolean => {
    if (input.inventory.minAvails !== null && avails < input.inventory.minAvails) return false;
    // null means "we have no real figure for this row" — excluding it would be penalizing a data
    // gap, not applying the filter, so it only excludes rows that HAVE a number below the floor.
    if (
        input.inventory.minUniqueAudience !== null &&
        uniqueAudience !== null &&
        uniqueAudience < input.inventory.minUniqueAudience
    ) {
        return false;
    }
    return true;
};

/** Returns both ctv-fast and ctv-ott items in one query — buildCandidateInventory below splits them by their own .line, since whether a given platform request needs one, the other, or both is a many-to-one relationship already resolved by PLATFORM_LINE_MAP. */
const fetchCtvCandidates = async (input: PlannerInput, tier: RateTier): Promise<CandidateInventoryItem[]> => {
    const rows = await prisma.inventoryCtvInventory.findMany();
    const cpmColumn = tier === 'open' ? 'cpmOpen' : tier === 'premium' ? 'cpmPremiumAudience' : 'cpmAdvanced';
    return rows
        .filter(r => !isBlocked(r.applicationName, input) && !isBlocked(r.appUrl, input))
        .filter(r => !failsBrandSafety(r.applicationName, input) && !failsBrandSafety(r.appUrl, input))
        .map(r => ({
            id: r.appUrl,
            name: r.applicationName,
            // OEM = manufacturer-preloaded, ad-supported, channel-style apps (Samsung TV Plus,
            // TCL Channel) — a real proxy for "FAST channel", not an invented split. See
            // planner.types.ts's INVENTORY_LINES comment.
            line: (r.type === 'OEM' ? 'ctv-fast' : 'ctv-ott') as InventoryLine,
            platform: (r.type === 'OEM' ? 'ctv-fast' : 'ctv-ott') as Platform,
            avails: Number(r.totalImpressions),
            uniqueAudience: Number(r.totalUniques),
            cpm: r[cpmColumn],
            vcr: r.vcr,
            isMustInclude: isMustInclude(r.applicationName, input) || isMustInclude(r.appUrl, input),
            isPreferred: isPreferred(r.applicationName, input) || isPreferred(r.appUrl, input),
        }))
        .filter(c => input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(c => input.inventory.minVcrPct === null || (c.vcr ?? 0) * 100 >= input.inventory.minVcrPct)
        .filter(c => passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

const fetchMobileOttCandidates = async (
    input: PlannerInput,
    tier: RateTier
): Promise<CandidateInventoryItem[]> => {
    const rows = await prisma.inventoryMobileOttInventory.findMany();
    const cpmColumn = tier === 'open' ? 'cpmOpen' : tier === 'premium' ? 'cpmPremiumAudience' : 'cpmAdvanced';
    return rows
        .filter(r => !isBlocked(r.appName, input) && !isBlocked(r.packageId, input))
        .filter(r => !failsBrandSafety(r.appName, input) && !failsBrandSafety(r.packageId, input))
        .map(r => ({
            id: r.packageId,
            name: r.appName,
            line: 'mobile-ott' as InventoryLine,
            platform: 'mobile-ott' as Platform,
            avails: Number(r.totalAvails),
            // No separate uniques column in this sheet — left null rather than estimated.
            uniqueAudience: null,
            cpm: r[cpmColumn],
            vcr: r.vcr,
            isMustInclude: isMustInclude(r.appName, input) || isMustInclude(r.packageId, input),
            isPreferred: isPreferred(r.appName, input) || isPreferred(r.packageId, input),
        }))
        .filter(c => input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(c => input.inventory.minVcrPct === null || (c.vcr ?? 0) * 100 >= input.inventory.minVcrPct)
        .filter(c => passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

const fetchWebsiteCandidates = async (input: PlannerInput): Promise<CandidateInventoryItem[]> => {
    const where: Record<string, unknown> = {};
    if (input.inventory.mediaTypes.length > 0) {
        where.adFormat = { in: input.inventory.mediaTypes.map(m => (m === 'display' ? 'Display' : 'Video')) };
    }
    if (input.inventory.iabCategories.length > 0) {
        where.iabCategories = { hasSome: input.inventory.iabCategories };
    }
    const rows = await prisma.inventoryWebsite.findMany({ where });
    return rows
        .filter(r => !isBlocked(r.inventoryName, input))
        .filter(r => !failsBrandSafety(r.inventoryName, input))
        // Real category data exists here (unlike CTV/Mobile OTT/In-App), so exclusion can also
        // match on the row's actual categories, not just its name.
        .filter(
            r =>
                !r.iabCategories.some(
                    cat =>
                        caseInsensitiveMatch(cat, input.inventory.categoriesToAvoid) ||
                        caseInsensitiveMatch(cat, input.inventory.brandSafetyExclusions)
                )
        )
        .map(r => ({
            id: r.inventoryName,
            name: r.inventoryName,
            line: 'websites' as InventoryLine,
            platform: 'web' as Platform,
            avails: Number(r.totalImpressions),
            uniqueAudience: r.totalUniqueAudience === null ? null : Number(r.totalUniqueAudience),
            cpm: r.buyingCpm,
            vcr: null, // not present in this sheet
            isMustInclude: isMustInclude(r.inventoryName, input),
            isPreferred: isPreferred(r.inventoryName, input),
        }))
        .filter(c => input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(c => passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

const fetchInAppCandidates = async (input: PlannerInput): Promise<CandidateInventoryItem[]> => {
    const where: Record<string, unknown> = {};
    if (input.inventory.mediaTypes.length > 0) {
        where.adFormat = { in: input.inventory.mediaTypes.map(m => (m === 'display' ? 'Display' : 'Video')) };
    }
    const rows = await prisma.inventoryMobileInApp.findMany({ where });
    return rows
        // 0 means no real price in this sheet at all, not a free placement. Not filtering any
        // further than that — this assumes the sheet's own pricing is trustworthy once
        // populated; a messier snapshot is a data-ingestion problem to fix at the source
        // (scripts/ingest-inventory.js), not something to compensate for with a guessed floor.
        .filter(r => r.eCpm > 0)
        .filter(r => !isBlocked(r.appName, input) && !isBlocked(r.inventoryUrl, input))
        .filter(r => !failsBrandSafety(r.appName, input) && !failsBrandSafety(r.inventoryUrl, input))
        .map(r => ({
            id: r.inventoryUrl,
            name: r.appName,
            line: 'in-app' as InventoryLine,
            platform: 'in-app' as Platform,
            avails: Number(r.totalRequests),
            uniqueAudience: null, // not present in this sheet
            cpm: r.eCpm,
            vcr: null, // not present in this sheet
            isMustInclude: isMustInclude(r.appName, input) || isMustInclude(r.inventoryUrl, input),
            isPreferred: isPreferred(r.appName, input) || isPreferred(r.inventoryUrl, input),
        }))
        .filter(c => input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(c => passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

export interface CandidateResult {
    byLine: Record<InventoryLine, CandidateInventoryItem[]>;
    /** Requested platforms with zero real data behind them at all (YouTube, or anything the filters left with nothing) — these never reach the LLM, they go straight to plannedByTeam. */
    unplannablePlatforms: Platform[];
}

/** Stage 1 — deterministic, no LLM. Builds the real shortlist the allocation engine and narration call both work from. */
export const buildCandidateInventory = async (input: PlannerInput): Promise<CandidateResult> => {
    const requestedPlatforms = input.inventory.platforms.length > 0 ? input.inventory.platforms : PLATFORMS_ALL;
    const tier = computeRateTier(input);

    const linesNeeded = new Set(requestedPlatforms.flatMap(p => PLATFORM_LINE_MAP[p]));

    const ctvNeeded = linesNeeded.has('ctv-fast') || linesNeeded.has('ctv-ott');
    const allCtv = ctvNeeded ? await fetchCtvCandidates(input, tier) : [];

    const byLine: Record<InventoryLine, CandidateInventoryItem[]> = {
        'ctv-fast': linesNeeded.has('ctv-fast') ? allCtv.filter(c => c.line === 'ctv-fast') : [],
        'ctv-ott': linesNeeded.has('ctv-ott') ? allCtv.filter(c => c.line === 'ctv-ott') : [],
        'mobile-ott': linesNeeded.has('mobile-ott') ? await fetchMobileOttCandidates(input, tier) : [],
        websites: linesNeeded.has('websites') ? await fetchWebsiteCandidates(input) : [],
        'in-app': linesNeeded.has('in-app') ? await fetchInAppCandidates(input) : [],
    };

    // A platform maps to one or more lines (see PLATFORM_LINE_MAP) — it's only truly
    // unplannable if every line it could mean came back with nothing at all.
    const unplannablePlatforms = requestedPlatforms.filter(p => {
        const lines = PLATFORM_LINE_MAP[p];
        return lines.length === 0 || lines.every(line => byLine[line].length === 0);
    });

    return { byLine, unplannablePlatforms };
};

const PLATFORMS_ALL: Platform[] = [
    'ctv',
    'ctv-oem',
    'ctv-fast',
    'ctv-ott',
    'mobile-ott',
    'web',
    'mweb',
    'in-app',
    'youtube',
];
