import { z } from 'zod';

export const GEO_TIERS = ['tier-1', 'tier-2', 'national', 'custom'] as const;
export const GENDER_SKEWS = ['male', 'female'] as const;
export const FORMATS = ['audio', 'video', 'display'] as const;
export const PLATFORMS = ['ios', 'android', 'web', 'ctv'] as const;
export const QUESTION_OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

export interface AnalyseContext {
    country: string;
    channels: string[];
    objectives: string[];
    kpis: string[];
    // Populated by plan-prompts.ts from inventory.service.ts's getIabCategories() before
    // building the core schema — the real categories the ingested rate-card data actually
    // covers, so "campaign.category" maps to one of these rather than an invented one with
    // no inventory behind it. Empty until that call completes.
    iabCategories?: string[];
}

/** One prompt+schema pair per brief shape the console has to handle — see config/plan-prompts.ts. */
export const PROMPT_TYPES = ['campaign-brief', 'inventory-rfp'] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];

export interface AnalyseRequestBody {
    brief: string;
    // Optional — the brief is free text, so the caller isn't required to already know which
    // internal prompt/schema this endpoint should use. Omitted, plan.service.ts classifies
    // it from the brief itself; passed explicitly, that always wins (useful for testing a
    // specific profile).
    type?: PromptType;
    context: AnalyseContext;
}

/**
 * A question option's `value` writes straight into the plan field it answers, so its type
 * has to track whatever that field can hold — including the bundled flight {start, end}
 * object (see campaign.flight below), not just scalars/arrays.
 */
const optionValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.object({ start: z.string(), end: z.string() }),
    z.null(),
]);

const questionSchema = z.object({
    id: z.string(),
    field: z.string(),
    category: z.string(),
    question: z.string(),
    hint: z.string(),
    impact: z.string(),
    // No .length(4)/.max(4) — Bedrock's strict-schema validator rejects both minItems > 1
    // and maxItems on arrays outright (confirmed against live calls). "Exactly 4" is
    // enforced by the prompt instruction plus a post-generation trim in plan-prompts.ts.
    options: z.array(
        z.object({
            key: z.enum(QUESTION_OPTION_KEYS),
            label: z.string(),
            detail: z.string(),
            value: optionValueSchema,
        })
    ),
});

/** z.enum() needs a non-empty tuple; an empty context list degrades to free text instead of a 500. */
const enumOrNull = (values: string[]) =>
    values.length > 0 ? z.enum(values as [string, ...string[]]).nullable() : z.string().nullable();

/**
 * The stated-facts half of a campaign brief: what's actually written down, extracted
 * as-is. Its own Bedrock call — combined with everything in buildEstimatesSchema below,
 * the two together tripped Bedrock's strict-schema grammar-complexity ceiling on
 * Haiku-class models ("compiled grammar is too large", confirmed live repeatedly); apart,
 * each comfortably fits. plan-prompts.ts runs this one first, then the other.
 */
export const buildCoreSchema = (context: AnalyseContext) => {
    const campaign = z.object({
        campaignName: z.string().nullable(),
        advertiser: z.string().nullable(),
        product: z.string().nullable(),
        // Constrained to the real IAB categories the ingested rate-card data covers (see
        // AnalyseContext.iabCategories) — null when nothing in that list genuinely fits,
        // rather than a free-text guess with no inventory behind it. plan-prompts.ts uses
        // this to look up real CPM/availability for the campaign's channels.
        category: enumOrNull(context.iabCategories ?? []),
        objective: enumOrNull(context.objectives),
        kpi: enumOrNull(context.kpis),
        budget: z.number().int().nullable(),
        currency: z.string(),
        durationDays: z.number().int().nullable(),
        // One nullable object, not two nullable strings — every nullable field saved
        // matters against Bedrock's 16-field union-type budget. A flight is stated with
        // both edges or neither, so bundling loses nothing real.
        flight: z.object({ start: z.string(), end: z.string() }).nullable(),
        frequencyCap: z.string().nullable(),
    });

    const market = z.object({
        country: z.string(),
        geos: z.array(z.string()),
        geoTier: z.enum(GEO_TIERS).nullable(),
        excludedGeos: z.array(z.string()),
    });

    const audience = z.object({
        // Not z.tuple() (draft-07-style array "items", rejected outright) and no
        // .length(2)/.max(2) (any minItems > 1 or any maxItems at all is rejected too) —
        // "exactly 2" is enforced by the prompt plus a post-generation check that nulls
        // out anything that isn't (see plan-prompts.ts).
        ageRange: z.array(z.number().int()).nullable(),
        genderSkew: z.enum(GENDER_SKEWS).nullable(),
        incomeStrata: z.array(z.string()),
        affinitySegments: z.array(z.string()),
        audienceSegments: z.array(z.string()),
        exclusions: z.array(z.string()),
    });

    const summary = z.object({
        impressionGoal: z.number().int().nullable(),
        reachGoal: z.number().int().nullable(),
        requestedMetrics: z.array(z.string()),
        unavailableMetrics: z.array(z.string()),
    });

    return z.object({ campaign, market, audience, summary });
};

/**
 * The modelled-estimates half, inventory's stated ad-spec fields, and gap questions — all
 * in one call, run after buildCoreSchema's (questions needs to know which core fields came
 * back null). There's no live inventory system or audience-measurement data behind this
 * endpoint, so every numeric/list estimate here is the model's best plausible guess, not a
 * real number; the prompt is explicit about which fields are estimates vs. stated facts.
 *
 * "Split" fields (genderSplit/ageSplit/geoSplit) are "Label|percent" strings, not
 * {label, percent} objects — object-shaped array items were the single biggest contributor
 * to the grammar-size ceiling (confirmed live). plan-prompts.ts parses them back into the
 * proper typed shape before this ever reaches a caller. The richer per-channel/publisher/
 * site breakdown lives in buildDetailSchema below, its own call — doesn't fit here too.
 */
