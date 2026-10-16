import { z } from 'zod';
import { generateStructured } from '../services/bedrock.service';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';
import { removeInvalidValues } from '../validations/planner.validations';
import {
    AGE_GROUPS,
    INCOME_GROUPS,
    CurveCommentary,
    DEAL_TYPES,
    DIVERSIFICATIONS,
    DSP_CHOICES,
    FREQUENCY_CAP_PERIODS,
    GENDERS,
    GEO_SCOPES,
    GeneratedPlan,
    BestDates,
    GeneratedPlanCore,
    KPI_METRICS,
    MEDIA_TYPES,
    OBJECTIVES,
    OPTIMISE_FOR,
    PACINGS,
    PLATFORMS,
    PlanNarration,
    PlannerInput,
    QUALITY_TIERS,
    SKIPPABILITY,
    SPENDOPTIX_DSP_ROUTES,
    TARGET_GROUP_TYPES,
    VIDEO_DURATIONS,
    VIDEO_PLACEMENTS,
} from '../types/planner.types';
import { BestDatesResult, BudgetCurveResult, CpmCurveResult } from '../services/curves.service';

/** Parses a "key::value" entry; a malformed one (no "::") is dropped rather than guessed at. */
const parseKeyValue = (entry: string): { key: string; value: string } | null => {
    const separator = entry.indexOf('::');
    if (separator === -1) return null;
    return { key: entry.slice(0, separator), value: entry.slice(separator + 2) };
};

// ============================================================================
// Call 1 — "suggest": free-text prompt -> pre-filled, provenance-tagged form.
// ============================================================================

export type Provenance = 'stated' | 'inferred' | 'assumed';

/** Last-resort fallback when the model fails to follow the "budget can never be left out" rule (verified live: happens occasionally on long, data-dense briefs). Not a sophisticated estimate — just a round, clearly-arbitrary placeholder the planner is expected to review and correct, same as any other "assumed" field. */
const DEFAULT_ASSUMED_BUDGET = 1000000;

/** A blank form — every field null/empty/the product-level default, nothing suggested yet. generateSuggestions below fills fields in on top of this one at a time, so any field the model didn't address at all is left in this safe, honest "unset" state rather than missing from the object. */
export const buildEmptyPlannerInput = (): PlannerInput => ({
    rawPrompt: null,
    brand: { name: null, category: null },
    campaign: {
        objective: null,
        kpis: [],
        budget: null,
        startDate: null,
        endDate: null,
        campaignMonth: null,
        seasonality: null,
        pacing: null,
        regionalTargets: [],
    },
    audience: {
        country: null,
        geoScope: null,
        states: [],
        excludeStates: [],
        gender: null,
        ageGroups: [],
        incomeGroups: [],
    },
    inventory: {
        platforms: [],
        mediaTypes: [],
        iabCategories: [],
        qualityTier: null,
        preferredSitesApps: [],
        blockedSitesApps: [],
        minViewabilityPct: null,
        minVcrPct: null,
        maxCpm: null,
        minAvails: null,
        minUniqueAudience: null,
        channelCpmTargets: [],
    },
    creative: {
        displayFormats: [],
        displaySizes: [],
        videoPlacements: [],
        videoDurations: [],
        skippability: [],
    },
    buying: {
        dspChoice: null,
        spendoptixDspRoute: null,
        ownDspNames: [],
        seatId: null,
        dealType: null,
        frequencyCap: null,
    },
    plannerSettings: {
        optimiseFor: 'balanced',
        diversification: 'balanced',
        maxRecommendationsPerLine: 8,
    },
});

/** Every leaf field the suggest call can fill, with how to validate a parsed value for it — mirrors the isValidAssumedValue pattern this codebase used before: reject an out-of-set value rather than write something the rest of the app never expects. "free" fields (brand name, notes, ids, ...) have no fixed vocabulary to check against. */
const FIELD_VALIDATORS: Record<string, (value: unknown) => boolean> = {
    'brand.name': v => typeof v === 'string',
    'brand.category': v => typeof v === 'string',
    'campaign.objective': v => (OBJECTIVES as readonly string[]).includes(v as string),
    'campaign.kpis': v =>
        Array.isArray(v) &&
        v.every(
            k =>
                typeof k === 'object' &&
                k !== null &&
                (KPI_METRICS as readonly string[]).includes((k as { metric: string }).metric)
        ),
    'campaign.budget': v => typeof v === 'number' && v > 0,
    'campaign.startDate': v => typeof v === 'string',
    'campaign.endDate': v => typeof v === 'string',
    'campaign.campaignMonth': v => typeof v === 'string',
    'campaign.seasonality': v => typeof v === 'string',
    'campaign.pacing': v => (PACINGS as readonly string[]).includes(v as string),
    'campaign.regionalTargets': v =>
        Array.isArray(v) &&
        v.every(
            t =>
                typeof t === 'object' &&
                t !== null &&
                typeof (t as { region: string }).region === 'string' &&
                typeof (t as { impressions: unknown }).impressions === 'number' &&
                (t as { impressions: number }).impressions >= 0
        ),
    'audience.country': v => typeof v === 'string',
    'audience.geoScope': v => (GEO_SCOPES as readonly string[]).includes(v as string),
    'audience.states': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.excludeStates': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.gender': v => (GENDERS as readonly string[]).includes(v as string),
    'audience.ageGroups': v => Array.isArray(v) && v.every(x => (AGE_GROUPS as readonly string[]).includes(x)),
    'audience.incomeGroups': v => Array.isArray(v) && v.every(x => (INCOME_GROUPS as readonly string[]).includes(x)),
    'inventory.platforms': v => Array.isArray(v) && v.every(x => (PLATFORMS as readonly string[]).includes(x)),
    'inventory.mediaTypes': v => Array.isArray(v) && v.every(x => (MEDIA_TYPES as readonly string[]).includes(x)),
    'inventory.iabCategories': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.qualityTier': v => (QUALITY_TIERS as readonly string[]).includes(v as string),
    'inventory.preferredSitesApps': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.blockedSitesApps': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.minViewabilityPct': v => typeof v === 'number',
    'inventory.minVcrPct': v => typeof v === 'number',
    'inventory.maxCpm': v => typeof v === 'number' && v >= 0,
    'inventory.minAvails': v => typeof v === 'number' && v >= 0,
    'inventory.minUniqueAudience': v => typeof v === 'number' && v >= 0,
    'inventory.channelCpmTargets': v =>
        Array.isArray(v) &&
        v.every(
            t =>
                typeof t === 'object' &&
                t !== null &&
                (PLATFORMS as readonly string[]).includes((t as { platform: string }).platform) &&
                typeof (t as { maxCpm: unknown }).maxCpm === 'number' &&
                (t as { maxCpm: number }).maxCpm >= 0
        ),
    'creative.displayFormats': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'creative.displaySizes': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'creative.videoPlacements': v =>
        Array.isArray(v) && v.every(x => (VIDEO_PLACEMENTS as readonly string[]).includes(x)),
    'creative.videoDurations': v =>
        Array.isArray(v) && v.every(x => (VIDEO_DURATIONS as readonly string[]).includes(x)),
    'creative.skippability': v => Array.isArray(v) && v.every(x => (SKIPPABILITY as readonly string[]).includes(x)),
    'buying.dspChoice': v => (DSP_CHOICES as readonly string[]).includes(v as string),
    'buying.spendoptixDspRoute': v => (SPENDOPTIX_DSP_ROUTES as readonly string[]).includes(v as string),
    'buying.ownDspNames': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'buying.seatId': v => typeof v === 'string',
    'buying.dealType': v => (DEAL_TYPES as readonly string[]).includes(v as string),
    'buying.frequencyCap': v =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as { impressions: unknown }).impressions === 'number' &&
        (FREQUENCY_CAP_PERIODS as readonly string[]).includes((v as { period: string }).period),
    'plannerSettings.optimiseFor': v => (OPTIMISE_FOR as readonly string[]).includes(v as string),
    'plannerSettings.diversification': v => (DIVERSIFICATIONS as readonly string[]).includes(v as string),
    'plannerSettings.maxRecommendationsPerLine': v => typeof v === 'number' && v >= 1,
};

