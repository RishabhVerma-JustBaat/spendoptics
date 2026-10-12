/**
 * Stage 2+3 of Call 2 ("generate") — deterministic selection, ranking, and budget allocation
 * across the real candidate shortlist (planner.candidates.ts), plus every numeric
 * output (reach, impressions, CPM, kpi_fit). None of this is an LLM call.
 *
 * Why: an LLM asked to both pick inventory AND decide how much budget goes where introduces
 * run-to-run variance into the actual plan, not just its wording — the same input could
 * recommend a different site or a different split on a re-run. Scoring and allocation are
 * formulas instead, so the same input always produces the same plan; the one remaining LLM
 * call (planner.prompts.ts's narration call) only writes text describing decisions already
 * made here, which bounds any variance to phrasing.
 */
import {
    BudgetAllocationLine,
    CandidateInventoryItem,
    GeneratedPlanCore,
    InventoryLine,
    KpiFitResult,
    Platform,
    PlannerInput,
    RecommendedInventoryItem,
    Role,
} from '../types/planner.types';
import { CandidateResult, computeRateTier } from './planner.candidates';

/** Normalizes a value into [0, 1] against the max in its set — 0 if every value in the set is 0. */
const normalize = (value: number, max: number): number => (max > 0 ? value / max : 0);

/**
 * How attractive one candidate is, before must-include/preferred adjustments. The weighting
 * depends on plannerSettings.optimiseFor — "viewability" falls back to the same formula as
 * "quality" since no ingested sheet has a viewability column to optimise against at all.
 */
const scoreCandidate = (
    candidate: CandidateInventoryItem,
    maxAvails: number,
    maxCpm: number,
    optimiseFor: PlannerInput['plannerSettings']['optimiseFor']
): number => {
    const reachScore = normalize(candidate.avails, maxAvails);
    const costEfficiencyScore = 1 - normalize(candidate.cpm, maxCpm); // cheaper = higher score
    const qualityScore =
        (candidate.vcr !== null ? candidate.vcr : 0.5) * 0.5 +
        (candidate.uniqueAudience !== null ? 0.5 : 0.25);

    switch (optimiseFor) {
        case 'reach':
            return reachScore;
        case 'cost-efficiency':
            return costEfficiencyScore;
        case 'quality':
        case 'viewability':
            return qualityScore;
        case 'balanced':
        default:
            return reachScore * 0.4 + costEfficiencyScore * 0.4 + qualityScore * 0.2;
    }
};

const assignRole = (
    candidate: CandidateInventoryItem,
    selected: CandidateInventoryItem[],
    maxAvails: number,
    minCpm: number
): Role => {
    if (candidate.isMustInclude) return 'must-include';
    if (candidate.isPreferred) return 'preferred';
    if (candidate.avails === maxAvails) return 'reach-driver';
    if (candidate.cpm === minCpm) return 'cost-efficient';
    if (candidate.vcr !== null || candidate.uniqueAudience !== null) return 'quality-anchor';
    return 'audience-fit';
};

/** "concentrated" caps how many items a line can spread across, regardless of maxRecommendationsPerLine — a handful of bigger placements rather than many small ones. */
const effectiveMaxForLine = (input: PlannerInput): number => {
    const cap = input.plannerSettings.maxRecommendationsPerLine;
    if (input.plannerSettings.diversification === 'concentrated') return Math.min(cap, 3);
    return cap;
};

interface LineSelection {
    line: InventoryLine;
    items: { candidate: CandidateInventoryItem; score: number; role: Role }[];
    lineScore: number;
}

