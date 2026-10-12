import Joi from 'joi';
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
    QUALITY_TIERS,
    SKIPPABILITY,
    SPENDOPTIX_DSP_ROUTES,
    VIDEO_DURATIONS,
    VIDEO_PLACEMENTS,
    VIDEO_POSITIONS,
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
});

// Every nullable field also carries .empty('') — caught live: the suggest call (Call 1) can
// return an empty string for a field it had no real value for (e.g. brand.url) rather than a
// clean null, and .allow(null) alone doesn't accept '' as a value. .empty('') treats '' as
// "absent", which then falls through to each field's own .default(null) instead of failing
// validation outright.
export const generatePlanSchema = Joi.object({
    brand: Joi.object({
        name: Joi.string().allow(null).empty('').default(null),
        url: Joi.string().allow(null).empty('').default(null),
        category: Joi.string().allow(null).empty('').default(null),
        competitors: stringArray,
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
    }).default(),

    audience: Joi.object({
        geoScope: Joi.string()
            .valid(...GEO_SCOPES)
            .allow(null).empty('')
            .default(null),
        states: stringArray,
        cities: stringArray,
        excludeStates: stringArray,
        gender: Joi.string()
            .valid(...GENDERS)
            .allow(null).empty('')
            .default(null),
        ageGroups: Joi.array()
            .items(Joi.string().valid(...AGE_GROUPS))
            .default([]),
        affluenceSec: Joi.array()
            .items(Joi.string().valid(...AFFLUENCE_SECS))
            .default([]),
        incomeBand: Joi.string()
            .valid(...INCOME_BANDS)
            .allow(null).empty('')
            .default(null),
        interests: stringArray,
        behaviours: stringArray,
        lifeStage: stringArray,
        languages: stringArray,
        audienceNotes: Joi.string().allow(null).empty('').default(null),
    }).default(),

    inventory: Joi.object({
        platforms: Joi.array()
            .items(Joi.string().valid(...PLATFORMS))
            .default([]),
        mediaTypes: Joi.array()
            .items(Joi.string().valid(...MEDIA_TYPES))
            .default([]),
        iabCategories: stringArray,
        contentGenres: stringArray,
        qualityTier: Joi.string()
            .valid(...QUALITY_TIERS)
            .allow(null).empty('')
            .default(null),
        preferredSitesApps: stringArray,
        blockedSitesApps: stringArray,
        mustInclude: stringArray,
        categoriesToAvoid: stringArray,
        brandSafetyExclusions: stringArray,
        minViewabilityPct: Joi.number().min(0).max(100).allow(null).empty('').default(null),
        minVcrPct: Joi.number().min(0).max(100).allow(null).empty('').default(null),
        maxCpm: Joi.number().min(0).allow(null).empty('').default(null),
        minAvails: Joi.number().integer().min(0).allow(null).empty('').default(null),
        minUniqueAudience: Joi.number().integer().min(0).allow(null).empty('').default(null),
    }).default(),

    creative: Joi.object({
        displayFormats: stringArray,
        displaySizes: stringArray,
        videoPlacements: Joi.array()
            .items(Joi.string().valid(...VIDEO_PLACEMENTS))
            .default([]),
        videoPositions: Joi.array()
            .items(Joi.string().valid(...VIDEO_POSITIONS))
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
        maxRecommendationsPerLine: Joi.number().integer().min(1).max(50).default(8),
    }).default(),
});