const buildSuggestSchema = () =>
    z.object({
        // "section.field::jsonValue::provenance" — flat strings, not nested objects, for the
        // same reason assumedDefaults/itemReasons below are flat: this form has ~55 leaf
        // fields, and an object-shaped array item per field is the single biggest known
        // contributor to Bedrock's grammar-size ceiling. One flat array easily fits where a
        // parallel structure describing the same ~55 fields as nested objects risked not
        // fitting at all.
        suggestions: z.array(z.string()),
        // Whether the text is a media brief at all — judged here rather than in a separate
        // call, since this call already has to read it. False means nothing else in the
        // response is used.
        isMediaBrief: z.boolean(),
        notABriefReason: z.string().nullable(),
    });

const FIELD_REFERENCE = `brand.name (text — ONLY if literally stated, never inferred/assumed), brand.category (text — your own inference from the brand, not a fixed list; leave out if the brand gives no real signal)
campaign.objective (one of: ${OBJECTIVES.join(', ')}), campaign.kpis (list of {"metric":"vcr"|"ctr","target":number|null} — ONLY these 2 metrics, nothing else), campaign.budget (number, INR, no shorthand — "50 Lakh" -> 5000000, "1 Crore" -> 10000000 — NEVER leave this out, always give a real number even if assumed), campaign.startDate/campaign.endDate (YYYY-MM-DD), campaign.campaignMonth (YYYY-MM, only if exact dates aren't known), campaign.seasonality (text), campaign.pacing (one of: ${PACINGS.join(', ')}), campaign.regionalTargets (list of {"region":text,"impressions":number} — see the table-parsing rule below)
audience.country (text — the real-world country this ask is for, e.g. "India", "USA" — NEVER leave this out; default "India" unless the brief clearly names somewhere else), audience.geoScope (one of: ${GEO_SCOPES.join(', ')}), audience.states (text list, only used when geoScope is "states"), audience.excludeStates (text list — ONLY if literally stated, never inferred/assumed), audience.gender (one of: ${GENDERS.join(', ')} — NEVER leave this out), audience.ageGroups (list from: ${AGE_GROUPS.join(', ')} — NEVER leave this out), audience.incomeGroups (list from: ${INCOME_GROUPS.join(', ')} — monthly household income: premium ₹1,00,000+, upper-middle ₹60,000-99,999, middle ₹30,000-59,999, lower-middle ₹15,000-29,999, value under ₹15,000; see the conditional rule below)
inventory.platforms (list from: ${PLATFORMS.join(', ')} — "ctv-oem"/"ctv-fast" both mean ad-supported FAST channels like Samsung TV Plus/TCL Channel; "ctv-ott" means on-demand CTV apps like JioHotstar/ZEE5/MX Player; plain "ctv" means both), inventory.mediaTypes (list from: ${MEDIA_TYPES.join(', ')}), inventory.iabCategories (text list, only real categories, see rule below), inventory.qualityTier (one of: ${QUALITY_TIERS.join(', ')}), inventory.preferredSitesApps/blockedSitesApps (text lists — ONLY if literally stated, never inferred/assumed), inventory.minViewabilityPct/minVcrPct (0-100), inventory.maxCpm (INR, a single overall cap — only use this when one CPM applies to everything), inventory.minAvails/minUniqueAudience (numbers), inventory.channelCpmTargets (list of {"platform":one of the platform values above,"maxCpm":number} — use this instead of maxCpm whenever different platforms are asked about at different rates, e.g. "₹130 for OTT-CTV, ₹100 for FAST")
creative.displayFormats/displaySizes (text lists), creative.videoPlacements (list from: ${VIDEO_PLACEMENTS.join(', ')}), creative.videoDurations (list from: ${VIDEO_DURATIONS.join(', ')}), creative.skippability (list from: ${SKIPPABILITY.join(', ')})
buying.dspChoice (one of: ${DSP_CHOICES.join(', ')} — ONLY if literally stated, never inferred/assumed), buying.spendoptixDspRoute (one of: ${SPENDOPTIX_DSP_ROUTES.join(', ')}, only if dspChoice is spendoptix-dsp), buying.ownDspNames (text list, only if dspChoice is own-dsp), buying.seatId (text), buying.dealType (one of: ${DEAL_TYPES.join(', ')}), buying.frequencyCap ({"impressions":number,"period":"${FREQUENCY_CAP_PERIODS.join('"|"')}"})
plannerSettings.optimiseFor (one of: ${OPTIMISE_FOR.join(', ')}, default balanced), plannerSettings.diversification (one of: ${DIVERSIFICATIONS.join(', ')}, default balanced), plannerSettings.maxRecommendationsPerLine (number, default 8)`;

