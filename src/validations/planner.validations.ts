import Joi from 'joi';
import { ApiError } from '../utils/apiError';
import {
    AGE_GROUPS,
    INCOME_GROUPS,
    DEAL_TYPES,
    DIVERSIFICATIONS,
    DSP_CHOICES,
    FREQUENCY_CAP_PERIODS,
    GENDERS,
    GEO_SCOPES,
    KPI_METRICS,
    MEDIA_TYPES,
    OBJECTIVES,
    OPTIMISE_FOR,
    PACINGS,
    PLATFORMS,
    QUALITY_TIERS,
    SKIPPABILITY,
    SPENDOPTIX_DSP_ROUTES,
    VIDEO_DURATIONS,
    VIDEO_PLACEMENTS,
    PlannerInput,
} from '../types/planner.types';

// Every field is optional per the product spec ("Every input field is optional. Anything
// missing is filled with a sensible default") — Call 1 ("suggest") is what's expected to
// usually fill this in from a free-text prompt, but Call 2 ("generate") accepts a fully
// hand-built input too (e.g. "Create Your Own Media Plan" in the product flow), so nothing
// here is required.

const stringArray = Joi.array().items(Joi.string()).default([]);

export const suggestPromptSchema = Joi.object({
    prompt: Joi.string().trim().min(1).max(20000).required(),
});

// Loose on purpose — `input`/`plan` are round-tripped from what POST /plans itself just
// returned moments earlier (or a locally-edited copy of it), not re-validated field by field;
// the save envelope's own inner blocks aren't shape-constrained at all beyond being an object
// (see plan.types.ts), so there's nothing stricter to gain by re-checking shape here.
export const savePlanSchema = Joi.object({
    input: Joi.object().unknown(true).required(),
    plan: Joi.object().unknown(true).required(),
    // The prompt this plan was built from — stored as the plan's brief and used by refine as the
    // "earlier prompt". Falls back to input.rawPrompt when not sent.
    prompt: Joi.string().trim().max(20000).allow(null).empty('').default(null),
});

