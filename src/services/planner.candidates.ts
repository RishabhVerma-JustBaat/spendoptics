import { PrismaClient } from '@prisma/client';
import {
    AGE_GROUPS,
    AgeGroup,
    CandidateInventoryItem,
    INCOME_GROUPS,
    IncomeGroup,
    InputWarning,
    InventoryLine,
    Platform,
    PlannerInput,
    PriceUplift,
    RateTier,
} from '../types/planner.types';
import { config } from '../config/environment';
import { cosine, embedText } from './bedrock.service';
import { getInventoryEmbeddings, getInventoryNames, InventoryName } from './inventory.service';

const prisma = new PrismaClient();

/** The client-facing CPM: the sheet's cost CPM plus our flat margin (config.plannerMarginPercent) — the base price — then the targeting uplift (computePriceUplift) on top of that base. Applied here, at load time, so every filter (maxCpm), score, split, curve and cpmFit check downstream works in the price the client actually pays. */
export const clientCpm = (costCpm: number, upliftPercent: number): number =>
    Math.round(costCpm * (1 + config.plannerMarginPercent / 100) * (1 + upliftPercent / 100) * 100) / 100;

/** Picking every band is the same as not targeting by that dimension at all. */
const narrows = (selected: readonly string[], all: readonly string[]): boolean =>
    selected.length > 0 && all.some(v => !selected.includes(v));

const hasAudienceTargeting = (input: PlannerInput): boolean =>
    narrows(input.audience.ageGroups, AGE_GROUPS) ||
    narrows(input.audience.incomeGroups, INCOME_GROUPS) ||
    (input.audience.gender !== null && input.audience.gender !== 'all');

/** IAB categories are the form's interest targeting. */
const hasInterestTargeting = (input: PlannerInput): boolean => input.inventory.iabCategories.length > 0;

/** The sheet's own age bands — it stops at one combined "55+", so 55-64 and 65+ both read it. */
type ShareAgeBand = '18-24' | '25-34' | '35-44' | '45-54' | '55+';
const SHARE_BAND_FOR_AGE: Record<AgeGroup, ShareAgeBand> = {
    '18-24': '18-24',
    '25-34': '25-34',
    '35-44': '35-44',
    '45-54': '45-54',
    '55-64': '55+',
    '65+': '55+',
};

/** Share (0-1) of an item's audience in each band, per dimension; null where unknown. */
export interface DemographicShares {
    gender: Record<'male' | 'female', number> | null;
    age: Record<ShareAgeBand, number> | null;
    income: Record<IncomeGroup, number> | null;
}

/**
 * Shares for lines whose sheets have no demographic columns (and for website rows whose
 * Demographics/Wallet text didn't parse). null = not known yet, so that line isn't shrunk by
 * targeting at all — fill these in once the figures are agreed.
 */
export const DEFAULT_LINE_SHARES: Record<InventoryLine, DemographicShares | null> = {
    'ctv-fast': null,
    'ctv-ott': null,
    'mobile-ott': null,
    websites: null,
    'in-app': null,
};

/** Powers for the selected filters' shares, largest share first: it counts fully, each further one counts less, so overlapping filters don't shrink R as if they were independent. */
const TARGETING_EXPONENTS = [1, 0.5, 0.25];

/**
 * R / N in R = N × p₁ × p₂^0.5 × p₃^0.25, where each p is the share of the item's audience in
 * the selected bands of one targeted dimension (age, gender, income), sorted largest first.
 * Dimensions not narrowed (nothing or every band picked, gender "all") or with unknown shares
 * are left out.
 */
export const targetingFactor = (input: PlannerInput, shares: DemographicShares | null): number => {
    if (!shares) return 1;
    const { gender, ageGroups, incomeGroups } = input.audience;
    const ps: number[] = [];
    if (shares.gender && (gender === 'male' || gender === 'female')) ps.push(shares.gender[gender]);
    if (shares.age && narrows(ageGroups, AGE_GROUPS)) {
        const bands = new Set(ageGroups.map(a => SHARE_BAND_FOR_AGE[a]));
        ps.push([...bands].reduce((sum, b) => sum + shares.age![b], 0));
    }
    if (shares.income && narrows(incomeGroups, INCOME_GROUPS)) {
        ps.push(incomeGroups.reduce((sum, g) => sum + shares.income![g], 0));
    }
    return ps
        .map(p => Math.min(1, Math.max(0, p)))
        .sort((a, b) => b - a)
        .reduce((factor, p, i) => factor * p ** TARGETING_EXPONENTS[i], 1);
};