const selectForLine = (
    line: InventoryLine,
    candidates: CandidateInventoryItem[],
    input: PlannerInput
): LineSelection => {
    if (candidates.length === 0) return { line, items: [], lineScore: 0 };

    const maxAvails = Math.max(...candidates.map(c => c.avails));
    const maxCpm = Math.max(...candidates.map(c => c.cpm));
    const minCpm = Math.min(...candidates.map(c => c.cpm));

    const scored = candidates.map(c => ({
        candidate: c,
        // Preferred gets a flat boost rather than its own weighting term — nice-to-have, not a
        // hard requirement, so it nudges ranking without dominating the formula.
        score:
            scoreCandidate(c, maxAvails, maxCpm, input.plannerSettings.optimiseFor) *
            (c.isPreferred ? 1.2 : 1),
    }));

    const mustIncludes = scored.filter(s => s.candidate.isMustInclude);
    const rest = scored
        .filter(s => !s.candidate.isMustInclude)
        .sort((a, b) => b.score - a.score);

    const cap = effectiveMaxForLine(input);
    const slotsLeftAfterMustIncludes = Math.max(cap - mustIncludes.length, 0);
    const picked = [...mustIncludes, ...rest.slice(0, slotsLeftAfterMustIncludes)];

    const items = picked.map(p => ({
        candidate: p.candidate,
        score: p.score,
        role: assignRole(p.candidate, picked.map(x => x.candidate), maxAvails, minCpm),
    }));

    // Line-level attractiveness for the cross-line budget split below — sum rather than average,
    // so a line with more good real inventory earns a bigger share, not just a higher per-item one.
    const lineScore = items.reduce((sum, i) => sum + i.score, 0);

    return { line, items, lineScore };
};

/** "broad" splits a line's budget evenly across its picks; otherwise spend follows score, so the top pick gets more than the last. */
const splitWithinLine = (
    items: LineSelection['items'],
    lineAmount: number,
    diversification: PlannerInput['plannerSettings']['diversification']
): number[] => {
    if (items.length === 0) return [];
    if (diversification === 'broad') return items.map(() => lineAmount / items.length);

    const totalScore = items.reduce((sum, i) => sum + i.score, 0);
    if (totalScore === 0) return items.map(() => lineAmount / items.length);
    return items.map(i => (i.score / totalScore) * lineAmount);
};

const projectKpiFit = (
    metric: 'vcr' | 'ctr',
    target: number | null,
    selected: CandidateInventoryItem[]
): KpiFitResult => {
    if (metric === 'ctr') {
        // No ingested sheet has a CTR column at all — never invented.
        return { metric, target, projected: null, verdict: 'not-measurable', comment: null };
    }
    const withVcr = selected.filter(c => c.vcr !== null);
    if (withVcr.length === 0) {
        return { metric, target, projected: null, verdict: 'not-measurable', comment: null };
    }
    // vcr is already a 0-100 percentage (normalized at ingestion — see ingest-inventory.js),
    // not a 0-1 fraction, so this is a straight average, not a ×100 conversion.
    const avgVcr = withVcr.reduce((sum, c) => sum + (c.vcr ?? 0), 0) / withVcr.length;
    const projected = Math.round(avgVcr * 10) / 10; // 1dp
    if (target === null) {
        return { metric, target, projected, verdict: 'not-measurable', comment: null };
    }
    const ratio = projected / target;
    const verdict = ratio >= 1 ? 'meets' : ratio >= 0.85 ? 'close' : 'misses';
    return { metric, target, projected, verdict, comment: null };
};

const PLATFORM_FOR_LINE: Record<InventoryLine, Platform> = {
    'ctv-oem-fast': 'ctv',
    'mobile-ott': 'mobile-ott',
    websites: 'web',
    'in-app': 'in-app',
};

/**
 * The deterministic core of the generated plan. Narration text (reason/title/summary/
 * assumptions) is left null/empty here and filled in afterward by the narration LLM call —
 * this function only ever decides numbers and selections.
 */