// Every nullable field also carries .empty('') — caught live: the suggest call (Call 1) can
// return an empty string for a field it had no real value for (e.g. campaign.seasonality) rather than a
// clean null, and .allow(null) alone doesn't accept '' as a value. .empty('') treats '' as
// "absent", which then falls through to each field's own .default(null) instead of failing
// validation outright.
export const generatePlanSchema = Joi.object({
    rawPrompt: Joi.string().allow(null).empty('').default(null),

    brand: Joi.object({
        name: Joi.string().allow(null).empty('').default(null),
        category: Joi.string().allow(null).empty('').default(null),
    }).default(),

    campaign: Joi.object({
        objective: Joi.string()
            .valid(...OBJECTIVES)
            .allow(null).empty('')
            .default(null),
        kpis: Joi.array()
            .items(
                Joi.object({
                    metric: Joi.string()
                        .valid(...KPI_METRICS)
                        .required(),
                    target: Joi.number().allow(null).empty('').default(null),
                })
            )
            .default([]),
        budget: Joi.number().integer().min(0).allow(null).empty('').default(null),
        startDate: Joi.string().isoDate().allow(null).empty('').default(null),
        endDate: Joi.string().isoDate().allow(null).empty('').default(null),
        campaignMonth: Joi.string().allow(null).empty('').default(null),
        seasonality: Joi.string().allow(null).empty('').default(null),
        pacing: Joi.string()
            .valid(...PACINGS)
            .allow(null).empty('')
            .default(null),
        regionalTargets: Joi.array()
            .items(
                Joi.object({
                    region: Joi.string().required(),
                    impressions: Joi.number().min(0).required(),
                })
            )
            .default([]),
    }).default(),

    audience: Joi.object({
        country: Joi.string().allow(null).empty('').default(null),
        geoScope: Joi.string()
            .valid(...GEO_SCOPES)
            .allow(null).empty('')
            .default(null),
        states: stringArray,
        excludeStates: stringArray,
        gender: Joi.string()
            .valid(...GENDERS)
            .allow(null).empty('')
            .default(null),
        ageGroups: Joi.array()
            .items(Joi.string().valid(...AGE_GROUPS))
            .default([]),
        incomeGroups: Joi.array()
            .items(Joi.string().valid(...INCOME_GROUPS))
            .default([]),
    }).default(),

    inventory: Joi.object({
        platforms: Joi.array()
            .items(Joi.string().valid(...PLATFORMS))
            .default([]),
        mediaTypes: Joi.array()
            .items(Joi.string().valid(...MEDIA_TYPES))
            .default([]),
        iabCategories: stringArray,
        keywords: stringArray,
        qualityTier: Joi.string()
            .valid(...QUALITY_TIERS)
            .allow(null).empty('')
            .default(null),
        preferredSitesApps: stringArray,
        blockedSitesApps: stringArray,
        minViewabilityPct: Joi.number().min(0).max(100).allow(null).empty('').default(null),
        minVcrPct: Joi.number().min(0).max(100).allow(null).empty('').default(null),
        maxCpm: Joi.number().min(0).allow(null).empty('').default(null),
        minAvails: Joi.number().integer().min(0).allow(null).empty('').default(null),
        minUniqueAudience: Joi.number().integer().min(0).allow(null).empty('').default(null),
        channelCpmTargets: Joi.array()
            .items(
                Joi.object({
                    platform: Joi.string()
                        .valid(...PLATFORMS)
                        .required(),
                    maxCpm: Joi.number().min(0).required(),
                })
            )
            .default([]),
    }).default(),

    creative: Joi.object({
        displayFormats: stringArray,
        displaySizes: stringArray,
        videoPlacements: Joi.array()
            .items(Joi.string().valid(...VIDEO_PLACEMENTS))
            .default([]),
        videoDurations: Joi.array()
            .items(Joi.string().valid(...VIDEO_DURATIONS))
            .default([]),
        skippability: Joi.array()
            .items(Joi.string().valid(...SKIPPABILITY))
            .default([]),
    }).default(),

    buying: Joi.object({
        dspChoice: Joi.string()
            .valid(...DSP_CHOICES)
            .allow(null).empty('')
            .default(null),
        spendoptixDspRoute: Joi.string()
            .valid(...SPENDOPTIX_DSP_ROUTES)
            .allow(null).empty('')
            .default(null),
        ownDspNames: stringArray,
        seatId: Joi.string().allow(null).empty('').default(null),
        dealType: Joi.string()
            .valid(...DEAL_TYPES)
            .allow(null).empty('')
            .default(null),
        frequencyCap: Joi.object({
            impressions: Joi.number().integer().min(1).required(),
            period: Joi.string()
                .valid(...FREQUENCY_CAP_PERIODS)
                .required(),
        })
            .allow(null).empty('')
            .default(null),
    }).default(),

    plannerSettings: Joi.object({
        optimiseFor: Joi.string()
            .valid(...OPTIMISE_FOR)
            .default('balanced'),
        diversification: Joi.string()
            .valid(...DIVERSIFICATIONS)
            .default('balanced'),
        maxRecommendationsPerLine: Joi.number().integer().min(1).max(50).allow(null).default(null),
    }).default(),
});

// `input` is the full current form, re-validated like generate's (it may carry fresh manual
// edits). `prompt` is only sent when the prompt text itself was edited. The earlier prompt and
// plan are read from the saved plan at :planId, so neither is sent.
export const refinePlanSchema = Joi.object({
    input: generatePlanSchema.required(),
    prompt: Joi.string().trim().max(20000).allow(null).empty('').default(null),
});

// ============================================================================
// Content checks — what Joi's type checks can't catch. validatePrompt rejects obvious junk
// before it costs an LLM call (whether real-looking text is a media brief at all is judged by
// the suggest/refine calls themselves). findInvalidValues catches values that are well-typed
// but can't be right — invalid or past dates, an end before the start, a KPI target over
// 100%, a state that isn't Indian, an IAB category not in the data. Suggest/refine remove
// them and return warnings (the planner vets that form anyway); generate rejects them.
// ============================================================================

const MIN_PROMPT_LETTERS = 6;
const MIN_DISTINCT_LETTERS = 4;
/** Below this share of letters/digits/whitespace the prompt is mostly symbols. */
const MIN_TEXT_SHARE = 0.5;