const buildSuggestSystemPrompt = (iabCategories: string[]): string =>
    `First decide "isMediaBrief": true when the text is in any way a request to plan, price, or check advertising (a campaign, a brand, a budget, channels/platforms, an audience, or asking whether specific inventory/publishers are available) — be generous, a two-line casual ask or a bare "CTV campaign for 10 lakh" counts. false only when it clearly isn't one: keyboard mash or unintelligible text, or an unrelated request (a poem, code, general questions, chit-chat). When false, set "notABriefReason" to one short sentence for the planner saying why (e.g. "This reads as a general knowledge question, not an advertising brief.") and leave "suggestions" empty; when true, set it to null.

You turn a free-text media-planning brief into pre-filled form fields for a programmatic media-planning console. The brief can be messy, casual, or missing most details — your job is to fill in every field below anyway, never leaving the form blank, so the planner reviews a complete draft instead of an empty one.

For EVERY field, decide one of three provenance tags:
- "stated" — the brief literally says this (a number, a name, an explicit instruction).
- "inferred" — not stated, but you can reasonably work it out from context (e.g. a brand's product category from its name, a sensible objective from the tone of the ask).
- "assumed" — nothing in the brief gives any signal at all; you picked a plausible default.

Never skip a field because nothing was said — tag it "assumed" and give your best reasonable default instead. Three fields are conditional exceptions: "audience.incomeGroups" (only when the brief signals income or affluence, e.g. "affluent", "HNI", "SEC A", "budget-conscious" — leave it out otherwise, since an assumed income band raises the plan's price), "inventory.iabCategories" (only suggest one of these real categories: ${iabCategories.join(', ')} — leave it unsuggested if genuinely nothing fits, since inventing one that doesn't exist in the real data defeats its purpose) and "brand.category" (leave it out if the brand name gives no real signal at all — an unfamiliar or ambiguous name shouldn't get a guessed category).

A separate set of fields works the other way around — they may ONLY ever be tagged "stated", never "inferred" or "assumed": brand.name, buying.dspChoice (and its dependents spendoptixDspRoute/ownDspNames), audience.excludeStates, inventory.preferredSitesApps, inventory.blockedSitesApps. If the brief doesn't literally name one of these, leave the field out entirely — a guessed brand name, DSP preference, excluded state, or preferred/blocked property is worse than an honestly blank field here. These five fields (plus the three conditional ones above) are the ONLY fields ever allowed to be left out — every other field below, including ones with no obvious signal (e.g. campaign.startDate, campaign.pacing, audience.geoScope), must still get a real "assumed" value per the main rule; never apply this "leave it out" treatment to a field that isn't explicitly named in this paragraph or the one above it.

"brand.name" specifically means the ADVERTISER running this campaign — never a publisher, app, channel, or property the brief is asking *about*. A brief that asks "do you have inventory on X and Y" or "what are your rates for X" is asking about X and Y as properties, not naming an advertiser at all — in that case leave brand.name out entirely and put X and Y into inventory.preferredSitesApps instead (tagged "stated"), since that's what the brief is actually naming. Only use brand.name when the brief identifies whose campaign this is, distinct from any property/publisher it also mentions.

A brief may list several platforms/devices tied to different named properties in one go (e.g. "Mobile for X, CTV for Y", or a bulleted device list) — capture every platform actually named into inventory.platforms, not just the first one, and tag each "stated" (not "inferred") since the brief named it directly.

Three fields are the opposite again — they can never be left out no matter how thin the brief is: audience.gender, audience.ageGroups, and audience.country must always get a real value, "assumed" if nothing else justifies it (audience.country specifically assumes "India" with no other signal — this platform's real inventory is India-only, so that's the honest default, never a blank). "campaign.budget" also can never be left out (unlike the general escape hatch below) — always give a real positive number greater than zero, "assumed" if the brief implies nothing, since the planner needs a starting figure to react to and adjust rather than a blank field. These four fields are worth extra attention on a long or data-dense brief (e.g. one with a big region/impressions table) — it's easy to spend all your attention extracting the table and forget these still need a value; double-check all four are present before finishing.

If a brief clearly describes a location outside India (a US state, a foreign city, a non-Indian country), state that real country in audience.country as "stated" or "inferred" rather than defaulting to "India" — this platform's real inventory only covers India, so correctly naming a different country lets the system tell the planner honestly that it can't help with this request, instead of silently recommending Indian inventory for somewhere else entirely.

Whenever a field is genuinely, explicitly stated in the brief, that stated value always wins — these special cases above only govern what happens when nothing was said.

Today's date is ${new Date().toISOString().slice(0, 10)}. The brief may give a date or date range with no year (e.g. "Oct 10 to Nov 5") — resolve it to this year if that date hasn't passed yet, or next year if it has; never resolve a bare date to a year that's already in the past relative to today.

Any number with commas may use Indian lakh/crore grouping (2-digit groups after the first 3, not 3-digit Western groups) — e.g. "8,14,32,000" is NOT eight-hundred-fourteen-million. To remove any doubt, every comma-grouped number in the brief below has already been annotated with its exact digit value in brackets right after it, e.g. "8,14,32,000 [=81432000]" — always use that bracketed value as-is; never recompute it yourself, and never apply a lakh/crore multiplication on top of it.

A brief may include a table of impression/avail targets broken down by region and platform (region names as rows, platform names as columns). Extract every row into "campaign.regionalTargets" as one entry per region — if a region has separate numbers per platform (e.g. separate OTT-CTV and FAST-CTV columns), sum them into that region's single total (using the comma-stripping method above for each number before summing), since this field tracks total delivery per region, not per platform-per-region. Never drop a stated row — an incomplete capture of real numbers defeats the point of this field far more than an approximate one does.

Fields and their types/allowed values:
${FIELD_REFERENCE}

Output each field as one "field::jsonValue::provenance" string in "suggestions" — field is the exact dot path above (e.g. "campaign.budget"), jsonValue is that value JSON-encoded exactly matching its type (a bare number, a quoted string, an array, or an object), provenance is exactly "stated", "inferred", or "assumed". Money is always INR. Besides the specific fields already named above as allowed to be left out (and buying.spendoptixDspRoute/ownDspNames/seatId/frequencyCap, which only ever apply once a DSP preference is actually stated), every field must be output with a real value — never leave a field out just because it felt uncertain, and never output an empty string ("") in place of a real value or a leave-out.`;

/** Parses "field::jsonValue::provenance" — provenance is a short fixed suffix, so splitting from the end avoids ambiguity with "::" that might appear inside a JSON array/object value. */
const parseSuggestion = (
    entry: string
): { field: string; value: unknown; provenance: Provenance } | null => {
    const lastSeparator = entry.lastIndexOf('::');
    if (lastSeparator === -1) return null;
    const provenance = entry.slice(lastSeparator + 2);
    if (provenance !== 'stated' && provenance !== 'inferred' && provenance !== 'assumed') return null;

    const rest = entry.slice(0, lastSeparator);
    const fieldSeparator = rest.indexOf('::');
    if (fieldSeparator === -1) return null;
    const field = rest.slice(0, fieldSeparator);
    try {
        return { field, value: JSON.parse(rest.slice(fieldSeparator + 2)), provenance };
    } catch {
        return null;
    }
};

