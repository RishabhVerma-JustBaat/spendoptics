import { z } from 'zod';
import { generateStructured } from '../services/bedrock.service';
import {
    AFFLUENCE_SECS,
    AGE_GROUPS,
    DEAL_TYPES,
    DIVERSIFICATIONS,
    DSP_CHOICES,
    FREQUENCY_CAP_PERIODS,
    GENDERS,
    GEO_SCOPES,
    INCOME_BANDS,
    KPI_METRICS,
    MEDIA_TYPES,
    OBJECTIVES,
    OPTIMISE_FOR,
    PACINGS,
    PLATFORMS,
    PlannerInput,
    QUALITY_TIERS,
    SKIPPABILITY,
    SPENDOPTIX_DSP_ROUTES,
    VIDEO_DURATIONS,
    VIDEO_PLACEMENTS,
    VIDEO_POSITIONS,
} from '../types/ai-planner.types';

export type Provenance = 'stated' | 'inferred' | 'assumed';

/** A blank form — every field null/empty/the product-level default, nothing suggested yet. generateSuggestions below fills fields in on top of this one at a time, so any field the model didn't address at all is left in this safe, honest "unset" state rather than missing from the object. */
export const buildEmptyPlannerInput = (): PlannerInput => ({
    brand: { name: null, url: null, category: null, competitors: [] },
    campaign: {
        objective: null,
        kpis: [],
        budget: null,
        startDate: null,
        endDate: null,
        campaignMonth: null,
        seasonality: null,
        pacing: null,
    },
    audience: {
        geoScope: null,
        states: [],
        cities: [],
        excludeStates: [],
        gender: null,
        ageGroups: [],
        affluenceSec: [],
        incomeBand: null,
        interests: [],
        behaviours: [],
        lifeStage: [],
        languages: [],
        audienceNotes: null,
    },
    inventory: {
        platforms: [],
        mediaTypes: [],
        iabCategories: [],
        contentGenres: [],
        qualityTier: null,
        preferredSitesApps: [],
        blockedSitesApps: [],
        mustInclude: [],
        categoriesToAvoid: [],
        brandSafetyExclusions: [],
        minViewabilityPct: null,
        minVcrPct: null,
        maxCpm: null,
        minAvails: null,
        minUniqueAudience: null,
    },
    creative: {
        displayFormats: [],
        displaySizes: [],
        videoPlacements: [],
        videoPositions: [],
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

/** Every leaf field the suggest call can fill, with how to validate a parsed value for it — mirrors plan-prompts.ts's isValidAssumedValue pattern: reject an out-of-set value rather than write something the rest of the app never expects. "free" fields (brand name, notes, ids, ...) have no fixed vocabulary to check against. */
const FIELD_VALIDATORS: Record<string, (value: unknown) => boolean> = {
    'brand.name': v => typeof v === 'string',
    'brand.url': v => typeof v === 'string',
    'brand.category': v => typeof v === 'string',
    'brand.competitors': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'campaign.objective': v => (OBJECTIVES as readonly string[]).includes(v as string),
    'campaign.kpis': v =>
        Array.isArray(v) &&
        v.every(
            k =>
                typeof k === 'object' &&
                k !== null &&
                (KPI_METRICS as readonly string[]).includes((k as { metric: string }).metric)
        ),
    'campaign.budget': v => typeof v === 'number' && v >= 0,
    'campaign.startDate': v => typeof v === 'string',
    'campaign.endDate': v => typeof v === 'string',
    'campaign.campaignMonth': v => typeof v === 'string',
    'campaign.seasonality': v => typeof v === 'string',
    'campaign.pacing': v => (PACINGS as readonly string[]).includes(v as string),
    'audience.geoScope': v => (GEO_SCOPES as readonly string[]).includes(v as string),
    'audience.states': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.cities': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.excludeStates': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.gender': v => (GENDERS as readonly string[]).includes(v as string),
    'audience.ageGroups': v => Array.isArray(v) && v.every(x => (AGE_GROUPS as readonly string[]).includes(x)),
    'audience.affluenceSec': v =>
        Array.isArray(v) && v.every(x => (AFFLUENCE_SECS as readonly string[]).includes(x)),
    'audience.incomeBand': v => (INCOME_BANDS as readonly string[]).includes(v as string),
    'audience.interests': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.behaviours': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.lifeStage': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.languages': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'audience.audienceNotes': v => typeof v === 'string',
    'inventory.platforms': v => Array.isArray(v) && v.every(x => (PLATFORMS as readonly string[]).includes(x)),
    'inventory.mediaTypes': v => Array.isArray(v) && v.every(x => (MEDIA_TYPES as readonly string[]).includes(x)),
    'inventory.iabCategories': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.contentGenres': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.qualityTier': v => (QUALITY_TIERS as readonly string[]).includes(v as string),
    'inventory.preferredSitesApps': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.blockedSitesApps': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.mustInclude': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.categoriesToAvoid': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.brandSafetyExclusions': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'inventory.minViewabilityPct': v => typeof v === 'number',
    'inventory.minVcrPct': v => typeof v === 'number',
    'inventory.maxCpm': v => typeof v === 'number' && v >= 0,
    'inventory.minAvails': v => typeof v === 'number' && v >= 0,
    'inventory.minUniqueAudience': v => typeof v === 'number' && v >= 0,
    'creative.displayFormats': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'creative.displaySizes': v => Array.isArray(v) && v.every(x => typeof x === 'string'),
    'creative.videoPlacements': v =>
        Array.isArray(v) && v.every(x => (VIDEO_PLACEMENTS as readonly string[]).includes(x)),
    'creative.videoPositions': v =>
        Array.isArray(v) && v.every(x => (VIDEO_POSITIONS as readonly string[]).includes(x)),
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
        // same reason assumedDefaults/itemReasons are flat elsewhere in this codebase: this
        // form has ~55 leaf fields, and an object-shaped array item per field is the single
        // biggest known contributor to Bedrock's grammar-size ceiling. One flat array easily
        // fits where a parallel structure describing the same ~55 fields as nested objects
        // risked not fitting at all.
        suggestions: z.array(z.string()),
    });

const FIELD_REFERENCE = `brand.name (text), brand.url (text, e.g. nykaa.com), brand.category (text — your own inference from the brand, not a fixed list), brand.competitors (text list)
campaign.objective (one of: ${OBJECTIVES.join(', ')}), campaign.kpis (list of {"metric":"vcr"|"ctr","target":number|null} — ONLY these 2 metrics, nothing else), campaign.budget (number, INR, no shorthand — "50 Lakh" -> 5000000, "1 Crore" -> 10000000), campaign.startDate/campaign.endDate (YYYY-MM-DD), campaign.campaignMonth (YYYY-MM, only if exact dates aren't known), campaign.seasonality (text), campaign.pacing (one of: ${PACINGS.join(', ')})
audience.geoScope (one of: ${GEO_SCOPES.join(', ')}), audience.states/audience.cities/audience.excludeStates (text lists), audience.gender (one of: ${GENDERS.join(', ')}), audience.ageGroups (list from: ${AGE_GROUPS.join(', ')}), audience.affluenceSec (list from: ${AFFLUENCE_SECS.join(', ')}), audience.incomeBand (one of: ${INCOME_BANDS.join(', ')}), audience.interests/behaviours/lifeStage/languages (text lists), audience.audienceNotes (text)
inventory.platforms (list from: ${PLATFORMS.join(', ')}), inventory.mediaTypes (list from: ${MEDIA_TYPES.join(', ')}), inventory.iabCategories (text list), inventory.contentGenres (text list), inventory.qualityTier (one of: ${QUALITY_TIERS.join(', ')}), inventory.preferredSitesApps/blockedSitesApps/mustInclude/categoriesToAvoid/brandSafetyExclusions (text lists), inventory.minViewabilityPct/minVcrPct (0-100), inventory.maxCpm (INR), inventory.minAvails/minUniqueAudience (numbers)
creative.displayFormats/displaySizes (text lists), creative.videoPlacements (list from: ${VIDEO_PLACEMENTS.join(', ')}), creative.videoPositions (list from: ${VIDEO_POSITIONS.join(', ')}), creative.videoDurations (list from: ${VIDEO_DURATIONS.join(', ')}), creative.skippability (list from: ${SKIPPABILITY.join(', ')})
buying.dspChoice (one of: ${DSP_CHOICES.join(', ')}), buying.spendoptixDspRoute (one of: ${SPENDOPTIX_DSP_ROUTES.join(', ')}, only if dspChoice is spendoptix-dsp), buying.ownDspNames (text list, only if dspChoice is own-dsp), buying.seatId (text), buying.dealType (one of: ${DEAL_TYPES.join(', ')}), buying.frequencyCap ({"impressions":number,"period":"${FREQUENCY_CAP_PERIODS.join('"|"')}"})
plannerSettings.optimiseFor (one of: ${OPTIMISE_FOR.join(', ')}, default balanced), plannerSettings.diversification (one of: ${DIVERSIFICATIONS.join(', ')}, default balanced), plannerSettings.maxRecommendationsPerLine (number, default 8)`;

const buildSuggestSystemPrompt = (iabCategories: string[]): string =>
    `You turn a free-text media-planning brief into pre-filled form fields for a programmatic media-planning console. The brief can be messy, casual, or missing most details — your job is to fill in every field below anyway, never leaving the form blank, so the planner reviews a complete draft instead of an empty one.

For EVERY field, decide one of three provenance tags:
- "stated" — the brief literally says this (a number, a name, an explicit instruction).
- "inferred" — not stated, but you can reasonably work it out from context (e.g. a brand's product category from its name, a sensible objective from the tone of the ask).
- "assumed" — nothing in the brief gives any signal at all; you picked a plausible default.

Never skip a field because nothing was said — tag it "assumed" and give your best reasonable default instead. The one exception is "inventory.iabCategories" — only suggest one of these real categories: ${iabCategories.join(', ')} — or leave it unsuggested if genuinely nothing fits, since inventing one that doesn't exist in the real data defeats its purpose.

Fields and their types/allowed values:
${FIELD_REFERENCE}

Output each field as one "field::jsonValue::provenance" string in "suggestions" — field is the exact dot path above (e.g. "campaign.budget"), jsonValue is that value JSON-encoded exactly matching its type (a bare number, a quoted string, an array, or an object), provenance is exactly "stated", "inferred", or "assumed". Money is always INR. A field you have no reasonable basis for even as an assumption (e.g. buying.seatId, buying.ownDspNames when no DSP preference is evident) can be left out entirely — an honestly-missing field beats an invented one.`;

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
}

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
        prompt: `Brief:\n"""\n${prompt}\n"""`,
        schema: buildSuggestSchema(),
        maxTokens: 4096,
    });

    const input = buildEmptyPlannerInput();
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

    return { input, provenance };
};
