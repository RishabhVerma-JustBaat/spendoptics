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
    CpmFitResult,
    DeliveryFitResult,
    GeneratedPlanCore,
    InventoryLine,
    KpiFitResult,
    Platform,
    PlannerInput,
    RecommendedInventoryItem,
    Role,
} from '../types/planner.types';
import {
    CandidateResult,
    computePriceUplift,
    computeRateTier,
    DEFAULT_UNSAFE_KEYWORDS,
    PLATFORM_LINE_MAP,
} from './planner.candidates';
import { config } from '../config/environment';

/** Normalizes a value into [0, 1] against the max in its set — 0 if every value in the set is 0. */
const normalize = (value: number, max: number): number => (max > 0 ? value / max : 0);

/**
 * How attractive one candidate is, before preferred adjustments. matchScore (semantic closeness
 * to the prompt and the selected interests + audience, plus the IAB match — see
 * planner.candidates.ts's scoreMatches) is the strongest single signal in every mode, so
 * better-matching inventory ranks higher and is poured more budget. The rest depends on
 * plannerSettings.optimiseFor: volume, price, or the "low trust" signals (VCR, unique audience),
 * which are real but only exist for some lines — "viewability" falls back to the same formula
 * as "quality" since no ingested sheet has a viewability column to optimise against at all.
 */
const scoreCandidate = (
    candidate: CandidateInventoryItem,
    maxAvails: number,
    maxCpm: number,
    optimiseFor: PlannerInput['plannerSettings']['optimiseFor']
): number => {
    const reachScore = normalize(candidate.avails, maxAvails);
    const costEfficiencyScore = 1 - normalize(candidate.cpm, maxCpm); // cheaper = higher score
    const match = candidate.matchScore;

    // vcr is a 0-100 percentage (see projectKpiFit's comment), not 0-1 — divide before blending
    // it into a 0-1 score.
    const lowTrustScore =
        (candidate.vcr !== null ? candidate.vcr / 100 : 0.5) * 0.5 +
        (candidate.uniqueAudience !== null ? 0.5 : 0.25);

    switch (optimiseFor) {
        case 'reach':
            return reachScore * 0.6 + match * 0.4;
        case 'cost-efficiency':
            return costEfficiencyScore * 0.6 + match * 0.4;
        case 'quality':
        case 'viewability':
            return lowTrustScore * 0.6 + match * 0.4;
        case 'balanced':
        default:
            return match * 0.4 + reachScore * 0.2 + costEfficiencyScore * 0.2 + lowTrustScore * 0.2;
    }
};

const assignRole = (candidate: CandidateInventoryItem, maxAvails: number, minCpm: number): Role => {
    if (candidate.isPreferred) return 'preferred';
    if (candidate.avails === maxAvails) return 'reach-driver';
    if (candidate.cpm === minCpm) return 'cost-efficient';
    if (candidate.vcr !== null || candidate.uniqueAudience !== null) return 'quality-anchor';
    return 'audience-fit';
};

/** Items a line grows to when maxRecommendationsPerLine is null (budget-sized) — past this, further items only join as 'spillover'. */
const BUDGET_SIZED_MAX_ITEMS = 25;
/**
 * Budget-sized lines start with one item per this much of the line's budget, between 1 and
 * BUDGET_SIZED_START_ITEMS — most properties are far larger than a plan can buy 10% of, so
 * without a starting spread a big budget would sit on one property waiting for it to fill.
 */
const SPEND_PER_STARTING_ITEM = 50_000;
const BUDGET_SIZED_START_ITEMS = 5;
/** How many of a line's best items its score sums over, for the cross-line budget split — fixed, so a budget-sized line isn't scored on its 1 starting item. */
const LINE_SCORE_DEPTH = 8;

/** Item count for a line: the stated count, or the budget-sized ceiling; "concentrated" caps either at a handful of bigger placements. */
const effectiveMaxForLine = (input: PlannerInput): number => {
    const cap = input.plannerSettings.maxRecommendationsPerLine ?? BUDGET_SIZED_MAX_ITEMS;
    if (input.plannerSettings.diversification === 'concentrated') return Math.min(cap, 3);
    return cap;
};

interface Placement {
    candidate: CandidateInventoryItem;
    score: number;
    role: Role;
    /** Client-price rupees placed on this item so far. */
    spent: number;
}