/** Writes `value` into `input` at `field` (e.g. "campaign.budget") — only known section.key paths are writable, matching buildEmptyPlannerInput's shape exactly. */
const applySuggestion = (input: PlannerInput, field: string, value: unknown): boolean => {
    const [section, key] = field.split('.');
    const validSections = ['brand', 'campaign', 'audience', 'inventory', 'creative', 'buying', 'plannerSettings'];
    if (!validSections.includes(section)) return false;
    const obj = (input as unknown as Record<string, Record<string, unknown>>)[section];
    if (!(key in obj)) return false;
    obj[key] = value;
    return true;
};

export interface SuggestResult {
    input: PlannerInput;
    provenance: Record<string, Provenance>;
    /** Values the model extracted that can't be right (past dates, a VCR over 100%, a made-up state, ...) — dropped from input, listed here for the planner. See planner.validations.ts. */
    warnings: { field: string; message: string }[];
}

/**
 * Bedrock models consistently misread Indian lakh/crore comma-grouped numbers (observed ~10x
 * inflation) even when told to "strip commas and read digits" — they do their own semantic
 * grouping math anyway. Since stripping commas is a deterministic, mechanical operation, do it
 * in code and hand the model the literal value alongside the original so it never has to.
 */
const annotateCommaGroupedNumbers = (text: string): string =>
    text.replace(/\b\d{1,3}(?:,\d{1,3})+\b/g, match => `${match} [=${match.replace(/,/g, '')}]`);

/**
 * Call 1 ("suggest") — the brief is free text and can be messy/incomplete, so every field gets
 * filled one way or another (stated/inferred/assumed) rather than left blank for the user to
 * notice and fill in themselves. Call 2 ("generate") then runs on whatever the user vets this
 * into, with no further involvement from the raw prompt.
 */
export const generateSuggestions = async (
    prompt: string,
    iabCategories: string[]
): Promise<SuggestResult> => {
    const result = await generateStructured<ReturnType<typeof buildSuggestSchema>>({
        system: buildSuggestSystemPrompt(iabCategories),
        prompt: `Brief:\n"""\n${annotateCommaGroupedNumbers(prompt)}\n"""`,
        schema: buildSuggestSchema(),
        maxTokens: 4096,
    });
    if (!result.isMediaBrief) {
        throw new ApiError(422, result.notABriefReason || "This doesn't read as an advertising brief.");
    }

    const input = buildEmptyPlannerInput();
    // The original brief, carried through verbatim — not something the model decides, so it's
    // set directly here rather than going through a "field::value::provenance" suggestion.
    input.rawPrompt = prompt;
    const provenance: Record<string, Provenance> = {};

    for (const entry of result.suggestions) {
        const parsed = parseSuggestion(entry);
        if (!parsed) continue;
        const validator = FIELD_VALIDATORS[parsed.field];
        if (!validator || !validator(parsed.value)) continue;
        if (applySuggestion(input, parsed.field, parsed.value)) {
            provenance[parsed.field] = parsed.provenance;
        }
    }

    // Before the fallbacks below, so a dropped bogus budget still gets the assumed default.
    const warnings = removeInvalidValues(input, iabCategories);
    for (const { field } of warnings) {
        if (isUnset(input, field)) delete provenance[field];
    }

    // Safety net for the one field this contract can least afford to go missing: the prompt
    // tells the model budget can never be left out, but verified live that on a long/data-dense
    // brief (e.g. a big region/impressions table) it occasionally still does. A code-level
    // fallback guarantees the output contract holds even when the model's own compliance
    // doesn't — tagged "assumed" like any other default, since that's exactly what it is.
    if (input.campaign.budget === null) {
        input.campaign.budget = DEFAULT_ASSUMED_BUDGET;
        provenance['campaign.budget'] = 'assumed';
    }
    if (input.audience.country === null) {
        input.audience.country = 'India';
        provenance['audience.country'] = 'assumed';
    }

    return { input, provenance, warnings };
};

/** True when a dropped field ended up back at its blank-form value, so its provenance tag no longer describes anything. */
const isUnset = (input: PlannerInput, field: string): boolean => {
    const [section, key] = field.split('.');
    const get = (o: unknown) => (o as Record<string, Record<string, unknown>>)[section]?.[key];
    return JSON.stringify(get(input)) === JSON.stringify(get(buildEmptyPlannerInput()));
};

// ============================================================================
// Refine — an edited prompt applied on top of an already-vetted form.
// ============================================================================

/**
 * Typed value slots instead of suggest's "field::jsonValue" string — verified live that this
 * call, unlike suggest, reliably broke on JSON nested inside a JSON string (a list value needs
 * escaped quotes): it wrote "field:[...]" with one colon, or stalled mid-string until it hit
 * max tokens. One small object shape with 5 keys is nowhere near the grammar-size ceiling
 * buildSuggestSchema's comment is about. Object-shaped fields go in `list` as "a::b" strings,
 * same idea as the narration call's flat arrays — see REFINE_OBJECT_PARSERS.
 */
const buildRefineSchema = () =>
    z.object({
        // Same idea as the suggest call's isMediaBrief, for the edit itself.
        isPlanEdit: z.boolean(),
        notAnEditReason: z.string().nullable(),
        changes: z.array(
            z.object({
                field: z.string(),
                text: z.string().nullable(),
                number: z.number().nullable(),
                list: z.array(z.string()).nullable(),
                clear: z.boolean(),
            })
        ),
    });

