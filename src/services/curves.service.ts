/**
 * Both curves are pure computation over the real candidate shortlist — no LLM involvement,
 * consistent with allocation.service.ts's "every number is deterministic" rule. The CPM curve
 * reads directly off the shortlist's own CPM distribution; the budget curve re-runs
 * allocation.service.ts's buildPlanCore at several budget levels against the same shortlist —
 * the "range of budgets around the one the user gave" approach, not a fitted formula. When no
 * budget is given at all, there's no number to sweep around, so buildMarketBudgetCurve takes
 * over instead: same rate-card data, read in the opposite direction from the CPM curve (sweep
 * target shares of the real avails pool, cheapest-CPM-first, and sum each tier's own real
 * avails × cpm to get its real cost) rather than guessing a budget figure.
 */
import { CandidateResult } from './planner.candidates';
import { buildPlanCore } from './allocation.service';
import { PlannerInput } from '../types/planner.types';

export interface CpmCurvePoint {
    cpmCap: number;
    availableImpressions: number;
    reach: number;
    shareOfInventoryUnlocked: number;
}

export interface BudgetCurvePoint {
    budget: number;
    reach: number;
    impressions: number;
    averageCpm: number;
    frequency: number | null;
}

export type Verdict = 'too-low' | 'about-right' | 'too-high';

export interface CpmCurveResult {
    points: CpmCurvePoint[];
    recommendedCpm: { low: number; optimal: number; high: number } | null;
    givenVsRecommended: { verdict: Verdict; differencePercent: number } | null;
}

export interface BudgetCurveResult {
    points: BudgetCurvePoint[];
    recommendedBudget: { low: number; optimal: number; high: number } | null;
    diminishingReturnsPoint: { budget: number; reach: number } | null;
    givenVsRecommended: { verdict: Verdict; reachDifferencePercent: number; costPer1000Reached: number } | null;
}

const POINT_COUNT = 9;

/** Builds the CPM curve from the full candidate pool (not just what got selected) — this is about what the available market looks like at each price point, not this one plan's picks. */
export const buildCpmCurve = (candidates: CandidateResult, maxCpmGiven: number | null): CpmCurveResult => {
    const allCandidates = Object.values(candidates.byLine).flat();
    if (allCandidates.length === 0) {
        return { points: [], recommendedCpm: null, givenVsRecommended: null };
    }

    const cpms = allCandidates.map(c => c.cpm).sort((a, b) => a - b);
    const minCpm = cpms[0];
    const maxCpm = cpms[cpms.length - 1];
    const totalAvails = allCandidates.reduce((sum, c) => sum + c.avails, 0);

    const points: CpmCurvePoint[] = [];
    for (let i = 0; i < POINT_COUNT; i++) {
        const cpmCap = Math.round(minCpm + ((maxCpm - minCpm) * i) / (POINT_COUNT - 1));
        const unlocked = allCandidates.filter(c => c.cpm <= cpmCap);
        const availableImpressions = unlocked.reduce((sum, c) => sum + c.avails, 0);
        const reach = Math.max(0, ...unlocked.map(c => c.uniqueAudience ?? 0));
        points.push({
            cpmCap,
            availableImpressions,
            reach,
            shareOfInventoryUnlocked:
                totalAvails > 0 ? Math.round((availableImpressions / totalAvails) * 1000) / 10 : 0,
        });
    }

    // "Optimal" = the lowest CPM cap that already unlocks at least 80% of total available
    // inventory — past this point, raising the cap buys comparatively little extra supply.
    const optimalPoint = points.find(p => p.shareOfInventoryUnlocked >= 80) ?? points[points.length - 1];
    const recommendedCpm = {
        low: points[Math.floor(POINT_COUNT * 0.25)].cpmCap,
        optimal: optimalPoint.cpmCap,
        high: points[points.length - 1].cpmCap,
    };

    let givenVsRecommended: CpmCurveResult['givenVsRecommended'] = null;
    if (maxCpmGiven !== null && recommendedCpm.optimal > 0) {
        const diff = ((maxCpmGiven - recommendedCpm.optimal) / recommendedCpm.optimal) * 100;
        const verdict: Verdict = diff < -10 ? 'too-low' : diff > 10 ? 'too-high' : 'about-right';
        givenVsRecommended = { verdict, differencePercent: Math.round(diff * 10) / 10 };
    }

    return { points, recommendedCpm, givenVsRecommended };
};

/**
 * No budget to sweep around, so sweep target shares of the real candidate pool's total avails
 * instead (cheapest CPM first — the order a real buyer would actually fill), and sum each
 * tier's own real avails × cpm for its real cost. Mirrors buildCpmCurve's "what does the
 * market look like" framing, just read in the budget direction instead of the CPM direction.
 */
