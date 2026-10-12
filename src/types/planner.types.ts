/**
 * Types for the new two-call AI Planner flow (replaces the old single-call /plan/analyse):
 * Call 1 ("suggest") turns a free-text prompt into pre-filled, provenance-tagged form fields;
 * the user vets them; Call 2 ("generate") takes the vetted form and produces the actual plan.
 * This file covers Call 2's input/output shapes — see planner.prompts.ts (the "Call 1" section) for Call 1.
 *
 * Every number and every selection/allocation decision in the Call 2 output is computed
 * deterministically in code (planner.candidates.ts / allocation.service.ts), never
 * by an LLM — the only LLM involvement left is narration text wrapped around decisions
 * already made. See allocation.service.ts's top comment for why.
 */

export const OBJECTIVES = [
    'awareness',
    'reach',
    'consideration',
    'video-views',
    'traffic',
    'app-installs',
    'leads',
    'sales',
] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** Fixed to exactly these 2 — the only metrics any ingested sheet has any data for at all. */
export const KPI_METRICS = ['vcr', 'ctr'] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

export const PACINGS = ['even', 'front-loaded', 'back-loaded', 'burst'] as const;
export type Pacing = (typeof PACINGS)[number];

export const GEO_SCOPES = ['pan-india', 'states', 'cities'] as const;
export type GeoScope = (typeof GEO_SCOPES)[number];