export const buildEstimatesSchema = (context: AnalyseContext) => {
    const audience = z.object({
        genderSplit: z.array(z.string()),
        ageSplit: z.array(z.string()),
        geoSplit: z.array(z.string()),
    });

    const inventory = z.object({
        // Stated facts — extracted verbatim, same rules as buildCoreSchema's fields.
        formats: z.array(z.enum(FORMATS)),
        platforms: z.array(z.enum(PLATFORMS)),
        placementsNamed: z.array(z.string()),
        videoPlacements: z.array(z.string()),
        creativeDurations: z.array(z.string()),
        languages: z.array(z.string()),
        adUnits: z.array(z.string()),
        // Modelled estimates from here down.
        matchedTerms: z.array(z.string()),
        unmatchedTerms: z.array(z.string()),
        // Not nullable — 0 when there's nothing to estimate from. Two flat ints, not a
        // nested {impressions, uniques} object — one less object shape to compile.
        availableImpressions: z.number().int(),
        availableUniques: z.number().int(),
    });

    return z.object({
        audience,
        inventory,
        questions: z.array(questionSchema),
        // Flat "field::jsonValue" strings, not {field, value} objects — same reason the
        // split fields above are compact strings, not {label, percent}: object-shaped array
        // items are the biggest contributor to the grammar-size ceiling, and this schema is
        // already near it. Parsed back in plan-prompts.ts.
        assumedDefaults: z.array(z.string()),
    });
};

/**
 * The detailed inventory breakdown — per-channel rows/impressions/uniques, named
 * publishers with their own numbers, and a per-site/app breakdown. Cut from the original
 * schema entirely (this was the single heaviest piece, "compiled grammar is too large"),
 * then confirmed live to fit fine as its own ~1.1K-char call. Doesn't depend on
 * buildCoreSchema's or buildEstimatesSchema's output, so plan-prompts.ts runs it in
 * parallel with both rather than after them — same modelled-estimate caveat as
 * buildEstimatesSchema: no live inventory system behind any of these numbers.
 */
export const buildDetailSchema = () => {
    const channel = z.object({
        id: z.string(),
        allocation: z.number(),
        rows: z.number().int(),
        impressions: z.number().int(),
        uniques: z.number().int(),
    });

    const publisher = z.object({
        name: z.string(),
        rows: z.number().int(),
        impressions: z.number().int(),
    });

    const site = z.object({
        identifier: z.string(),
        name: z.string(),
        platform: z.string(),
        impressions: z.number().int(),
        uniques: z.number().int(),
        audioImpressions: z.number().int(),
        displayImpressions: z.number().int(),
        videoImpressions: z.number().int(),
    });

    return z.object({
        channels: z.array(channel),
        publishers: z.array(publisher),
        sites: z.array(site),
    });
};

export type CoreResponseSchema = ReturnType<typeof buildCoreSchema>;
export type CoreResponse = z.infer<CoreResponseSchema>;
export type EstimatesResponseSchema = ReturnType<typeof buildEstimatesSchema>;
export type EstimatesResponse = z.infer<EstimatesResponseSchema>;
export type DetailResponseSchema = ReturnType<typeof buildDetailSchema>;
export type DetailResponse = z.infer<DetailResponseSchema>;
export type AnalyseQuestion = z.infer<typeof questionSchema>;

export interface AnalyseChannel {
    id: string;
    allocation: number;
    amount: number;
    rows: number;
    impressions: number;
    uniques: number;
    /** Real CPM from the ingested rate card when this channel's category/platform matched; null otherwise (cpm stays implicit in the modelled impressions/uniques above). */
    cpm: number | null;
    /** The real total addressable inventory behind "cpm" — the ceiling, not this campaign's modelled delivery. Null when unmatched. */
    availableImpressions: number | null;
    source: 'real' | 'estimate';
}

export interface MatchedPackageSummary {
    packageName: string;
    details: string | null;
    floorCpm: number;
    device: string;
    publishers: string[];
}

/** The merged shape plan-prompts.ts returns — core + estimates + detail + a few computed/parsed fields. */
export interface AnalyseResponse {
    campaign: CoreResponse['campaign'] & { dailyBudget: number };
    market: CoreResponse['market'];
    audience: CoreResponse['audience'] & {
        femaleWeight: number;
        gender: { label: string; percent: number }[];
        age: { label: string; percent: number }[];
        geo: { label: string; percent: number }[];
    };
    inventory: Omit<EstimatesResponse['inventory'], 'availableImpressions' | 'availableUniques'> & {
        source: 'selection' | 'brief' | 'all';
        available: { impressions: number; uniques: number };
        channels: AnalyseChannel[];
        publishers: DetailResponse['publishers'];
        sites: (DetailResponse['sites'][number] & { source: 'real' | 'estimate' })[];
        /** PMP packages from the ingested rate card matching this campaign's geo/device — a bonus, not per-channel grounding (these are pre-bundled deals a planner can buy outright). */
        packages: MatchedPackageSummary[];
    };
    summary: CoreResponse['summary'] & {
        basis: string;
        impressions: number;
        reach: number;
        availableImpressions: number;
        availableUniques: number;
    };
    questions: AnalyseQuestion[];
    /** Dot paths (e.g. "audience.genderSkew") the second call filled with a plausible default rather than leaving null — everything left null instead is either genuinely optional (an empty exclusions/incomeStrata list) or pending one of "questions" above. */
    assumptions: string[];
}