const buildMarketBudgetCurve = (candidates: CandidateResult): BudgetCurveResult => {
    const allCandidates = Object.values(candidates.byLine).flat();
    if (allCandidates.length === 0) {
        return { points: [], recommendedBudget: null, diminishingReturnsPoint: null, givenVsRecommended: null };
    }

    const sorted = [...allCandidates].sort((a, b) => a.cpm - b.cpm);
    const totalAvails = sorted.reduce((sum, c) => sum + c.avails, 0);
    const shares = Array.from({ length: POINT_COUNT }, (_, i) => (i + 1) / POINT_COUNT);

    const points: BudgetCurvePoint[] = shares.map(share => {
        const targetAvails = totalAvails * share;
        let cumulativeAvails = 0;
        let cumulativeCost = 0;
        let reach = 0;
        for (const c of sorted) {
            if (cumulativeAvails >= targetAvails) break;
            // A real buyer doesn't have to take a property's entire pool — take only the slice
            // needed to land exactly on this point's target, at that property's own real CPM.
            // Without this, one outsized property (e.g. a single app with billions of avails)
            // jumps cumulativeAvails past several consecutive share-targets in one step, making
            // this point and the next few identical instead of a real curve.
            const take = Math.min(c.avails, targetAvails - cumulativeAvails);
            cumulativeAvails += take;
            cumulativeCost += (take / 1000) * c.cpm;
            reach = Math.max(reach, c.uniqueAudience ?? 0);
        }
        const impressions = Math.round(cumulativeAvails);
        const budget = Math.round(cumulativeCost);
        return {
            budget,
            reach,
            impressions,
            averageCpm: impressions > 0 ? Math.round((budget / impressions) * 1000) : 0,
            frequency: reach > 0 ? Math.round((impressions / reach) * 10) / 10 : null,
        };
    });

    const diminishingReturnsPoint = findDiminishingReturnsPoint(points);
    const optimalBudget = diminishingReturnsPoint?.budget ?? points[Math.floor(points.length / 2)].budget;

    return {
        points,
        recommendedBudget: {
            low: points[Math.floor(POINT_COUNT * 0.25)].budget,
            optimal: optimalBudget,
            high: points[points.length - 1].budget,
        },
        diminishingReturnsPoint,
        // Nothing was given to compare a verdict against — unlike the given-budget path below,
        // there's no "too-low/too-high" judgement to make here, only the market data itself.
        givenVsRecommended: null,
    };
};

/** The first point where marginal reach per rupee drops below 30% of the first segment's rate — past this, extra spend buys comparatively little extra reach. Shared by both curve paths. */
const findDiminishingReturnsPoint = (
    points: BudgetCurvePoint[]
): BudgetCurveResult['diminishingReturnsPoint'] => {
    if (points.length < 2) return null;
    const firstMarginalRate = (points[1].reach - points[0].reach) / (points[1].budget - points[0].budget || 1);
    for (let i = 1; i < points.length; i++) {
        const marginalRate =
            (points[i].reach - points[i - 1].reach) / (points[i].budget - points[i - 1].budget || 1);
        if (firstMarginalRate > 0 && marginalRate < firstMarginalRate * 0.3) {
            return { budget: points[i].budget, reach: points[i].reach };
        }
    }
    return null;
};

/** Re-runs the real allocation engine at several budget levels around the one given — not a fitted curve, the actual plan the engine would produce at each level. */
export const buildBudgetCurve = (
    candidates: CandidateResult,
    input: PlannerInput
): BudgetCurveResult => {
    if (input.campaign.budget === null || input.campaign.budget <= 0) {
        return buildMarketBudgetCurve(candidates);
    }

    const givenBudget = input.campaign.budget;
    const multipliers = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const points: BudgetCurvePoint[] = multipliers.map(m => {
        const budget = Math.round(givenBudget * m);
        const core = buildPlanCore(candidates, { ...input, campaign: { ...input.campaign, budget } });
        return {
            budget,
            reach: core.keyFigures.estimatedReach,
            impressions: core.keyFigures.estimatedImpressions,
            averageCpm: core.keyFigures.averageCpm,
            frequency: core.keyFigures.estimatedFrequency,
        };
    });

    const diminishingReturnsPoint = findDiminishingReturnsPoint(points);
    const optimalBudget = diminishingReturnsPoint?.budget ?? points[Math.floor(points.length / 2)].budget;
    const recommendedBudget = {
        low: points[1].budget, // 50%
        optimal: optimalBudget,
        high: points[points.length - 2].budget, // 175%
    };

    const optimalPoint = points.find(p => p.budget === optimalBudget) ?? points[Math.floor(points.length / 2)];
    const givenPoint = points.find(p => p.budget === givenBudget) ?? points[3]; // multiplier 1
    const diff = optimalBudget > 0 ? ((givenBudget - optimalBudget) / optimalBudget) * 100 : 0;
    const verdict: Verdict = diff < -10 ? 'too-low' : diff > 10 ? 'too-high' : 'about-right';
    const reachDiff =
        optimalPoint.reach > 0 ? ((givenPoint.reach - optimalPoint.reach) / optimalPoint.reach) * 100 : 0;
    const costPer1000Reached = givenPoint.reach > 0 ? Math.round((givenBudget / givenPoint.reach) * 1000) : 0;

    return {
        points,
        recommendedBudget,
        diminishingReturnsPoint,
        givenVsRecommended: {
            verdict,
            reachDifferencePercent: Math.round(reachDiff * 10) / 10,
            costPer1000Reached,
        },
    };
};