interface LineSelection {
    line: InventoryLine;
    items: Placement[];
    /** The rest of the line's candidates in rank order — pulled in one at a time once the current items reach their target buy %. */
    reserves: { candidate: CandidateInventoryItem; score: number }[];
    lineScore: number;
    /** Reserves join with a real role up to this many items, as 'spillover' past it. */
    maxItems: number;
    /** True when maxRecommendationsPerLine is null: pourIntoLine sets the starting count from the money it's given. */
    budgetSized: boolean;
    maxAvails: number;
    minCpm: number;
}

const selectForLine = (
    line: InventoryLine,
    candidates: CandidateInventoryItem[],
    input: PlannerInput
): LineSelection => {
    if (candidates.length === 0) return { line, items: [], reserves: [], lineScore: 0, maxItems: 0, budgetSized: false, maxAvails: 0, minCpm: 0 };

    const maxAvails = Math.max(...candidates.map(c => c.avails));
    const maxCpm = Math.max(...candidates.map(c => c.cpm));
    const minCpm = Math.min(...candidates.map(c => c.cpm));

    const scored = candidates
        .map(c => ({
            candidate: c,
            // The 1.2x boost still shapes ranking among preferred items themselves, but isn't
            // what guarantees inclusion below — verified live that a boost alone wasn't enough
            // for a specifically-named property (e.g. WSJ) to survive into the top N against
            // real CPM/avails competition from unrelated inventory.
            score:
                scoreCandidate(c, maxAvails, maxCpm, input.plannerSettings.optimiseFor) * (c.isPreferred ? 1.2 : 1),
        }))
        .sort((a, b) => b.score - a.score);

    // A preferred item is a literal name match against inventory.preferredSitesApps — the brief
    // asked about it by name, so it's guaranteed a slot regardless of how it scores against
    // unrelated inventory, same as this line's old must-include guarantee worked before that
    // field was removed. Everyone else still competes normally for whatever slots are left.
    const preferred = scored.filter(s => s.candidate.isPreferred);
    const rest = scored.filter(s => !s.candidate.isPreferred);

    const cap = effectiveMaxForLine(input);
    // A stated count is picked up front. Budget-sized starts from the preferred items only;
    // pourIntoLine adds the rest from the reserves once it knows the line's money.
    const pickCount =
        input.plannerSettings.maxRecommendationsPerLine === null
            ? Math.min(preferred.length > 0 ? 0 : 1, cap)
            : Math.max(cap - preferred.length, 0);
    const picked = [...preferred, ...rest.slice(0, pickCount)];

    const items = picked.map(p => ({
        candidate: p.candidate,
        score: p.score,
        role: assignRole(p.candidate, maxAvails, minCpm),
        spent: 0,
    }));

    // Line-level attractiveness for the cross-line budget split below — sum rather than average,
    // so a line with more good real inventory earns a bigger share, not just a higher per-item one.
    const lineScore = scored.slice(0, Math.min(cap, LINE_SCORE_DEPTH)).reduce((sum, i) => sum + i.score, 0);

    return { line, items, reserves: rest.slice(pickCount), lineScore,
        maxItems: cap,
        budgetSized: input.plannerSettings.maxRecommendationsPerLine === null,
        maxAvails,
        minCpm,
    };
};

/**
 * No plan can realistically buy all of a property's avails, so the more of it a plan has
 * already bought, the smaller the share of each further rupee it gets — the rest flows to
 * less-bought items. Each item has its own target buy % (targetFill, from how well it matches
 * — see planner.candidates.ts's scoreMatches): full weight up to it, then tapering steps, and
 * nothing past twice the target or MAX_FILL, whichever is lower.
 */
const FILL_TAPER = [
    { upToTarget: 1, weight: 1 },
    { upToTarget: 1.25, weight: 0.4 },
    { upToTarget: 1.5, weight: 0.2 },
    { upToTarget: 2, weight: 0.05 },
] as const;
export const MAX_FILL = 0.3;

/** The most of one item's avails a plan may buy. */
export const maxFillFor = (c: CandidateInventoryItem): number =>
    Math.min(MAX_FILL, c.targetFill * FILL_TAPER[FILL_TAPER.length - 1].upToTarget);

/** The most a plan can ever spend on one item: maxFillFor of its avails at its (client) CPM. */
export const maxSpendFor = (c: CandidateInventoryItem): number => (c.avails * maxFillFor(c) * c.cpm) / 1000;

/** Below a rupee of room left, an item counts as full — keeps pourIntoLine from looping on dust. */
const MIN_ROOM = 1;