const MIN_BUDGET = 10_000; // ₹10 thousand
const MAX_BUDGET = 10_000_000_000; // ₹1,000 Crore
const MAX_FLIGHT_DAYS = 366;
const MAX_CPM = 10_000;
const MAX_FREQUENCY_CAP = 1_000;

/** India's 28 states and 8 union territories, plus common alternate spellings mapped to the canonical name. */
const INDIAN_STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
    'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
    'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
    'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
    'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];
const STATE_ALIASES: Record<string, string> = {
    orissa: 'Odisha',
    uttaranchal: 'Uttarakhand',
    pondicherry: 'Puducherry',
    'new delhi': 'Delhi',
    'delhi ncr': 'Delhi',
    ncr: 'Delhi',
    'nct of delhi': 'Delhi',
    'j&k': 'Jammu and Kashmir',
    'jammu & kashmir': 'Jammu and Kashmir',
    'andaman & nicobar islands': 'Andaman and Nicobar Islands',
    up: 'Uttar Pradesh',
    mp: 'Madhya Pradesh',
    ap: 'Andhra Pradesh',
    hp: 'Himachal Pradesh',
    tn: 'Tamil Nadu',
    wb: 'West Bengal',
};
const STATE_LOOKUP = new Map<string, string>([
    ...INDIAN_STATES.map(s => [s.toLowerCase(), s] as [string, string]),
    ...Object.entries(STATE_ALIASES),
]);

/** The canonical state/UT name, or null if `name` isn't one. */
export const canonicalState = (name: string): string | null =>
    STATE_LOOKUP.get(name.trim().toLowerCase().replace(/\s+/g, ' ')) ?? null;

export const validatePrompt = (prompt: string): void => {
    // Runs of one repeated character ("aaaaaaa", "!!!!!!") count once.
    const collapsed = prompt.trim().replace(/(.)\1{3,}/gu, '$1');
    const letters = collapsed.match(/\p{L}/gu) ?? [];
    const textChars = collapsed.match(/[\p{L}\p{N}\s]/gu) ?? [];
    const distinctLetters = new Set(letters.map(l => l.toLowerCase())).size;

    if (letters.length < MIN_PROMPT_LETTERS || distinctLetters < MIN_DISTINCT_LETTERS) {
        throw new ApiError(422, 'The brief is too short to plan from — describe the brand, goal, budget or channels.');
    }
    if (textChars.length / collapsed.length < MIN_TEXT_SHARE) {
        throw new ApiError(422, "The brief is mostly symbols, not words — it doesn't read as a media brief.");
    }
};

export interface InvalidValue {
    field: string;
    message: string;
    /** Removes the invalid value from the input. */
    fix: () => void;
}