const pctShare = (pct: number | null): number | null => (pct === null ? null : pct / 100);

/** A website row's own shares from its parsed Demographics / Wallet size columns; a dimension with any band missing falls back to DEFAULT_LINE_SHARES.websites. */
const websiteShares = (r: {
    genderMalePct: number | null;
    genderFemalePct: number | null;
    age1824Pct: number | null;
    age2534Pct: number | null;
    age3544Pct: number | null;
    age4554Pct: number | null;
    age55PlusPct: number | null;
    walletT1Pct: number | null;
    walletT2Pct: number | null;
    walletT3Pct: number | null;
    walletT4Pct: number | null;
    walletT5Pct: number | null;
}): DemographicShares => {
    const fallback = DEFAULT_LINE_SHARES.websites;
    const all = <T extends Record<string, number | null>>(o: T) =>
        Object.values(o).every(v => v !== null) ? (o as { [K in keyof T]: number }) : null;
    return {
        gender: all({ male: pctShare(r.genderMalePct), female: pctShare(r.genderFemalePct) }) ?? fallback?.gender ?? null,
        age:
            all({
                '18-24': pctShare(r.age1824Pct),
                '25-34': pctShare(r.age2534Pct),
                '35-44': pctShare(r.age3544Pct),
                '45-54': pctShare(r.age4554Pct),
                '55+': pctShare(r.age55PlusPct),
            }) ?? fallback?.age ?? null,
        income:
            all({
                premium: pctShare(r.walletT1Pct),
                'upper-middle': pctShare(r.walletT2Pct),
                middle: pctShare(r.walletT3Pct),
                'lower-middle': pctShare(r.walletT4Pct),
                value: pctShare(r.walletT5Pct),
            }) ?? fallback?.income ?? null,
    };
};

/** Turns a row's raw avails/uniques into the targetable R. Applied before every volume/CPM filter, so minAvails, the fill caps, impressions, reach and curves all work in targetable avails. */
const scaleByTargeting = (
    c: Omit<CandidateInventoryItem, 'targetingFactor' | 'matchScore' | 'targetFill'>,
    factor: number
): CandidateInventoryItem => ({
    ...c,
    avails: Math.round(c.avails * factor),
    uniqueAudience: c.uniqueAudience === null ? null : Math.round(c.uniqueAudience * factor),
    targetingFactor: Math.round(factor * 10000) / 10000,
    // Neutral until scoreMatches runs over the whole shortlist.
    matchScore: NEUTRAL_MATCH,
    targetFill: targetFillFor(0.5),
});

const NEUTRAL_MATCH = 0.5;

/**
 * Target buy % for an item at match percentile `p` (0-1) within its line: the weakest 10% of
 * matches 1-3%, the strongest 10% 12-25%, everyone between 3-12% — on a square-root curve, so
 * the middle of the pack lands near 10% (p = 0.5 -> ~9.4%) rather than spread evenly.
 */
const targetFillFor = (p: number): number => {
    if (p < 0.1) return 0.01 + 0.02 * (p / 0.1);
    if (p > 0.9) return 0.12 + 0.13 * ((p - 0.9) / 0.1);
    return 0.03 + 0.09 * Math.sqrt((p - 0.1) / 0.8);
};

/** The key inventory_embeddings rows are stored under — scripts/ingest-inventory.js --embeddings uses the same. */
export const embeddingKey = (name: string): string => name.trim().toLowerCase();