export const GENDERS = ['all', 'male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

export const AGE_GROUPS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

export const AFFLUENCE_SECS = ['A', 'B', 'C', 'D', 'E'] as const;
export type AffluenceSec = (typeof AFFLUENCE_SECS)[number];

export const INCOME_BANDS = ['premium', 'upper-mid', 'mid', 'mass'] as const;
export type IncomeBand = (typeof INCOME_BANDS)[number];

/** The 8 platform values the form accepts — PLATFORM_LINE_MAP below maps these onto the 4 real output lines (a many-to-one map, and "can keep changing" per product direction, so kept as a lookup table rather than inlined logic). */
export const PLATFORMS = [
    'ctv',
    'ctv-oem',
    'ctv-fast',
    'mobile-ott',
    'web',
    'mweb',
    'in-app',
    'youtube',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const MEDIA_TYPES = ['display', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const QUALITY_TIERS = ['premium-only', 'premium-preferred', 'any'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export const VIDEO_PLACEMENTS = ['instream', 'outstream', 'interstitial'] as const;
export const VIDEO_POSITIONS = ['preroll', 'midroll', 'postroll'] as const;
export const VIDEO_DURATIONS = ['under-10s', 'under-30s', 'up-to-60s'] as const;
export const SKIPPABILITY = ['skippable', 'non-skippable'] as const;

export const DSP_CHOICES = ['spendoptix-dsp', 'own-dsp'] as const;
export const SPENDOPTIX_DSP_ROUTES = ['dv360', 'authorised-buyer'] as const;
export const DEAL_TYPES = [
    'pmp',
    'programmatic-guaranteed',
    'preferred-deal',
    'open-auction',
    'any',
] as const;
export const FREQUENCY_CAP_PERIODS = ['day', 'week', 'month', 'campaign'] as const;

export const OPTIMISE_FOR = ['reach', 'cost-efficiency', 'quality', 'viewability', 'balanced'] as const;
export type OptimiseFor = (typeof OPTIMISE_FOR)[number];

export const DIVERSIFICATIONS = ['concentrated', 'balanced', 'broad'] as const;
export type Diversification = (typeof DIVERSIFICATIONS)[number];

/** The 4 real output lines — see PLATFORM_LINE_MAP for how the 8 input platforms collapse onto these. */
export const INVENTORY_LINES = ['ctv-oem-fast', 'mobile-ott', 'in-app', 'websites'] as const;
export type InventoryLine = (typeof INVENTORY_LINES)[number];

export const RATE_TIERS = ['open', 'premium', 'advance'] as const;
export type RateTier = (typeof RATE_TIERS)[number];

export const ROLES = [
    'reach-driver',
    'quality-anchor',
    'cost-efficient',
    'audience-fit',
    'must-include',
    'preferred',
] as const;
export type Role = (typeof ROLES)[number];

export interface PlannerInput {
    brand: {
        name: string | null;
        url: string | null;
        category: string | null;
        competitors: string[];
    };
    campaign: {
        objective: Objective | null;
        kpis: { metric: KpiMetric; target: number | null }[];
        budget: number | null;
        startDate: string | null;
        endDate: string | null;
        campaignMonth: string | null;
        seasonality: string | null;
        pacing: Pacing | null;
    };
    audience: {
        geoScope: GeoScope | null;
        states: string[];
        cities: string[];
        excludeStates: string[];
        gender: Gender | null;
        ageGroups: AgeGroup[];
        affluenceSec: AffluenceSec[];
        incomeBand: IncomeBand | null;
        interests: string[];
        behaviours: string[];
        lifeStage: string[];
        languages: string[];
        audienceNotes: string | null;
    };
    inventory: {
        platforms: Platform[];
        mediaTypes: MediaType[];
        iabCategories: string[];
        contentGenres: string[];
        qualityTier: QualityTier | null;
        preferredSitesApps: string[];
        blockedSitesApps: string[];
        mustInclude: string[];
        categoriesToAvoid: string[];
        brandSafetyExclusions: string[];
        minViewabilityPct: number | null;
        minVcrPct: number | null;
        maxCpm: number | null;
        minAvails: number | null;
        minUniqueAudience: number | null;
    };
    creative: {
        displayFormats: string[];
        displaySizes: string[];
        videoPlacements: (typeof VIDEO_PLACEMENTS)[number][];
        videoPositions: (typeof VIDEO_POSITIONS)[number][];
        videoDurations: (typeof VIDEO_DURATIONS)[number][];
        skippability: (typeof SKIPPABILITY)[number][];
    };
    buying: {
        dspChoice: (typeof DSP_CHOICES)[number] | null;
        spendoptixDspRoute: (typeof SPENDOPTIX_DSP_ROUTES)[number] | null;
        ownDspNames: string[];
        seatId: string | null;
        dealType: (typeof DEAL_TYPES)[number] | null;
        frequencyCap: { impressions: number; period: (typeof FREQUENCY_CAP_PERIODS)[number] } | null;
    };
    plannerSettings: {
        optimiseFor: OptimiseFor;
        diversification: Diversification;
        maxRecommendationsPerLine: number;
    };
}

/** A real, concrete inventory row pulled from the ingested rate-card tables — never invented. "uniqueAudience"/"vcr" are null where the source sheet doesn't have that column at all (e.g. no sheet has VCR except CTV/Mobile OTT). */
export interface CandidateInventoryItem {
    id: string;
    name: string;
    line: InventoryLine;
    platform: Platform;
    avails: number;
    uniqueAudience: number | null;
    cpm: number;
    vcr: number | null;
    isMustInclude: boolean;
    isPreferred: boolean;
}

export interface RecommendedInventoryItem {
    inventoryId: string;
    rank: number;
    role: Role;
    reason: string | null; // filled by the narration call; null until then
    name: string;
    environment: string;
    avails: number;
    uniqueAudience: number | null;
    cpm: number;
    vcr: number | null;
}

export interface BudgetAllocationLine {
    inventoryLine: InventoryLine;
    sharePercent: number;
    amount: number;
    impressions: number;
    reason: string | null;
    recommendedInventory: RecommendedInventoryItem[];
}

export interface KpiFitResult {
    metric: KpiMetric;
    target: number | null;
    projected: number | null;
    verdict: 'meets' | 'close' | 'misses' | 'not-measurable';
    comment: string | null;
}

/** The deterministic core of the plan — everything here is computed by allocation.service.ts, zero LLM involvement. Narration (title/summary/reason/assumptions/confidence text) gets merged in afterward by planner.prompts.ts's narration call. */
export interface GeneratedPlanCore {
    keyFigures: {
        estimatedReach: number;
        uniqueAudience: number | null;
        estimatedAvails: number;
        estimatedImpressions: number;
        averageCpm: number;
        estimatedFrequency: number | null;
    };
    flight: {
        startDate: string | null;
        endDate: string | null;
        pacing: Pacing | null;
    };
    rateTier: RateTier;
    budgetAllocation: BudgetAllocationLine[];
    plannedByTeam: { platform: Platform; reason: string }[];
    kpiFit: KpiFitResult[];
    buying: {
        dealType: (typeof DEAL_TYPES)[number] | null;
        dspCompatible: boolean;
        rateCard: RateTier;
    };
    brandSafety: {
        exclusionsApplied: string[];
    };
}

export const TARGET_GROUP_TYPES = [
    'gender',
    'age',
    'affluence',
    'interest',
    'behaviour',
    'life-stage',
    'language',
] as const;
export type TargetGroupType = (typeof TARGET_GROUP_TYPES)[number];

export interface RecommendedWindow {
    startDate: string;
    endDate: string;
    /** AI's own judgment, 0-100 — not system-computed, since there's no avails-history/events data to compute it from. One deliberate exception to "every number is deterministic" — see planner.prompts.ts's narration call comment. */
    score: number;
    reason: string;
}

export interface BestDates {
    recommendedWindows: RecommendedWindow[];
    datesToAvoid: { dateRange: string; reason: string }[];
    givenVsBest: string | null;
}

/** Narration text wrapped around a GeneratedPlanCore that's already fully decided — see allocation.service.ts's top comment. Produced by planner.prompts.ts's narration call. */
export interface PlanNarration {
    title: string;
    summary: string;
    targetGroup: { type: TargetGroupType; value: string }[];
    lineReasons: Record<string, string>;
    itemReasons: Record<string, string>;
    assumptions: string[];
    bestDates: BestDates;
}

/** Written after the curves are computed, since it has to describe their actual numbers — see planner.prompts.ts's curve-commentary call. */
export interface CurveCommentary {
    givenVsRecommendedBudgetReason: string | null;
    givenVsRecommendedCpmReason: string | null;
    benefitSummary: string[];
}

/** What Call 2 ("generate") actually returns — GeneratedPlanCore's decisions with PlanNarration's text and the two curves merged in. */
export interface GeneratedPlan {
    header: {
        title: string;
        summary: string;
        status: 'preliminary' | 'final';
    };
    keyFigures: GeneratedPlanCore['keyFigures'];
    flight: GeneratedPlanCore['flight'];
    bestDates: BestDates;
    budgetCurve: {
        points: { budget: number; reach: number; impressions: number; averageCpm: number; frequency: number | null }[];
        recommendedBudget: { low: number; optimal: number; high: number } | null;
        diminishingReturnsPoint: { budget: number; reach: number } | null;
        givenVsRecommended:
            | { verdict: 'too-low' | 'about-right' | 'too-high'; reachDifferencePercent: number; costPer1000Reached: number; reason: string | null }
            | null;
    };
    cpmCurve: {
        points: { cpmCap: number; availableImpressions: number; reach: number; shareOfInventoryUnlocked: number }[];
        recommendedCpm: { low: number; optimal: number; high: number } | null;
        givenVsRecommended: { verdict: 'too-low' | 'about-right' | 'too-high'; differencePercent: number; reason: string | null } | null;
    };
    benefitSummary: string[];
    budgetAllocation: (Omit<BudgetAllocationLine, 'reason' | 'recommendedInventory'> & {
        reason: string;
        recommendedInventory: RecommendedInventoryItem[];
    })[];
    plannedByTeam: GeneratedPlanCore['plannedByTeam'];
    audience: {
        targetGroup: PlanNarration['targetGroup'];
    };
    buying: GeneratedPlanCore['buying'] & { dealType: PlannerInput['buying']['dealType'] };
    brandSafety: GeneratedPlanCore['brandSafety'];
    checks: {
        kpiFit: KpiFitResult[];
        assumptions: string[];
    };
}