/**
 * Budget is poured in two passes: 'target' fills every item only up to its target buy %
 * (widening lines and moving leftover to other lines first), 'cap' then lets items past their
 * targets, tapering, only for money nothing else had room for — so going over target is a
 * last resort, not a side effect of one line's share being bigger than its inventory.
 */
type PourPass = 'target' | 'cap';

const spendCeiling = (c: CandidateInventoryItem, pass: PourPass): number =>
    pass === 'target' ? (c.avails * Math.min(c.targetFill, MAX_FILL) * c.cpm) / 1000 : maxSpendFor(c);

const fillWeight = (p: Placement, pass: PourPass): number => {
    if (spendCeiling(p.candidate, pass) - p.spent < MIN_ROOM) return 0;
    const fill = (p.spent * 1000) / p.candidate.cpm / p.candidate.avails;
    return FILL_TAPER.find(t => fill < p.candidate.targetFill * t.upToTarget)?.weight ?? 0;
};

/** Money is poured in this many slices so fill tiers re-weight as items fill, rather than once up front. */
const POUR_STEPS = 100;

/**
 * Pours money into one line's items, each slice split by base weight × fill weight — "broad"
 * gives every item the same base weight, otherwise it's the item's score, so the top pick still
 * gets more than the last. Once no item is below its target buy % any more, the next-ranked
 * reserve joins at full weight and takes most of what follows — so a line only widens when its
 * items are genuinely full: a small budget stays on a few items, small items pull in more.
 * Joiners get a real role up to the line's item count, 'spillover' past it. Returns whatever
 * couldn't be placed because the whole line ran out.
 */
const pourIntoLine = (
    selection: LineSelection,
    money: number,
    diversification: PlannerInput['plannerSettings']['diversification'],
    pass: PourPass
): number => {
    const joinNext = () => {
        const next = selection.reserves.shift()!;
        const role =
            selection.items.length < selection.maxItems
                ? assignRole(next.candidate, selection.maxAvails, selection.minCpm)
                : 'spillover';
        selection.items.push({ ...next, role, spent: 0 });
    };
    if (selection.budgetSized) {
        const start = Math.min(
            Math.max(1, Math.floor(money / SPEND_PER_STARTING_ITEM)),
            BUDGET_SIZED_START_ITEMS,
            selection.maxItems
        );
        while (selection.items.length < start && selection.reserves.length > 0) joinNext();
    }

    const slice = money / POUR_STEPS;
    let remaining = money;
    while (remaining >= MIN_ROOM) {
        let weights = selection.items.map(p => fillWeight(p, pass));
        if (!weights.includes(1) && selection.reserves.length > 0) {
            joinNext();
            weights = selection.items.map(p => fillWeight(p, pass));
        }
        // Score can legitimately be 0 (every signal normalized to 0) — floor it so a full-weight
        // item still takes money rather than stalling the pour.
        const effective = weights.map((w, i) =>
            diversification === 'broad' ? w : w * Math.max(selection.items[i].score, 1e-6)
        );
        const total = effective.reduce((sum, w) => sum + w, 0);
        if (total === 0) break;

        const pour = Math.min(remaining, slice);
        selection.items.forEach((p, i) => {
            if (effective[i] === 0) return;
            const take = Math.min((pour * effective[i]) / total, spendCeiling(p.candidate, pass) - p.spent);
            p.spent += take;
            remaining -= take;
        });
    }
    return remaining < MIN_ROOM ? 0 : remaining;
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

/** The only feasibility check possible for a stated regional-delivery ask — see DeliveryFitResult's comment for why this can't be checked region by region. "meets" means the plan's real modelled delivery covers the stated total; "misses" means it falls meaningfully short. */
const computeDeliveryFit = (
    input: PlannerInput,
    estimatedImpressions: number
): DeliveryFitResult | null => {
    if (input.campaign.regionalTargets.length === 0) return null;
    const statedGoal = input.campaign.regionalTargets.reduce((sum, t) => sum + t.impressions, 0);
    if (statedGoal <= 0) return null;

    const ratio = estimatedImpressions / statedGoal;
    const verdict = ratio >= 1 ? 'meets' : ratio >= 0.85 ? 'close' : 'misses';
    return { statedGoal, projected: estimatedImpressions, verdict };
};

/**
 * Checks each stated per-channel rate ask against the real blended CPM the engine actually
 * found for that platform's line(s) — reusing PLATFORM_LINE_MAP so "which line does this
 * platform mean" is resolved identically to candidate matching, not a second, possibly-
 * inconsistent mapping. Weighted by each item's own real avails, not by the budget-derived
 * amount/impressions on BudgetAllocationLine — those are 0 whenever no budget was given at
 * all (a bare feasibility question, no spend to allocate), which would make this
 * un-computable for exactly the case it exists to answer. Lower achieved CPM than asked is
 * "meets" (cheaper than hoped), not "misses" — the ask is a ceiling, not an exact target.
 */
const computeCpmFit = (input: PlannerInput, budgetAllocation: BudgetAllocationLine[]): CpmFitResult[] => {
    const results: CpmFitResult[] = [];
    for (const { platform, maxCpm: target } of input.inventory.channelCpmTargets) {
        const lines = PLATFORM_LINE_MAP[platform];
        const items = budgetAllocation
            .filter(l => lines.includes(l.inventoryLine))
            .flatMap(l => l.recommendedInventory);
        const totalAvails = items.reduce((sum, i) => sum + i.avails, 0);
        if (totalAvails === 0) continue; // nothing selected for this platform at all

        const weightedCpmSum = items.reduce((sum, i) => sum + i.cpm * i.avails, 0);
        const actual = Math.round(weightedCpmSum / totalAvails);
        const ratio = actual / target;
        const verdict = ratio <= 1 ? 'meets' : ratio <= 1.15 ? 'close' : 'misses';
        results.push({ platform, target, actual, verdict });
    }
    return results;
};

/** Agreed planning rule: a campaign reaches 40% of the audience it's bought against, so audience = reach ÷ 0.4. */
export const REACH_SHARE_OF_AUDIENCE = 0.4;

/** Campaign-level frequency used when the brief gives no frequency cap. */
const DEFAULT_CAMPAIGN_FREQUENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Average impressions per reached person over the whole flight — the divisor in
 * reach = impressions ÷ frequency. A stated buying.frequencyCap wins, scaled from its period up
 * to the full flight (a 2/day cap over a 30-day flight is 60 per person); without flight dates
 * there's nothing to scale by, so the cap is taken as-is for the whole campaign, the
 * conservative reading.
 */
export const campaignFrequency = (input: PlannerInput): number => {
    const cap = input.buying.frequencyCap;
    if (!cap || cap.impressions <= 0) return DEFAULT_CAMPAIGN_FREQUENCY;

    const { startDate, endDate } = input.campaign;
    const flightDays =
        startDate && endDate
            ? Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / DAY_MS) + 1)
            : null;
    if (cap.period === 'campaign' || flightDays === null) return cap.impressions;

    const periodsInFlight = cap.period === 'day' ? flightDays : Math.ceil(flightDays / (cap.period === 'week' ? 7 : 30));
    return cap.impressions * periodsInFlight;
};