const describeAudience = (input: PlannerInput): string => {
    const { gender, ageGroups, incomeGroups } = input.audience;
    return [
        gender === 'male' ? 'men' : gender === 'female' ? 'women' : '',
        narrows(ageGroups, AGE_GROUPS) ? `aged ${ageGroups.join(', ')}` : '',
        narrows(incomeGroups, INCOME_GROUPS) ? `${incomeGroups.join(', ')} income households` : '',
    ]
        .filter(Boolean)
        .join(', ');
};

/**
 * Sets every candidate's matchScore and targetFill. matchScore blends semantic closeness (item
 * name/categories vs inventory.keywords — or the brief without them — and vs the selected
 * interests + audience, averaged) with the
 * IAB-category match, 70/30 when both exist; a preferredSitesApps match is always 1. The
 * semantic part is min-max normalized across the whole shortlist, so it ranks items against each
 * other rather than reading raw cosines (which cluster tightly). Without embeddings (table not
 * filled, or no Bedrock key) it falls back to the IAB match alone, then to neutral.
 */
const scoreMatches = async (input: PlannerInput, byLine: Record<InventoryLine, CandidateInventoryItem[]>) => {
    const all = Object.values(byLine).flat();
    if (all.length === 0) return;

    const embeddings = await getInventoryEmbeddings();
    let semantic = new Map<CandidateInventoryItem, number>();
    if (embeddings.size > 0) {
        // Short keywords embed far closer to inventory names than a whole brief does (tested:
        // beauty sites ~0.65 against keywords vs ~0.40 against the brief), so they lead; the
        // brief is the fallback when no keywords were given.
        const promptText =
            (input.inventory.keywords.length > 0 ? input.inventory.keywords.join(', ') : null) ??
            input.rawPrompt ??
            [input.brand.name, input.brand.category, input.campaign.objective && `${input.campaign.objective} campaign`]
                .filter(Boolean)
                .join(', ');
        const audience = describeAudience(input);
        const targetingText = [
            input.inventory.iabCategories.length > 0 ? `Interests: ${input.inventory.iabCategories.join(', ')}` : '',
            audience ? `Audience: ${audience}` : '',
        ]
            .filter(Boolean)
            .join('. ');
        const queries = (await Promise.all([embedText(promptText), embedText(targetingText)])).filter(
            (v): v is Float32Array => v !== null
        );
        if (queries.length > 0) {
            for (const c of all) {
                const e = embeddings.get(embeddingKey(c.name));
                if (e) semantic.set(c, queries.reduce((sum, q) => sum + cosine(q, e.vector), 0) / queries.length);
            }
            const values = [...semantic.values()];
            const min = Math.min(...values);
            const range = Math.max(...values) - min;
            semantic = new Map([...semantic].map(([c, v]) => [c, range > 0 ? (v - min) / range : NEUTRAL_MATCH]));
        }
    }

    const asked = input.inventory.iabCategories;
    for (const c of all) {
        const s = semantic.get(c);
        const iab =
            asked.length > 0 && c.iabCategories !== null ? (c.iabCategories.some(cat => asked.includes(cat)) ? 1 : 0) : undefined;
        c.matchScore = c.isPreferred
            ? 1
            : s !== undefined && iab !== undefined
              ? 0.7 * s + 0.3 * iab
              : (s ?? iab ?? NEUTRAL_MATCH);
        c.matchScore = Math.round(c.matchScore * 1000) / 1000;
    }

    // Percentile within the line (ties share the midpoint), so every line spreads its own items
    // across the 1-25% range regardless of how its raw scores compare to another line's.
    for (const items of Object.values(byLine)) {
        for (const c of items) {
            const below = items.filter(o => o.matchScore < c.matchScore).length;
            const equal = items.filter(o => o.matchScore === c.matchScore).length;
            c.targetFill = targetFillFor(items.length === 1 ? 0.5 : (below + (equal - 1) / 2) / (items.length - 1));
        }
    }
};

const ALTERNATIVES_PER_NAME = 5;

/** Character-trigram overlap — the fallback for ranking alternatives when there are no embeddings. */
const trigramSimilarity = (a: string, b: string): number => {
    const grams = (s: string) => {
        const c = ` ${compact(s)} `;
        return new Set(Array.from({ length: Math.max(c.length - 2, 0) }, (_, i) => c.slice(i, i + 3)));
    };
    const ga = grams(a);
    const gb = grams(b);
    const shared = [...ga].filter(g => gb.has(g)).length;
    return shared / Math.max(ga.size + gb.size - shared, 1);
};