/** Real calendar date in YYYY-MM-DD form (rejects "2026-02-31", which Date would roll over). */
const isRealIsoDate = (s: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const findInvalidValues = (input: PlannerInput, iabCategories: string[]): InvalidValue[] => {
    const issues: InvalidValue[] = [];
    const { campaign, audience, inventory, buying } = input;
    const today = new Date().toISOString().slice(0, 10);

    for (const key of ['startDate', 'endDate'] as const) {
        const value = campaign[key];
        if (value === null) continue;
        if (!isRealIsoDate(value)) {
            issues.push({ field: `campaign.${key}`, message: `"${value}" isn't a real date.`, fix: () => (campaign[key] = null) });
        } else if (value < today) {
            issues.push({ field: `campaign.${key}`, message: `${value} is in the past.`, fix: () => (campaign[key] = null) });
        }
    }
    const { startDate, endDate } = campaign;
    if (startDate && endDate && isRealIsoDate(startDate) && isRealIsoDate(endDate)) {
        const days = (new Date(endDate).getTime() - new Date(startDate).getTime()) / DAY_MS + 1;
        if (days < 1) {
            issues.push({ field: 'campaign.endDate', message: `End date ${endDate} is before the start date ${startDate}.`, fix: () => (campaign.endDate = null) });
        } else if (days > MAX_FLIGHT_DAYS) {
            issues.push({ field: 'campaign.endDate', message: `A ${Math.round(days)}-day flight is longer than a year.`, fix: () => (campaign.endDate = null) });
        }
    }

    if (campaign.budget !== null && (campaign.budget < MIN_BUDGET || campaign.budget > MAX_BUDGET)) {
        const budget = campaign.budget;
        issues.push({
            field: 'campaign.budget',
            message: `A budget of ₹${budget.toLocaleString('en-IN')} is outside the ₹${MIN_BUDGET.toLocaleString('en-IN')} to ₹${MAX_BUDGET.toLocaleString('en-IN')} range.`,
            fix: () => (campaign.budget = null),
        });
    }

    campaign.kpis.forEach(kpi => {
        if (kpi.target !== null && (kpi.target <= 0 || kpi.target > 100)) {
            const target = kpi.target;
            issues.push({ field: 'campaign.kpis', message: `A ${kpi.metric.toUpperCase()} target of ${target}% isn't possible.`, fix: () => (kpi.target = null) });
        }
    });

    for (const key of ['states', 'excludeStates'] as const) {
        const unknown = audience[key].filter(s => canonicalState(s) === null);
        if (unknown.length > 0) {
            issues.push({
                field: `audience.${key}`,
                message: `${unknown.map(s => `"${s}"`).join(', ')} ${unknown.length === 1 ? "isn't an Indian state or union territory" : "aren't Indian states or union territories"}.`,
                fix: () => (audience[key] = audience[key].filter(s => canonicalState(s) !== null)),
            });
        }
    }
    const included = new Set(audience.states.map(canonicalState).filter(Boolean));
    const both = audience.excludeStates.filter(s => included.has(canonicalState(s)));
    if (both.length > 0) {
        issues.push({
            field: 'audience.excludeStates',
            message: `${both.join(', ')} can't be both targeted and excluded.`,
            fix: () => (audience.excludeStates = audience.excludeStates.filter(s => !included.has(canonicalState(s)))),
        });
    }

    const realCategories = new Set(iabCategories);
    const unknownCategories = inventory.iabCategories.filter(c => !realCategories.has(c));
    if (unknownCategories.length > 0) {
        issues.push({
            field: 'inventory.iabCategories',
            message: `${unknownCategories.map(c => `"${c}"`).join(', ')} ${unknownCategories.length === 1 ? "isn't a category" : "aren't categories"} in the inventory data.`,
            fix: () => (inventory.iabCategories = inventory.iabCategories.filter(c => realCategories.has(c))),
        });
    }

    for (const key of ['minViewabilityPct', 'minVcrPct'] as const) {
        const value = inventory[key];
        if (value !== null && (value < 0 || value > 100)) {
            issues.push({ field: `inventory.${key}`, message: `${value}% isn't a valid percentage.`, fix: () => (inventory[key] = null) });
        }
    }
    if (inventory.maxCpm !== null && (inventory.maxCpm <= 0 || inventory.maxCpm > MAX_CPM)) {
        const maxCpm = inventory.maxCpm;
        issues.push({ field: 'inventory.maxCpm', message: `A CPM cap of ₹${maxCpm} isn't realistic.`, fix: () => (inventory.maxCpm = null) });
    }
    const badTargets = inventory.channelCpmTargets.filter(t => t.maxCpm <= 0 || t.maxCpm > MAX_CPM);
    if (badTargets.length > 0) {
        issues.push({
            field: 'inventory.channelCpmTargets',
            message: `${badTargets.map(t => `₹${t.maxCpm} for ${t.platform}`).join(', ')} isn't a realistic CPM.`,
            fix: () => (inventory.channelCpmTargets = inventory.channelCpmTargets.filter(t => !badTargets.includes(t))),
        });
    }

    const cap = buying.frequencyCap;
    if (cap && (!Number.isInteger(cap.impressions) || cap.impressions < 1 || cap.impressions > MAX_FREQUENCY_CAP)) {
        issues.push({ field: 'buying.frequencyCap', message: `A frequency cap of ${cap.impressions} per ${cap.period} isn't realistic.`, fix: () => (buying.frequencyCap = null) });
    }

    return issues;
};

/** Removes every invalid value from `input` (in place) and returns what was dropped, as warnings for the planner. */
export const removeInvalidValues = (
    input: PlannerInput,
    iabCategories: string[]
): { field: string; message: string }[] =>
    findInvalidValues(input, iabCategories).map(({ field, message, fix }) => {
        fix();
        return { field, message };
    });
