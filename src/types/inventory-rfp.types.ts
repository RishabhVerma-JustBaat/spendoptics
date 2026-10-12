import { z } from 'zod';

/** z.enum() needs a non-empty tuple; an empty list degrades to free text instead of a 500. */
const enumOrNull = (values: string[]) =>
    values.length > 0 ? z.enum(values as [string, ...string[]]).nullable() : z.string().nullable();

/**
 * For a buyer/seller RFP-style brief ("what CPM, what availability, recommend
 * a site list...") rather than a campaign-builder brief. The model has no rate
 * card or live inventory system to ground most of this in, so this schema mostly
 * captures what the brief is asking for rather than invented answers — except
 * "matchedIabCategory", which plan-prompts.ts uses to look up real CPM/availability
 * from the ingested rate card wherever a match exists. See config/plan-prompts.ts
 * for the system prompt that enforces this split.
 */
export const buildInventoryRfpResponseSchema = (iabCategories: string[]) => {
    const targeting = z.object({
        geos: z.array(z.string()),
        category: z.string().nullable(),
        // Constrained to the real IAB categories the ingested rate-card data covers — unlike
        // "category" above (the brief's own words), this is what plan-prompts.ts actually
        // queries with. Null when nothing in the list genuinely fits.
        matchedIabCategory: enumOrNull(iabCategories),
        platforms: z.array(z.string()),
        placements: z.array(z.string()),
        audienceSources: z.array(z.string()),
        demographics: z.string().nullable(),
        creativeFormats: z.array(z.string()),
        durationDays: z.number().int().nullable(),
        impressionGoal: z.number().int().nullable(),
    });

    return z.object({
        targeting,
        asks: z.array(z.string()),
        // Real, named, checkable things — not prose advice. See plan-prompts.ts's system
        // prompt for what "real" means here (actual publisher properties, actual IAB units,
        // actual platform audience-taxonomy segment names) vs. what still counts as an
        // invented fact (a rate, an availability number, a claim something is available).
        suggestedPublisherProperties: z.array(z.string()),
        suggestedAdFormats: z.array(z.string()),
        suggestedAudienceSegments: z.array(z.string()),
        requiresManualInput: z.array(z.string()),
        notes: z.string().nullable(),
    });
};

export type InventoryRfpResponseSchema = ReturnType<typeof buildInventoryRfpResponseSchema>;
export type InventoryRfpResponse = z.infer<InventoryRfpResponseSchema>;

export interface RateCardChannelAnswer {
    cpm: number;
    availableImpressions: number;
    topSites: string[];
}

/** The merged shape plan-prompts.ts returns — the LLM's structured ask, plus a separate, clearly-real answer block wherever the ingested rate card actually covers it. Never edits "asks"/"requiresManualInput" itself (string-matching an open-ended English label back onto this is too fragile to trust) — a planner cross-references this against those by eye. */
export interface InventoryRfpFinalResponse extends InventoryRfpResponse {
    rateCard: {
        ctv: RateCardChannelAnswer | null;
        mobileOtt: RateCardChannelAnswer | null;
        web: RateCardChannelAnswer | null;
    };
}