/** reach = impressions ÷ frequency, audience = reach ÷ REACH_SHARE_OF_AUDIENCE — the one place this chain is computed, so items, lines, key figures and both curves can't drift apart. */
export const reachAndAudience = (impressions: number, frequency: number): { reach: number; audience: number } => {
    const reach = Math.round(impressions / frequency);
    return { reach, audience: Math.round(reach / REACH_SHARE_OF_AUDIENCE) };
};

const PLATFORM_FOR_LINE: Record<InventoryLine, Platform> = {
    'ctv-fast': 'ctv-fast',
    'ctv-ott': 'ctv-ott',
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
    const pricing = computePriceUplift(input);
    const budget = input.campaign.budget ?? 0;
    const frequency = campaignFrequency(input);

    const selections = (Object.keys(candidates.byLine) as InventoryLine[])
        .map(line => selectForLine(line, candidates.byLine[line], input))
        .filter(s => s.items.length > 0);

    // Each line gets its score-weighted share first; whatever a line can't place (its whole pool
    // filled up) is re-poured across the lines that still have room, by the same weights, until
    // it's all placed or every line is full — first up to every item's target buy %, then (only
    // for what's still left) past it towards the caps. What's left after both is unspent.
    const lineShare = (open: LineSelection[], s: LineSelection): number => {
        const total = open.reduce((sum, o) => sum + o.lineScore, 0);
        return total > 0 ? s.lineScore / total : 1 / open.length;
    };
    const diversification = input.plannerSettings.diversification;
    let unplaced = budget;
    for (const pass of ['target', 'cap'] as const) {
        let open = selections;
        while (unplaced >= MIN_ROOM && open.length > 0) {
            const round = unplaced;
            const leftovers = open.map(s => pourIntoLine(s, round * lineShare(open, s), diversification, pass));
            unplaced = leftovers.reduce((sum, l) => sum + l, 0);
            open = open.filter((_, i) => leftovers[i] === 0);
        }
    }
    const unspentBudget = Math.round(Math.max(unplaced, 0));

    const budgetAllocation: BudgetAllocationLine[] = selections.map(selection => {
        const lineAmount = selection.items.reduce((sum, p) => sum + p.spent, 0);
        const sharePercent = budget > 0 ? Math.round((lineAmount / budget) * 100) : 0;

        const recommendedInventory: RecommendedInventoryItem[] = selection.items.map((item, i) => {
            const amount = item.spent;
            const impressions = Math.round((amount / item.candidate.cpm) * 1000);
            return {
                inventoryId: item.candidate.id,
                rank: i + 1,
                role: item.role,
                reason: null,
                name: item.candidate.name,
                environment: PLATFORM_FOR_LINE[selection.line],
                avails: item.candidate.avails,
                uniqueAudience: item.candidate.uniqueAudience,
                targetingFactor: item.candidate.targetingFactor,
                matchScore: item.candidate.matchScore,
                buyPercent: Math.round((impressions / item.candidate.avails) * 1000) / 10,
                cpm: item.candidate.cpm,
                vcr: item.candidate.vcr,
                amount: Math.round(amount),
                impressions,
                ...reachAndAudience(impressions, frequency),
            };
        });

        return {
            inventoryLine: selection.line,
            sharePercent,
            amount: recommendedInventory.reduce((sum, item) => sum + item.amount, 0),
            impressions: recommendedInventory.reduce((sum, item) => sum + item.impressions, 0),
            reach: recommendedInventory.reduce((sum, item) => sum + item.reach, 0),
            audience: recommendedInventory.reduce((sum, item) => sum + item.audience, 0),
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

    // Every candidate cpm already carries the flat margin and the targeting uplift
    // (planner.candidates.ts's clientCpm), so what the client pays splits back into media cost
    // and our commission by those same factors — the uplift is ours, not the publisher's.
    const clientSpend = budgetAllocation.reduce((sum, l) => sum + l.amount, 0);
    const mediaCost = Math.round(
        clientSpend / (1 + config.plannerMarginPercent / 100) / (1 + pricing.upliftPercent / 100)
    );

    // Reach and audience come from the agreed impressions → reach → audience chain (see
    // reachAndAudience), summed from the per-item figures so the totals reconcile exactly with
    // budgetAllocation. The sheets' own per-property uniques aren't used here: they overlap
    // across properties with no dedup data, and their max alone ran past India's population.
    const estimatedReach = budgetAllocation.reduce((sum, l) => sum + l.reach, 0);
    const estimatedAudience = budgetAllocation.reduce((sum, l) => sum + l.audience, 0);

    const kpiFit: KpiFitResult[] = input.campaign.kpis.map(k =>
        projectKpiFit(k.metric, k.target, allSelectedCandidates)
    );
    const deliveryFit = computeDeliveryFit(input, estimatedImpressions);
    const cpmFit = computeCpmFit(input, budgetAllocation);

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
            uniqueAudience: estimatedAudience > 0 ? estimatedAudience : null,
            estimatedAvails,
            estimatedImpressions,
            averageCpm,
            estimatedFrequency: estimatedReach > 0 ? Math.round(frequency * 10) / 10 : null,
        },
        flight: {
            startDate: input.campaign.startDate,
            endDate: input.campaign.endDate,
            pacing: input.campaign.pacing,
        },
        rateTier: tier,
        pricing,
        budgetAllocation,
        plannedByTeam,
        kpiFit,
        deliveryFit,
        cpmFit,
        inventoryWarnings: candidates.inventoryWarnings,
        buying: {
            dealType: input.buying.dealType,
            dspCompatible: input.buying.dspChoice !== null,
            rateCard: tier,
        },
        unspentBudget,
        // User-configurable exclusion lists (categoriesToAvoid/brandSafetyExclusions) were
        // removed from the input form — only the hardcoded keyword floor (planner.candidates.ts)
        // still applies, to every plan, unconditionally.
        brandSafety: {
            exclusionsApplied: [...DEFAULT_UNSAFE_KEYWORDS],
        },
        internal: {
            marginPercent: config.plannerMarginPercent,
            clientSpend,
            mediaCost,
            commission: clientSpend - mediaCost,
        },
    };
};