/** The closest real properties to a name that doesn't exist: semantic neighbours when embeddings exist, spelling neighbours otherwise. */
const alternativesFor = async (term: string, names: InventoryName[]): Promise<NonNullable<InputWarning['alternatives']>> => {
    const embeddings = await getInventoryEmbeddings();
    const query = embeddings.size > 0 ? await embedText(term) : null;
    if (query) {
        return [...embeddings.values()]
            .map(e => ({ e, sim: cosine(query, e.vector) }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, ALTERNATIVES_PER_NAME)
            .map(({ e }) => ({ name: e.name, lines: e.lines }));
    }
    const byName = new Map<string, InventoryLine[]>();
    for (const n of names) byName.set(n.name, [...(byName.get(n.name) ?? []), n.line]);
    return [...byName]
        .map(([name, lines]) => ({ name, lines: [...new Set(lines)], sim: trigramSimilarity(term, name) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, ALTERNATIVES_PER_NAME)
        .map(({ name, lines }) => ({ name, lines }));
};

/**
 * Names in preferredSitesApps / blockedSitesApps that match no real property in any inventory
 * table (same name/id matching the candidate fetchers use) — a bogus or misspelt property —
 * each with the closest real alternatives. `term` is the entry as given.
 */
export const findUnknownInventory = async (input: PlannerInput): Promise<(InputWarning & { term: string })[]> => {
    const terms = [
        ...input.inventory.preferredSitesApps.map(term => ({ field: 'inventory.preferredSitesApps', term })),
        ...input.inventory.blockedSitesApps.map(term => ({ field: 'inventory.blockedSitesApps', term })),
    ].filter(t => t.term.trim() !== '');
    if (terms.length === 0) return [];

    const names = await getInventoryNames();
    const unknown = terms.filter(
        ({ term }) => !names.some(n => caseInsensitiveMatch(n.name, [term]) || caseInsensitiveMatchId(n.id, [term]))
    );
    return Promise.all(
        unknown.map(async ({ field, term }) => ({
            field,
            term,
            message: `"${term}" isn't in the inventory, so it can't be ${field.endsWith('blockedSitesApps') ? 'excluded' : 'planned'}.`,
            alternatives: await alternativesFor(term, names),
        }))
    );
};

/** Drops unknown names from preferredSitesApps / blockedSitesApps (in place) and returns them as warnings with alternatives. */
export const removeUnknownInventory = async (input: PlannerInput): Promise<InputWarning[]> => {
    const unknown = await findUnknownInventory(input);
    for (const { field, term } of unknown) {
        const key = field === 'inventory.preferredSitesApps' ? 'preferredSitesApps' : 'blockedSitesApps';
        input.inventory[key] = input.inventory[key].filter(t => t !== term);
    }
    return unknown.map(({ term: _term, ...warning }) => warning);
};

/** At or below this many states, geo targeting is narrow enough to price up. */
const MAX_STATES_FOR_UPLIFT = 4;

/**
 * Targeting surcharges, each a percent of the base price added together, never compounded:
 * 1–4 states +10%; any demographic (age, gender, income) +10%; interest + audience together
 * +15% instead of that +10%. The same uplift applies to every line — rate-card premium/advanced
 * columns aren't used, so targeting is never charged twice.
 */
export const computePriceUplift = (input: PlannerInput): PriceUplift => {
    const uplifts: PriceUplift['uplifts'] = [];
    const { geoScope, states } = input.audience;
    if (geoScope === 'states' && states.length > 0 && states.length <= MAX_STATES_FOR_UPLIFT) {
        uplifts.push({ rule: 'states', percent: 10 });
    }
    if (hasAudienceTargeting(input)) {
        uplifts.push(
            hasInterestTargeting(input)
                ? { rule: 'interest-audience', percent: 15 }
                : { rule: 'demographic', percent: 10 }
        );
    }
    return { upliftPercent: uplifts.reduce((sum, u) => sum + u.percent, 0), uplifts };
};

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

/** Strips everything but letters/digits so formatting differences ("Tarang Plus" vs. the real sheet's "TarangPlus", "Haystack TV" vs. "haystacktv.com") don't break an otherwise-obvious match. */
const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** True if `term` appears in `value` with a real boundary on both sides (string start/end, or any non-alphanumeric character) — not just anywhere as a raw substring. */
const hasWordBoundaryMatch = (value: string, term: string): boolean => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(value);
};

/** Shortest name that may count as matched just because a longer term contains it. */
const MIN_CONTAINED_NAME = 5;

const caseInsensitiveMatch = (value: string, list: string[]): boolean => {
    if (!value) return false; // an empty value would otherwise match every entry via ''.includes()
    const lower = value.toLowerCase();
    const valueCompact = compact(value);
    return list.some(entry => {
        const e = entry.toLowerCase().trim();
        if (e.length === 0) return false;
        // Short terms (acronyms especially) are prone to coincidental substring collisions —
        // verified live that "WSJ" (3 chars) genuinely, literally appears inside
        // "actionnewsjax.com" with no compacting involved at all ("new" + "s" + "jax" already run
        // together with no separator in the real domain name). A plain .includes() can't tell
        // that apart from a real "wsj.com" match, so short terms require a real boundary (string
        // start/end or a non-alphanumeric character) on both sides instead.
        if (e.length < 5) return hasWordBoundaryMatch(value, e) || hasWordBoundaryMatch(e, value);
        // The reverse direction (the term contains the whole name) only for names of 5+ characters —
        // a short real name like "App" or "TV" is contained in almost any multi-word term.
        if (lower.includes(e) || (lower.length >= MIN_CONTAINED_NAME && e.includes(lower))) return true;
        // Compacting (stripping spaces/punctuation) catches a real multi-word name variant that
        // the raw check above misses entirely — e.g. "Tarang Plus" vs. the sheet's "TarangPlus",
        // which has no boundary between the two words at all to match on.
        // Both sides must survive compacting: a name in another script (e.g. Devanagari) compacts
        // to '', and every string includes '' — that matched every such name against any term.
        const eCompact = compact(entry);
        return (
            eCompact.length > 0 &&
            valueCompact.length > 0 &&
            (valueCompact.includes(eCompact) || (valueCompact.length >= MIN_CONTAINED_NAME && eCompact.includes(valueCompact)))
        );
    });
};

/**
 * For matching against a raw technical identifier (package id / app URL slug) rather than a real
 * display name — verified live that a short preferred term can coincidentally collide inside an
 * unrelated concatenated id (e.g. "WSJ" matching inside "com.playvalve.wsjourney", a
 * word-search-journey puzzle game with zero connection to the Wall Street Journal). Requiring at
 * least 5 characters before trying this match at all avoids that; short acronyms still match
 * fine against real display names via caseInsensitiveMatch above.
 */
const caseInsensitiveMatchId = (value: string, list: string[]): boolean =>
    caseInsensitiveMatch(value, list.filter(entry => entry.trim().length >= 5));

/**
 * A floor, not a configurable exclusion — applied regardless of what the input specifies.
 * Mainly covers In-App and CTV/Mobile OTT, which have no category data at all to filter on
 * (unlike Websites, which can be excluded by real IAB category instead) — without this, those
 * three lines have literally nothing stopping an obviously mismatched or brand-unsafe app
 * (e.g. a dating app) from scoring well on volume/cost alone and getting recommended.
 */
export const DEFAULT_UNSAFE_KEYWORDS = [
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

const failsBrandSafety = (name: string): boolean => caseInsensitiveMatch(name, DEFAULT_UNSAFE_KEYWORDS);

/**
 * Primarily data-driven (what targeting the inputs actually specify), not an LLM judgment call —
 * keeping this deterministic is what makes the whole plan reproducible for the same input. See
 * allocation.service.ts's top comment for why the plan removes LLM variance from decisions.
 * Only a label now: prices always come from the open column plus computePriceUplift.
 */
export const computeRateTier = (input: PlannerInput): RateTier => {
    const audience = hasAudienceTargeting(input);

    let tier: RateTier = 'open';
    if (audience && hasInterestTargeting(input)) tier = 'advance';
    else if (audience) tier = 'premium';

    // quality_tier is a floor, not an override — it can only push the tier up, never down below
    // what the audience/content targeting itself already earns.
    if (input.inventory.qualityTier === 'premium-only' && tier === 'open') tier = 'premium';

    return tier;
};

/** `url` is a raw technical identifier (package id / app URL), not a display name — matched via caseInsensitiveMatchId's short-term guard, never the full caseInsensitiveMatch. */
const isBlocked = (name: string, url: string, input: PlannerInput): boolean =>
    caseInsensitiveMatch(name, input.inventory.blockedSitesApps) ||
    caseInsensitiveMatchId(url, input.inventory.blockedSitesApps);
const isPreferred = (name: string, url: string, input: PlannerInput): boolean =>
    caseInsensitiveMatch(name, input.inventory.preferredSitesApps) ||
    caseInsensitiveMatchId(url, input.inventory.preferredSitesApps);

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
const fetchCtvCandidates = async (input: PlannerInput, upliftPercent: number): Promise<CandidateInventoryItem[]> => {
    const rows = await prisma.inventoryCtvInventory.findMany();
    return rows
        .filter(r => !isBlocked(r.applicationName, r.appUrl, input))
        .filter(r => !failsBrandSafety(r.applicationName) && !failsBrandSafety(r.appUrl))
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
            cpm: clientCpm(r.cpmOpen, upliftPercent),
            vcr: r.vcr,
            iabCategories: null, // no category column in this sheet
            isPreferred: isPreferred(r.applicationName, r.appUrl, input),
        }))
        .map(c => scaleByTargeting(c, targetingFactor(input, DEFAULT_LINE_SHARES[c.line])))
        .filter(c => c.avails > 0)
        // A property named in preferredSitesApps bypasses these — they're meant to narrow
        // general discovery, not to hide a specifically-asked-about property that happens not to
        // clear a bar meant for everything else (verified live: wsj.com is tagged "IAB5
        // Education" in the real sheet, not the "IAB3 Business" a brief about financial
        // publishers would naturally filter to — a hard filter would hide it even though it was
        // named explicitly).
        .filter(c => c.isPreferred || input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(
            c =>
                c.isPreferred ||
                input.inventory.minVcrPct === null ||
                (c.vcr ?? 0) * 100 >= input.inventory.minVcrPct
        )
        .filter(c => c.isPreferred || passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

const fetchMobileOttCandidates = async (
    input: PlannerInput,
    upliftPercent: number
): Promise<CandidateInventoryItem[]> => {
    const rows = await prisma.inventoryMobileOttInventory.findMany();
    return rows
        .filter(r => !isBlocked(r.appName, r.packageId, input))
        .filter(r => !failsBrandSafety(r.appName) && !failsBrandSafety(r.packageId))
        .map(r => ({
            id: r.packageId,
            name: r.appName,
            line: 'mobile-ott' as InventoryLine,
            platform: 'mobile-ott' as Platform,
            avails: Number(r.totalAvails),
            // No separate uniques column in this sheet — left null rather than estimated.
            uniqueAudience: null,
            cpm: clientCpm(r.cpmOpen, upliftPercent),
            vcr: r.vcr,
            iabCategories: null, // no category column in this sheet
            isPreferred: isPreferred(r.appName, r.packageId, input),
        }))
        .map(c => scaleByTargeting(c, targetingFactor(input, DEFAULT_LINE_SHARES[c.line])))
        .filter(c => c.avails > 0)
        .filter(c => c.isPreferred || input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(
            c =>
                c.isPreferred ||
                input.inventory.minVcrPct === null ||
                (c.vcr ?? 0) * 100 >= input.inventory.minVcrPct
        )
        .filter(c => c.isPreferred || passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

const fetchWebsiteCandidates = async (input: PlannerInput, upliftPercent: number): Promise<CandidateInventoryItem[]> => {
    // mediaTypes/iabCategories used to narrow this at the DB query level, but that could hide a
    // specifically-named preferredSitesApps match entirely before isPreferred is even computed
    // (verified live: wsj.com is tagged "IAB5 Education" in the real sheet, not "IAB3 Business").
    // Fetching unfiltered and narrowing in JS instead (consistent with how the other three fetch
    // functions already work) lets a named match bypass these — 30k rows is small enough that
    // this costs nothing meaningful.
    const rows = await prisma.inventoryWebsite.findMany();
    const wantedAdFormats: string[] | null =
        input.inventory.mediaTypes.length > 0
            ? input.inventory.mediaTypes.map(m => (m === 'display' ? 'Display' : 'Video'))
            : null;
    return rows
        .filter(r => !isBlocked(r.inventoryName, '', input))
        .filter(r => !failsBrandSafety(r.inventoryName))
        .filter(r => isPreferred(r.inventoryName, '', input) || !wantedAdFormats || wantedAdFormats.includes(r.adFormat))
        .map(r => scaleByTargeting({
            id: r.inventoryName,
            name: r.inventoryName,
            line: 'websites' as InventoryLine,
            platform: 'web' as Platform,
            avails: Number(r.totalImpressions),
            uniqueAudience: r.totalUniqueAudience === null ? null : Number(r.totalUniqueAudience),
            cpm: clientCpm(r.buyingCpm, upliftPercent),
            vcr: null, // not present in this sheet
            iabCategories: r.iabCategories,
            isPreferred: isPreferred(r.inventoryName, '', input),
        }, targetingFactor(input, websiteShares(r))))
        .filter(c => c.avails > 0)
        .filter(
            c =>
                c.isPreferred ||
                input.inventory.iabCategories.length === 0 ||
                (c.iabCategories ?? []).some(cat => input.inventory.iabCategories.includes(cat))
        )
        .filter(c => c.isPreferred || input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(c => c.isPreferred || passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

const fetchInAppCandidates = async (input: PlannerInput, upliftPercent: number): Promise<CandidateInventoryItem[]> => {
    // mediaTypes narrowed this at the DB query level before — moved to JS (see
    // fetchWebsiteCandidates's comment for why) so a preferredSitesApps name match isn't hidden
    // by it.
    const rows = await prisma.inventoryMobileInApp.findMany();
    const wantedAdFormats: string[] | null =
        input.inventory.mediaTypes.length > 0
            ? input.inventory.mediaTypes.map(m => (m === 'display' ? 'Display' : 'Video'))
            : null;
    return rows
        // 0 means no real price in this sheet at all, not a free placement — never bypassed even
        // for a preferred match, since a zero CPM would divide-by-zero downstream in the
        // allocation math, not just under-rank the item.
        .filter(r => r.eCpm > 0)
        .filter(r => !isBlocked(r.appName, r.inventoryUrl, input))
        .filter(r => !failsBrandSafety(r.appName) && !failsBrandSafety(r.inventoryUrl))
        .filter(
            r => isPreferred(r.appName, r.inventoryUrl, input) || !wantedAdFormats || wantedAdFormats.includes(r.adFormat)
        )
        .map(r => ({
            id: r.inventoryUrl,
            name: r.appName,
            line: 'in-app' as InventoryLine,
            platform: 'in-app' as Platform,
            avails: Number(r.totalRequests),
            uniqueAudience: null, // not present in this sheet
            cpm: clientCpm(r.eCpm, upliftPercent),
            vcr: null, // not present in this sheet
            iabCategories: null, // no category column in this sheet
            isPreferred: isPreferred(r.appName, r.inventoryUrl, input),
        }))
        .map(c => scaleByTargeting(c, targetingFactor(input, DEFAULT_LINE_SHARES[c.line])))
        .filter(c => c.avails > 0)
        .filter(c => c.isPreferred || input.inventory.maxCpm === null || c.cpm <= input.inventory.maxCpm)
        .filter(c => c.isPreferred || passesVolumeFilters(c.avails, c.uniqueAudience, input));
};

export interface CandidateResult {
    byLine: Record<InventoryLine, CandidateInventoryItem[]>;
    /** Requested platforms with zero real data behind them at all (YouTube, or anything the filters left with nothing) — these never reach the LLM, they go straight to plannedByTeam. */
    unplannablePlatforms: Platform[];
    inventoryWarnings: InputWarning[];
}

/** Stage 1 — deterministic, no LLM. Builds the real shortlist the allocation engine and narration call both work from. */
export const buildCandidateInventory = async (input: PlannerInput): Promise<CandidateResult> => {
    const requestedPlatforms = input.inventory.platforms.length > 0 ? input.inventory.platforms : PLATFORMS_ALL;
    const { upliftPercent } = computePriceUplift(input);

    const linesNeeded = new Set(requestedPlatforms.flatMap(p => PLATFORM_LINE_MAP[p]));

    const ctvNeeded = linesNeeded.has('ctv-fast') || linesNeeded.has('ctv-ott');
    const allCtv = ctvNeeded ? await fetchCtvCandidates(input, upliftPercent) : [];

    const byLine: Record<InventoryLine, CandidateInventoryItem[]> = {
        'ctv-fast': linesNeeded.has('ctv-fast') ? allCtv.filter(c => c.line === 'ctv-fast') : [],
        'ctv-ott': linesNeeded.has('ctv-ott') ? allCtv.filter(c => c.line === 'ctv-ott') : [],
        'mobile-ott': linesNeeded.has('mobile-ott') ? await fetchMobileOttCandidates(input, upliftPercent) : [],
        websites: linesNeeded.has('websites') ? await fetchWebsiteCandidates(input, upliftPercent) : [],
        'in-app': linesNeeded.has('in-app') ? await fetchInAppCandidates(input, upliftPercent) : [],
    };

    // A brief naming a specific property in inventory.preferredSitesApps is asking "do you have
    // X" — verified live that the honest answer can depend entirely on which line the suggest
    // call happened to guess for it (e.g. "Tarang Plus" named under "mobile" only actually exists
    // in the in-app table, not mobile-ott; "Haystack TV" only exists in websites/in-app, not
    // ctv). Check every line NOT already covered by the requested platforms for a literal name
    // match, and pull in only the matched item(s) — never that line's whole generic inventory.
    // This never removes or overrides anything from the lines actually requested; it only adds a
    // transparent answer to a question asked by name, and each match keeps its own real
    // .line/.platform so the output honestly shows where it actually lives even when that's a
    // different platform than first assumed. (Known limitation: a match here still has to pass
    // the same maxCpm/minVcrPct/volume filters as everything else, since those run inside each
    // fetch function — a named property priced or sized outside those filters still won't surface.)
    if (input.inventory.preferredSitesApps.length > 0) {
        if (!ctvNeeded) {
            for (const c of (await fetchCtvCandidates(input, upliftPercent)).filter(c => c.isPreferred)) {
                byLine[c.line].push(c);
            }
        }
        if (!linesNeeded.has('mobile-ott')) {
            byLine['mobile-ott'].push(...(await fetchMobileOttCandidates(input, upliftPercent)).filter(c => c.isPreferred));
        }
        if (!linesNeeded.has('websites')) {
            byLine.websites.push(...(await fetchWebsiteCandidates(input, upliftPercent)).filter(c => c.isPreferred));
        }
        if (!linesNeeded.has('in-app')) {
            byLine['in-app'].push(...(await fetchInAppCandidates(input, upliftPercent)).filter(c => c.isPreferred));
        }
    }

    // A platform maps to one or more lines (see PLATFORM_LINE_MAP) — it's only truly
    // unplannable if every line it could mean came back with nothing at all.
    const unplannablePlatforms = requestedPlatforms.filter(p => {
        const lines = PLATFORM_LINE_MAP[p];
        return lines.length === 0 || lines.every(line => byLine[line].length === 0);
    });

    await scoreMatches(input, byLine);

    // Named properties that exist nowhere: left out of the plan, reported with alternatives.
    const inventoryWarnings = (await findUnknownInventory(input)).map(({ term: _term, ...warning }) => warning);

    return { byLine, unplannablePlatforms, inventoryWarnings };
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
