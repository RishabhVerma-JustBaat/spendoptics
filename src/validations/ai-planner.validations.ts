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
} from '../types/ai-planner.types';

// Every field is optional per the product spec ("Every input field is optional. Anything
// missing is filled with a sensible default") — Call 1 ("suggest") is what's expected to
// usually fill this in from a free-text prompt, but Call 2 ("generate") accepts a fully
// hand-built input too (e.g. "Create Your Own Media Plan" in the product flow), so nothing
// here is required.

const stringArray = Joi.array().items(Joi.string()).default([]);

export const suggestPromptSchema = Joi.object({
    prompt: Joi.string().trim().min(1).max(20000).required(),
});

export const generatePlanSchema = Joi.object({
    brand: Joi.object({
        name: Joi.string().allow(null).default(null),
        url: Joi.string().allow(null).default(null),
        category: Joi.string().allow(null).default(null),
        competitors: stringArray,
    }).default(),

    campaign: Joi.object({
        objective: Joi.string()
            .valid(...OBJECTIVES)
            .allow(null)
            .default(null),
        kpis: Joi.array()
            .items(
                Joi.object({
                    metric: Joi.string()
                        .valid(...KPI_METRICS)
                        .required(),
                    target: Joi.number().allow(null).default(null),
                })
            )
            .default([]),
        budget: Joi.number().integer().min(0).allow(null).default(null),
        startDate: Joi.string().isoDate().allow(null).default(null),
        endDate: Joi.string().isoDate().allow(null).default(null),
        campaignMonth: Joi.string().allow(null).default(null),
        seasonality: Joi.string().allow(null).default(null),
        pacing: Joi.string()
            .valid(...PACINGS)
            .allow(null)
            .default(null),
    }).default(),

    audience: Joi.object({
        geoScope: Joi.string()
            .valid(...GEO_SCOPES)
            .allow(null)
            .default(null),
        states: stringArray,
        cities: stringArray,
        excludeStates: stringArray,
        gender: Joi.string()
            .valid(...GENDERS)
            .allow(null)
            .default(null),
        ageGroups: Joi.array()
            .items(Joi.string().valid(...AGE_GROUPS))
            .default([]),
        affluenceSec: Joi.array()
            .items(Joi.string().valid(...AFFLUENCE_SECS))
            .default([]),
        incomeBand: Joi.string()
            .valid(...INCOME_BANDS)
            .allow(null)
            .default(null),
        interests: stringArray,
        behaviours: stringArray,
        lifeStage: stringArray,
        languages: stringArray,
        audienceNotes: Joi.string().allow(null).default(null),
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
            .allow(null)
            .default(null),
        preferredSitesApps: stringArray,
        blockedSitesApps: stringArray,
        mustInclude: stringArray,
        categoriesToAvoid: stringArray,
        brandSafetyExclusions: stringArray,
        minViewabilityPct: Joi.number().min(0).max(100).allow(null).default(null),
        minVcrPct: Joi.number().min(0).max(100).allow(null).default(null),
        maxCpm: Joi.number().min(0).allow(null).default(null),
        minAvails: Joi.number().integer().min(0).allow(null).default(null),
        minUniqueAudience: Joi.number().integer().min(0).allow(null).default(null),
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
            .allow(null)
            .default(null),
        spendoptixDspRoute: Joi.string()
            .valid(...SPENDOPTIX_DSP_ROUTES)
            .allow(null)
            .default(null),
        ownDspNames: stringArray,
        seatId: Joi.string().allow(null).default(null),
        dealType: Joi.string()
            .valid(...DEAL_TYPES)
            .allow(null)
            .default(null),
        frequencyCap: Joi.object({
            impressions: Joi.number().integer().min(1).required(),
            period: Joi.string()
                .valid(...FREQUENCY_CAP_PERIODS)
                .required(),
        })
            .allow(null)
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