export const buildPlanCore = (candidates: CandidateResult, input: PlannerInput): GeneratedPlanCore => {
    const tier = computeRateTier(input);
    const budget = input.campaign.budget ?? 0;

    const selections = (Object.keys(candidates.byLine) as InventoryLine[])
        .map(line => selectForLine(line, candidates.byLine[line], input))
        .filter(s => s.items.length > 0);

    const totalLineScore = selections.reduce((sum, s) => sum + s.lineScore, 0);

    const budgetAllocation: BudgetAllocationLine[] = selections.map(selection => {
        const sharePercent =
            totalLineScore > 0
                ? Math.round((selection.lineScore / totalLineScore) * 100)
                : Math.round(100 / selections.length);
        const lineAmount = budget * (sharePercent / 100);
        const perItemAmounts = splitWithinLine(selection.items, lineAmount, input.plannerSettings.diversification);

        const recommendedInventory: RecommendedInventoryItem[] = selection.items.map((item, i) => ({
            inventoryId: item.candidate.id,
            rank: i + 1,
            role: item.role,
            reason: null,
            name: item.candidate.name,
            environment: PLATFORM_FOR_LINE[selection.line],
            avails: item.candidate.avails,
            uniqueAudience: item.candidate.uniqueAudience,
            cpm: item.candidate.cpm,
            vcr: item.candidate.vcr,
        }));

        const lineImpressions = selection.items.reduce((sum, item, i) => {
            const amount = perItemAmounts[i];
            const uncapped = Math.round((amount / item.candidate.cpm) * 1000);
            // Never claim to deliver more than the real avails ceiling for that item.
            return sum + Math.min(uncapped, item.candidate.avails);
        }, 0);

        return {
            inventoryLine: selection.line,
            sharePercent,
            amount: Math.round(lineAmount),
            impressions: lineImpressions,
            reason: null,
            recommendedInventory,
        };
    });

    const allSelectedCandidates = selections.flatMap(s => s.items.map(i => i.candidate));
    const estimatedImpressions = budgetAllocation.reduce((sum, l) => sum + l.impressions, 0);
    const estimatedAvails = allSelectedCandidates.reduce((sum, c) => sum + c.avails, 0);
    const totalCpmWeighted = budgetAllocation.reduce((sum, l) => sum + l.amount, 0);
    const averageCpm =
        estimatedImpressions > 0 ? Math.round((totalCpmWeighted / estimatedImpressions) * 1000) : 0;

    // "uniques" per row means distinct people who saw THAT property — the same person can (and
    // routinely does) show up in more than one property's own unique count (someone who watches
    // both JioHotstar and Zee5 is counted once in each). Summing across properties therefore
    // overcounts true reach by an unknown amount, and we have no cross-property overlap data to
    // correct for it. The only number we can actually stand behind without inventing a dedup
    // coefficient is the single largest property's own uniques — real reach is somewhere
    // between that floor and the (overcounted) sum, and max is the end of that range we can
    // defend as "at least this many distinct people." No cap applied on top of that — trusting
    // the sheet's own figures as given, even where a single row looks large.
    const knownUniqueCeiling = Math.max(
        0,
        ...allSelectedCandidates.map(c => c.uniqueAudience ?? 0)
    );
    const estimatedReach =
        knownUniqueCeiling > 0 ? Math.min(estimatedImpressions, knownUniqueCeiling) : estimatedImpressions;

    const kpiFit: KpiFitResult[] = input.campaign.kpis.map(k =>
        projectKpiFit(k.metric, k.target, allSelectedCandidates)
    );

    const plannedByTeam = candidates.unplannablePlatforms.map(platform => ({
        platform,
        reason:
            platform === 'youtube'
                ? 'No real inventory data behind this platform — needs manual handling.'
                : 'No matching real inventory found for the given filters.',
    }));

    return {
        keyFigures: {
            estimatedReach,
            uniqueAudience: knownUniqueCeiling > 0 ? knownUniqueCeiling : null,
            estimatedAvails,
            estimatedImpressions,
            averageCpm,
            estimatedFrequency:
                estimatedReach > 0 ? Math.round((estimatedImpressions / estimatedReach) * 10) / 10 : null,
        },
        flight: {
            startDate: input.campaign.startDate,
            endDate: input.campaign.endDate,
            pacing: input.campaign.pacing,
        },
        rateTier: tier,
        budgetAllocation,
        plannedByTeam,
        kpiFit,
        buying: {
            dealType: input.buying.dealType,
            dspCompatible: input.buying.dspChoice !== null,
            rateCard: tier,
        },
        brandSafety: {
            exclusionsApplied: [
                ...input.inventory.categoriesToAvoid,
                ...input.inventory.brandSafetyExclusions,
            ],
        },
    };
};