/** null for anything that isn't a real finite number — Number("abc") is NaN, which would pass a plain typeof check. */
const toNumberOrNull = (s: string | undefined): number | null => {
    const n = s === undefined || s.trim() === '' ? NaN : Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

/** How the object-shaped fields come back in the `list` slot (frequencyCap in `text`), turned back into the shapes FIELD_VALIDATORS expects. */
const REFINE_OBJECT_PARSERS: Record<string, (list: string[] | null, text: string | null) => unknown> = {
    'campaign.kpis': list =>
        list?.map(entry => {
            const [metric, target] = entry.split('::');
            return { metric, target: toNumberOrNull(target) };
        }),
    'campaign.regionalTargets': list =>
        list?.map(entry => {
            const [region, impressions] = entry.split('::');
            return { region, impressions: Number(impressions) };
        }),
    'inventory.channelCpmTargets': list =>
        list?.map(entry => {
            const [platform, maxCpm] = entry.split('::');
            return { platform, maxCpm: Number(maxCpm) };
        }),
    'buying.frequencyCap': (_list, text) => {
        if (!text) return undefined;
        const [impressions, period] = text.split('::');
        return { impressions: toNumberOrNull(impressions), period };
    },
};

const buildRefineSystemPrompt = (iabCategories: string[]): string =>
    `First decide "isPlanEdit": true when the edit is in any way about this campaign or plan (its budget, dates, audience, channels, inventory, KPIs, rates, or a rewritten brief) — be generous with short or casual instructions. false only when the edit clearly isn't: keyboard mash or unintelligible text, or an unrelated request (a poem, code, general questions, chit-chat). When false, set "notAnEditReason" to one short sentence for the planner saying why and leave "changes" empty; when true, set it to null.

You update an already-filled media-planning form after the planner edits their brief. The form you're given is the planner's current, vetted version — it may already contain manual edits they made by hand, and those must be kept. A plan has already been generated from it; you're shown a summary of that plan for context.

Your only job: compare the earlier brief with the new brief, work out what the planner changed or added, and output ONLY the form fields that difference requires changing. Never re-derive, "tidy up", or re-guess a field the new wording doesn't touch — if a field isn't affected by what changed between the two briefs, leave it out entirely, even if you'd have filled it differently from scratch. Outputting zero changes is a valid answer when the edit doesn't affect any field.

Where the current form disagrees with the earlier brief (e.g. the brief says "25-34" but the form has two age groups), the planner edited that field by hand on purpose — never change it back to match the brief unless the NEW wording explicitly talks about that field. When the new wording changes one entry of a list (e.g. one KPI target), keep every other entry exactly as it is in the current form.

The new brief may be a full rewritten brief or just a short instruction about the existing plan (e.g. "drop YouTube", "push more budget to CTV", "remove JioHotstar", "make it 50 Lakh") — handle both. Map instructions about the existing plan onto form fields, since the plan itself is always regenerated from the form: removing a property -> inventory.blockedSitesApps (keep its existing entries and add to them), favouring a property -> inventory.preferredSitesApps, dropping/adding a channel -> inventory.platforms (always remove a dropped channel from inventory.platforms when it's listed there, even if the previous plan shows no budget line for it — the plan summary only lists channels that got budget, not everything the form asks for), wanting cheaper/more reach/better quality -> plannerSettings.optimiseFor or inventory.qualityTier, fewer/more properties -> plannerSettings.diversification or maxRecommendationsPerLine.

For list fields, output the complete new list (existing entries that should stay, plus additions, minus removals) — never only the delta. To clear a field back to unset (e.g. "remove the CPM cap"), set "clear" to true.

"inventory.iabCategories" may only contain these real categories: ${iabCategories.join(', ')}. "brand.name" means the advertiser running this campaign, never a publisher or property being asked about.

Today's date is ${new Date().toISOString().slice(0, 10)}. Resolve a date with no year to this year if it hasn't passed yet, or next year if it has. Every comma-grouped number in the briefs has already been annotated with its exact digit value in brackets (e.g. "8,14,32,000 [=81432000]") — always use that bracketed value as-is. "50 Lakh" -> 5000000, "1 Crore" -> 10000000. Money is always INR.

Fields and their types/allowed values:
${FIELD_REFERENCE}

Output one object per changed field in "changes": "field" is the exact dot path above, and the new value goes in exactly one slot, leaving the other slots null and "clear" false:
- "number" for numeric fields (campaign.budget, inventory.maxCpm, inventory.minViewabilityPct, ...)
- "text" for single text/choice fields (campaign.objective, audience.gender, plannerSettings.optimiseFor, campaign.startDate, ...)
- "list" for list fields (inventory.platforms, inventory.blockedSitesApps, audience.ageGroups, ...)
Object-shaped fields are written as "a::b" strings instead: campaign.kpis -> list of "metric::target" (e.g. "vcr::65", "ctr::null"), campaign.regionalTargets -> list of "region::impressions", inventory.channelCpmTargets -> list of "platform::maxCpm", buying.frequencyCap -> text "impressions::period" (e.g. "5::week").
To clear a field, set "clear" true and leave every slot null.`;

/** A compact view of the plan being refined — only what helps the model map "drop X" / "more CTV" onto form fields. previousPlan is round-tripped from the client and not shape-checked, so every access is guarded. */
const summarisePreviousPlan = (plan: Partial<GeneratedPlan>): string => {
    const lines = Array.isArray(plan.budgetAllocation) ? plan.budgetAllocation : [];
    if (lines.length === 0) return '(no previous plan details given)';
    return lines
        .map(
            line =>
                `- ${line.inventoryLine}: ${line.sharePercent}% share, ₹${line.amount} — ` +
                (Array.isArray(line.recommendedInventory)
                    ? line.recommendedInventory.map(item => item.name).join(', ')
                    : '')
        )
        .join('\n');
};

export interface RefineFieldChange {
    field: string;
    from: unknown;
    to: unknown;
}

/**
 * Applies an edited brief to an already-vetted form. Unlike generateSuggestions this never
 * starts from a blank form — it starts from `input` (the planner's manual edits included) and
 * only overwrites what the brief edit itself changed, so a planner's hand edits survive any
 * number of refine rounds.
 */
export const generateRefinement = async (
    input: PlannerInput,
    previousPrompt: string | null,
    newPrompt: string,
    previousPlan: Partial<GeneratedPlan>,
    iabCategories: string[]
): Promise<{ input: PlannerInput; changes: RefineFieldChange[]; warnings: { field: string; message: string }[] }> => {
    const { rawPrompt: _rawPrompt, ...form } = input;
    // The common case is text appended to the earlier brief. Working out that difference is
    // mechanical, so do it here — verified live that when left to compare the two full briefs
    // itself, the model also "corrected" untouched fields (e.g. reverting a hand-edited age
    // group back to what the earlier brief said).
    const addedText =
        previousPrompt && newPrompt.startsWith(previousPrompt.trim())
            ? newPrompt.slice(previousPrompt.trim().length).trim()
            : null;
    const result = await generateStructured<ReturnType<typeof buildRefineSchema>>({
        system: buildRefineSystemPrompt(iabCategories),
        prompt: `${addedText ? `What the planner added to the brief (the ONLY text to act on — change only fields this text explicitly asks for):\n"""\n${annotateCommaGroupedNumbers(addedText)}\n"""\n\n` : ''}Earlier brief:
"""
${previousPrompt ? annotateCommaGroupedNumbers(previousPrompt) : '(none — the form was built by hand)'}
"""

New brief:
"""
${annotateCommaGroupedNumbers(newPrompt)}
"""

Current form (keep everything the brief edit doesn't touch):
${JSON.stringify(form)}

Plan previously generated from it:
${summarisePreviousPlan(previousPlan)}`,
        schema: buildRefineSchema(),
        maxTokens: 2048,
        temperature: 0.2,
    });
    if (!result.isPlanEdit) {
        throw new ApiError(422, result.notAnEditReason || "This edit doesn't read as a change to the plan.");
    }

    const refined: PlannerInput = JSON.parse(JSON.stringify(input));
    refined.rawPrompt = newPrompt;
    const empty = buildEmptyPlannerInput() as unknown as Record<string, Record<string, unknown>>;
    const changes: RefineFieldChange[] = [];

    for (const entry of result.changes) {
        const validator = FIELD_VALIDATORS[entry.field];
        if (!validator) {
            logger.warn('Refine change dropped: unknown field', { entry });
            continue;
        }
        const [section, key] = entry.field.split('.');

        let value: unknown;
        if (entry.clear) {
            // Cleared back to buildEmptyPlannerInput's own value, so a cleared field ends up in
            // exactly the same state as one suggest never filled.
            value = empty[section][key];
        } else {
            // The model doesn't always pick the right slot (e.g. a budget as text "3000000"),
            // so take the first candidate that actually validates for this field.
            const objectParser = REFINE_OBJECT_PARSERS[entry.field];
            const candidates = objectParser
                ? [objectParser(entry.list, entry.text)]
                : [entry.list, entry.number, entry.text, toNumberOrNull(entry.text ?? undefined)];
            value = candidates.find(c => c !== null && c !== undefined && validator(c));
            if (value === undefined) {
                logger.warn('Refine change dropped: invalid value', { entry });
                continue;
            }
        }

        const from = (refined as unknown as Record<string, Record<string, unknown>>)[section][key];
        if (JSON.stringify(from) === JSON.stringify(value)) continue;
        if (applySuggestion(refined, entry.field, value)) {
            changes.push({ field: entry.field, from, to: value });
        }
    }

    // A bogus value the edit introduced is dropped; its change is reported as what actually
    // landed, or not at all when nothing did.
    const warnings = removeInvalidValues(refined, iabCategories);
    const landed = changes
        .map(c => {
            const [section, key] = c.field.split('.');
            return { ...c, to: (refined as unknown as Record<string, Record<string, unknown>>)[section][key] };
        })
        .filter(c => JSON.stringify(c.from) !== JSON.stringify(c.to));

    return { input: refined, changes: landed, warnings };
};

// ============================================================================
// Call 2 — "generate": narration + curve commentary, wrapped around a plan
// planner.candidates.ts / allocation.service.ts / curves.service.ts
// already fully decided. See allocation.service.ts's top comment for why
// every number and selection is decided there, never by either call below.
// ============================================================================

/**
 * The first of Call 2's two LLM calls — everything it's given (the candidate selections, the
 * budget split, every number) was already decided deterministically. This call never chooses
 * anything; it only writes the text explaining choices already made, which is why it runs at a
 * low temperature (see bedrock.service.ts) — describing fixed facts doesn't benefit from the
 * creativity a higher temperature buys, and a narration call drifting at temperature 1.0 is
 * exactly the kind of variance this flow was redesigned to avoid.
 *
 * Schema is flat "a::b" strings, not nested objects, for the same reason as the suggest
 * schema above: object-shaped array items are the biggest known contributor to Bedrock's
 * grammar-size ceiling.
 */
const buildNarrationSchema = () =>
    z.object({
        title: z.string(),
        summary: z.string(),
        // "type::value" — type is one of TARGET_GROUP_TYPES, enforced by prompt + a post-parse filter.
        targetGroup: z.array(z.string()),
        // "line::reason" — line is one of the real inventory lines that got a budget share.
        lineReasons: z.array(z.string()),
        // "line|inventoryId::reason" — the same real inventory id can legitimately appear
        // under more than one line (e.g. JioHotstar is a real row in both the CTV and Mobile
        // OTT tables), so the id alone isn't a unique key — line is part of it too.
        itemReasons: z.array(z.string()),
        assumptions: z.array(z.string()),
        // "startDate::endDate::score::reason" — when the viewership calendar covers the flight,
        // the windows and scores come from curves.service.ts and only "reason" is used.
        // Otherwise "score" is the model's own judgment, not a system computation — a
        // deliberate, scoped exception (see this section's top comment).
        recommendedWindows: z.array(z.string()),
        // "startDate::endDate::reason" — same 3-field shape as recommendedWindows (minus the
        // score) rather than a single "dateRange" field, since a date range naturally wants
        // its own "start::end"-shaped separator and that collided with the "::reason"
        // separator when tried as one combined field.
        datesToAvoid: z.array(z.string()),
        givenVsBest: z.string().nullable(),
    });

/** Rule 6: with calendar data the windows are already decided and only need reasons; without it the model judges them itself. */
const bestDatesRule = (calendarDates: BestDatesResult | null): string =>
    calendarDates
        ? `"recommendedWindows": the flight windows you're given were already picked and scored from the viewership calendar. Output exactly one "startDate::endDate::score::reason" string per window given, copying startDate, endDate and score unchanged, and write only the reason: one sentence citing that window's events and its viewership multiplier (vs 1.00x for a typical weekday, weighted by this plan's channel mix), e.g. "Covers Dhanteras through Bhai Dooj, averaging 1.27x typical-weekday viewership for this channel mix." "datesToAvoid": one "startDate::endDate::reason" string per range given, dates unchanged, the reason saying why viewership is below typical there. "givenVsBest": null (already computed). The multipliers are planning assumptions, not measured traffic — never call them measured or guaranteed.`
        : `"recommendedWindows" is up to 3 flight-date windows as "startDate::endDate::score::reason" strings (dates as YYYY-MM-DD, every date must be on or after ${new Date().toISOString().slice(0, 10)} — never recommend a window that's already in the past) — your own judgment on good timing for this brand/category/objective (seasonality, festivals, typical category patterns), since there's no real historical booking data behind this yet. "score" is a 0-100 confidence number you assign, not a measured figure — be honest that it's a judgment call, not a guarantee. "datesToAvoid" is "startDate::endDate::reason" strings (same date rule) for windows to avoid (e.g. clashing with a major unrelated event). "givenVsBest" compares the input's own dates (if given) to your top recommended window in one sentence, or null if no dates were given to compare.`;

const buildNarrationSystemPrompt = (calendarDates: BestDatesResult | null): string =>
    `You are the narration engine behind a programmatic media-planning console. A plan has already been fully decided by a deterministic engine — which inventory was picked, how much budget goes where, every number (reach, impressions, CPM). Your only job is to write the human-readable text explaining decisions that are already final. You do not choose anything, and nothing you write should contradict a number or a selection you're given — if a number looks surprising, explain it, don't second-guess it.

Hard rules:
1. "title" is a short campaign-plan name (brand + objective + flight, e.g. "Nyka Reach Campaign — Nov 2026"). "summary" is one sentence covering what this plan does and why.
2. "targetGroup" describes the audience actually targeted, as "type::value" strings — type is exactly one of ${TARGET_GROUP_TYPES.join(', ')}, value is the plain-text detail (e.g. "gender::Female", "age::25-34"). Only include what the brief/inputs actually specified — don't invent a target you weren't given.
3. "lineReasons" is one "line::reason" string per budget line you're given, each reason a short sentence on why that line earned its share (e.g. "ctv-fast::Premium ad-supported channel inventory with the strongest VCR for an awareness objective.").
4. "itemReasons" is one "line|inventoryId::reason" string per recommended item you're given, each reason specific to that item's role and numbers WITHIN that line only (e.g. a reach-driver's reason cites its avails, a cost-efficient item's reason cites its CPM) — never a reason blending two different lines together. The same inventoryId can appear under more than one line (the same real property can be both a CTV row and a Mobile OTT row) — treat each line|inventoryId pair as its own separate item needing its own separate reason, even when the id repeats. Use the exact line and inventoryId you were given, unchanged — never invent either.
5. "assumptions" lists anything the deterministic engine had to default because the input didn't specify it (you're told what was left unset) — plain language, one per line.
6. ${bestDatesRule(calendarDates)}
7. All money amounts are in Indian Rupees — use "₹", never "$" or "USD", anywhere you mention an amount.`;

const buildNarrationPrompt = (
    input: PlannerInput,
    core: GeneratedPlanCore,
    calendarDates: BestDatesResult | null
): string => {
    const unsetFields: string[] = [];
    if (input.campaign.budget === null) unsetFields.push('campaign.budget');
    if (input.campaign.startDate === null && input.campaign.endDate === null) {
        unsetFields.push('campaign.startDate/endDate');
    }
    if (input.audience.gender === null) unsetFields.push('audience.gender');
    if (input.audience.ageGroups.length === 0) unsetFields.push('audience.ageGroups');
    if (input.inventory.qualityTier === null) unsetFields.push('inventory.qualityTier');

    return `Brand: ${JSON.stringify(input.brand)}
Campaign: ${JSON.stringify(input.campaign)}
Audience targeting given: ${JSON.stringify(input.audience)}
Rate tier used: ${core.rateTier}
Targeting price uplift on the base CPM (already in every number): ${core.pricing.upliftPercent}% ${JSON.stringify(core.pricing.uplifts)}
Fields left unset by the input (defaulted by the engine): ${unsetFields.join(', ') || '(none)'}

Budget lines (already decided):
${core.budgetAllocation
    .map(
        line =>
            `- ${line.inventoryLine}: ${line.sharePercent}% share, ₹${line.amount}, ${line.impressions} impressions\n` +
            line.recommendedInventory
                .map(
                    item =>
                        `    id=${item.inventoryId} name="${item.name}" role=${item.role} cpm=${item.cpm} avails=${item.avails} amount=₹${item.amount} impressions=${item.impressions}${item.vcr !== null ? ` vcr=${item.vcr}` : ''}`
                )
                .join('\n')
    )
    .join('\n')}

Key figures (already decided): ${JSON.stringify(core.keyFigures)}
Budget left unspent because the available inventory filled up (already decided — mention it plainly in the summary if above 0): ₹${core.unspentBudget}
KPI fit (already decided): ${JSON.stringify(core.kpiFit)}
Platforms that couldn't be planned automatically: ${JSON.stringify(core.plannedByTeam)}${
        calendarDates
            ? `

Best-date windows (already decided from the viewership calendar):
${calendarDates.recommendedWindows
    .map(w => `- ${w.startDate}::${w.endDate} score=${w.score} multiplier=${w.viewershipMultiplier}x events=${JSON.stringify(w.events)}`)
    .join('\n')}
Dates to avoid (already decided):
${calendarDates.datesToAvoid.map(d => `- ${d.startDate}::${d.endDate} multiplier=${d.viewershipMultiplier}x events=${JSON.stringify(d.events)}`).join('\n') || '(none)'}`
            : ''
    }`;
};

export const generateNarration = async (
    input: PlannerInput,
    core: GeneratedPlanCore,
    calendarDates: BestDatesResult | null
): Promise<PlanNarration> => {
    // One fixed ceiling broke in production on a larger plan: "itemReasons" needs one sentence
    // per recommended item across every line (up to maxRecommendationsPerLine × number of
    // lines), so a plan with ~30 items overflowed a flat 2048 and got cut off mid-JSON-string,
    // which failed to parse. Scale with the actual item count instead of guessing one number
    // that happens to fit today's test plans.
    const totalItems = core.budgetAllocation.reduce(
        (sum, line) => sum + line.recommendedInventory.length,
        0
    );
    const maxTokens = Math.min(8192, 1536 + totalItems * 100);

    const result = await generateStructured<ReturnType<typeof buildNarrationSchema>>({
        system: buildNarrationSystemPrompt(calendarDates),
        prompt: buildNarrationPrompt(input, core, calendarDates),
        schema: buildNarrationSchema(),
        maxTokens,
        temperature: 0.2,
    });

    const targetGroup = result.targetGroup
        .map(parseKeyValue)
        .filter(
            (parsed): parsed is { key: string; value: string } =>
                parsed !== null && (TARGET_GROUP_TYPES as readonly string[]).includes(parsed.key)
        )
        .map(({ key, value }) => ({ type: key as PlanNarration['targetGroup'][number]['type'], value }));

    const lineReasons: Record<string, string> = {};
    for (const entry of result.lineReasons) {
        const parsed = parseKeyValue(entry);
        if (parsed) lineReasons[parsed.key] = parsed.value;
    }

    // Keyed by "line|inventoryId" — see buildNarrationSchema's comment for why the id alone
    // isn't unique enough.
    const itemReasons: Record<string, string> = {};
    for (const entry of result.itemReasons) {
        const parsed = parseKeyValue(entry);
        if (parsed) itemReasons[parsed.key] = parsed.value;
    }

    const aiWindows = result.recommendedWindows
        .map(entry => {
            const parts = entry.split('::');
            if (parts.length !== 4) return null;
            const [startDate, endDate, scoreStr, reason] = parts;
            const score = Number(scoreStr);
            if (!Number.isFinite(score)) return null;
            return { startDate, endDate, score: Math.max(0, Math.min(100, score)), reason };
        })
        .filter((w): w is NonNullable<typeof w> => w !== null);

    const aiAvoid = result.datesToAvoid
        .map(entry => {
            const parts = entry.split('::');
            if (parts.length !== 3) return null;
            const [startDate, endDate, reason] = parts;
            return { startDate, endDate, reason };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);

    return {
        title: result.title,
        summary: result.summary,
        targetGroup,
        lineReasons,
        itemReasons,
        assumptions: result.assumptions,
        bestDates: calendarDates
            ? mergeCalendarDates(calendarDates, aiWindows, aiAvoid)
            : {
                  source: 'ai-estimate',
                  recommendedWindows: aiWindows.map(w => ({ ...w, viewershipMultiplier: null, events: [] })),
                  datesToAvoid: aiAvoid.map(d => ({ dateRange: `${d.startDate} to ${d.endDate}`, reason: d.reason })),
                  givenVsBest: result.givenVsBest,
              },
    };
};

/** The calendar's windows, dates and scores win; the model only supplies each one's reason, matched by start::end, with a plain fallback if it skipped one. */
const mergeCalendarDates = (
    calendarDates: BestDatesResult,
    aiWindows: { startDate: string; endDate: string; reason: string }[],
    aiAvoid: { startDate: string; endDate: string; reason: string }[]
): BestDates => {
    const reasonFor = (list: { startDate: string; endDate: string; reason: string }[], startDate: string, endDate: string) =>
        list.find(e => e.startDate === startDate && e.endDate === endDate)?.reason;
    return {
        source: 'calendar',
        recommendedWindows: calendarDates.recommendedWindows.map(w => ({
            ...w,
            reason:
                reasonFor(aiWindows, w.startDate, w.endDate) ??
                `Averages ${w.viewershipMultiplier}x typical-weekday viewership for this channel mix.`,
        })),
        datesToAvoid: calendarDates.datesToAvoid.map(d => ({
            dateRange: `${d.startDate} to ${d.endDate}`,
            reason:
                reasonFor(aiAvoid, d.startDate, d.endDate) ??
                `Viewership below a typical weekday (${d.viewershipMultiplier}x) for this channel mix.`,
        })),
        givenVsBest: calendarDates.givenVsBest,
    };
};

/**
 * The second (and last) LLM call in Call 2 — runs only after the curves are computed, since it
 * has to describe their actual numbers. Same low-temperature, narration-only treatment as
 * generateNarration above: it never recomputes a verdict (too-low/about-right/too-high is
 * already decided in curves.service.ts), it only explains one already decided.
 */
const buildCurveCommentarySchema = () =>
    z.object({
        givenVsRecommendedBudgetReason: z.string().nullable(),
        givenVsRecommendedCpmReason: z.string().nullable(),
        benefitSummary: z.array(z.string()),
    });

const buildCurveCommentarySystemPrompt = (): string =>
    `You are the narration engine behind a programmatic media-planning console. A budget curve and a CPM curve have already been computed by a deterministic engine, including their verdicts (too low / about right / too high). Your only job is to explain those already-decided verdicts in plain language — never restate or imply a different verdict than the one you're given, and never invent a number not already in what you're given.

Hard rules:
1. "givenVsRecommendedBudgetReason" is one sentence explaining the budget verdict you're given, citing the actual reach/cost numbers you're given — null if no budget verdict was computed (the user didn't give a budget).
2. "givenVsRecommendedCpmReason" is the same for the CPM verdict — null if none was computed.
3. "benefitSummary" is 3-5 short lines in plain words on what the user gains by following the recommended dates/budget/CPM instead of their own inputs — grounded only in the numbers you're given, nothing invented. When the budget curve has no recommended levels, the user's budget is final — never suggest spending more or less than it.
4. All money amounts are in Indian Rupees — use "₹", never "$" or "USD", anywhere you mention an amount.`;

const buildCurveCommentaryPrompt = (
    budgetCurve: BudgetCurveResult,
    cpmCurve: CpmCurveResult,
    bestDates: PlanNarration['bestDates']
): string => `Budget curve verdict: ${JSON.stringify(budgetCurve.givenVsRecommended)}
Budget curve recommended levels: ${JSON.stringify(budgetCurve.recommendedBudget)}
Budget curve diminishing-returns point: ${JSON.stringify(budgetCurve.diminishingReturnsPoint)}

CPM curve verdict: ${JSON.stringify(cpmCurve.givenVsRecommended)}
CPM curve recommended levels: ${JSON.stringify(cpmCurve.recommendedCpm)}

Best dates already suggested: ${JSON.stringify(bestDates.recommendedWindows)}`;

export const generateCurveCommentary = async (
    budgetCurve: BudgetCurveResult,
    cpmCurve: CpmCurveResult,
    bestDates: PlanNarration['bestDates']
): Promise<CurveCommentary> => {
    const result = await generateStructured<ReturnType<typeof buildCurveCommentarySchema>>({
        system: buildCurveCommentarySystemPrompt(),
        prompt: buildCurveCommentaryPrompt(budgetCurve, cpmCurve, bestDates),
        schema: buildCurveCommentarySchema(),
        maxTokens: 1024,
        temperature: 0.2,
    });
    return result;
};

/** Merges the deterministic core with the narration text and the two curves into what Call 2 actually returns. Any line/item the narration call didn't give a reason for (dropped during parsing, or the model just missed one) falls back to a plain generated sentence rather than null — the plan shouldn't have a visibly broken field just because narration was incomplete for one row. */
export const mergePlan = (
    input: PlannerInput,
    core: GeneratedPlanCore,
    narration: PlanNarration,
    budgetCurve: BudgetCurveResult,
    cpmCurve: CpmCurveResult,
    curveCommentary: CurveCommentary
): GeneratedPlan => ({
    header: {
        title: narration.title,
        summary: narration.summary,
        status: 'preliminary',
    },
    keyFigures: core.keyFigures,
    flight: core.flight,
    pricing: core.pricing,
    bestDates: narration.bestDates,
    budgetCurve: {
        points: budgetCurve.points,
        recommendedBudget: budgetCurve.recommendedBudget,
        diminishingReturnsPoint: budgetCurve.diminishingReturnsPoint,
        givenVsRecommended: budgetCurve.givenVsRecommended
            ? { ...budgetCurve.givenVsRecommended, reason: curveCommentary.givenVsRecommendedBudgetReason }
            : null,
    },
    cpmCurve: {
        points: cpmCurve.points,
        recommendedCpm: cpmCurve.recommendedCpm,
        givenVsRecommended: cpmCurve.givenVsRecommended
            ? { ...cpmCurve.givenVsRecommended, reason: curveCommentary.givenVsRecommendedCpmReason }
            : null,
    },
    benefitSummary: curveCommentary.benefitSummary,
    budgetAllocation: core.budgetAllocation.map(line => ({
        ...line,
        reason: narration.lineReasons[line.inventoryLine] ?? `${line.sharePercent}% of budget allocated to ${line.inventoryLine}.`,
        recommendedInventory: line.recommendedInventory.map(item => ({
            ...item,
            reason:
                narration.itemReasons[`${line.inventoryLine}|${item.inventoryId}`] ??
                `Selected as ${item.role.replace('-', ' ')}.`,
        })),
    })),
    plannedByTeam: core.plannedByTeam,
    unspentBudget: core.unspentBudget,
    audience: { targetGroup: narration.targetGroup },
    buying: { ...core.buying, dealType: input.buying.dealType },
    brandSafety: core.brandSafety,
    checks: {
        kpiFit: core.kpiFit,
        deliveryFit: core.deliveryFit,
        cpmFit: core.cpmFit,
        assumptions: narration.assumptions,
    },
    // core.internal (media cost/commission) is deliberately left out — this response reaches
    // the planner's screen, and our margin isn't theirs to see.
});
