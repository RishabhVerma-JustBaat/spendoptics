/**
 * Both curves are pure computation over the real candidate shortlist — no LLM involvement,
 * consistent with allocation.service.ts's "every number is deterministic" rule. The CPM curve
 * reads directly off the shortlist's own CPM distribution; the budget curve re-runs
 * allocation.service.ts's buildPlanCore at several budget levels against the same shortlist —
 * the "range of budgets around the one the user gave" approach, not a fitted formula.
 */
import { CandidateResult } from './candidate-inventory.service';
import { buildPlanCore } from './allocation.service';
import { PlannerInput } from '../types/ai-planner.types';

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

/** Re-runs the real allocation engine at several budget levels around the one given — not a fitted curve, the actual plan the engine would produce at each level. */
export const buildBudgetCurve = (
    candidates: CandidateResult,
    input: PlannerInput
): BudgetCurveResult => {
    if (input.campaign.budget === null || input.campaign.budget <= 0) {
        return { points: [], recommendedBudget: null, diminishingReturnsPoint: null, givenVsRecommended: null };
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

    // Diminishing returns: the first point where the marginal reach gained per rupee spent
    // drops below 30% of the very first marginal rate (25% -> 50% of budget) — past this, extra
    // spend is adding comparatively little extra reach.
    let diminishingReturnsPoint: BudgetCurveResult['diminishingReturnsPoint'] = null;
    if (points.length >= 2) {
        const firstMarginalRate = (points[1].reach - points[0].reach) / (points[1].budget - points[0].budget);
        for (let i = 1; i < points.length; i++) {
            const marginalRate =
                (points[i].reach - points[i - 1].reach) / (points[i].budget - points[i - 1].budget || 1);
            if (firstMarginalRate > 0 && marginalRate < firstMarginalRate * 0.3) {
                diminishingReturnsPoint = { budget: points[i].budget, reach: points[i].reach };
                break;
            }
        }
    }

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
