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
import { buildPlanCore, campaignFrequency, MAX_FILL, maxSpendFor, reachAndAudience } from './allocation.service';
import { CalendarDay, GeneratedPlanCore, InventoryLine, PlannerInput } from '../types/planner.types';

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
export const buildCpmCurve = (candidates: CandidateResult, input: PlannerInput): CpmCurveResult => {
    const maxCpmGiven = input.inventory.maxCpm;
    const frequency = campaignFrequency(input);
    const allCandidates = Object.values(candidates.byLine).flat();
    if (allCandidates.length === 0) {
        return { points: [], recommendedCpm: null, givenVsRecommended: null };
    }

    const sorted = [...allCandidates].sort((a, b) => a.cpm - b.cpm);
    const totalAvails = sorted.reduce((sum, c) => sum + c.avails, 0);

    // Points are placed by share of inventory unlocked, not evenly across the min–max CPM range:
    // one expensive property with next to no avails (e.g. a ₹3,300 app among ₹150–250 CTV) used
    // to stretch the range so every real change happened between the first two points, and
    // recommendedCpm's fixed-position "low" landed above its share-based "optimal". Walking the
    // cheapest-first avails instead means an outlier only matters in proportion to its volume.
    const cpmAtShare = (share: number): number => {
        let cumulative = 0;
        for (const c of sorted) {
            cumulative += c.avails;
            if (cumulative >= totalAvails * share) return c.cpm;
        }
        return sorted[sorted.length - 1].cpm;
    };

    const caps = new Set<number>();
    for (let i = 1; i <= POINT_COUNT; i++) caps.add(cpmAtShare(i / POINT_COUNT));
    const points: CpmCurvePoint[] = [...caps].map(cpmCap => {
        const availableImpressions = sorted.filter(c => c.cpm <= cpmCap).reduce((sum, c) => sum + c.avails, 0);
        const { reach } = reachAndAudience(availableImpressions, frequency);
        return {
            cpmCap,
            availableImpressions,
            reach,
            shareOfInventoryUnlocked:
                totalAvails > 0 ? Math.round((availableImpressions / totalAvails) * 1000) / 10 : 0,
        };
    });

    // Same share-of-inventory yardstick for all three, so low ≤ optimal ≤ high always holds:
    // half the market, the 80% point past which raising the cap buys comparatively little extra
    // supply, and nearly all of it.
    const recommendedCpm = {
        low: cpmAtShare(0.5),
        optimal: cpmAtShare(0.8),
        high: cpmAtShare(0.95),
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
const buildMarketBudgetCurve = (candidates: CandidateResult, frequency: number): BudgetCurveResult => {
    const allCandidates = Object.values(candidates.byLine).flat();
    if (allCandidates.length === 0) {
        return { points: [], recommendedBudget: null, diminishingReturnsPoint: null, givenVsRecommended: null };
    }

    const sorted = [...allCandidates].sort((a, b) => a.cpm - b.cpm);
    // Same realistic ceiling the allocation engine uses — no buyer gets more than MAX_FILL of a property.
    const totalAvails = sorted.reduce((sum, c) => sum + c.avails * MAX_FILL, 0);
    const shares = Array.from({ length: POINT_COUNT }, (_, i) => (i + 1) / POINT_COUNT);

    const points: BudgetCurvePoint[] = shares.map(share => {
        const targetAvails = totalAvails * share;
        let cumulativeAvails = 0;
        let cumulativeCost = 0;
        for (const c of sorted) {
            if (cumulativeAvails >= targetAvails) break;
            // A real buyer doesn't have to take a property's entire pool — take only the slice
            // needed to land exactly on this point's target, at that property's own real CPM.
            // Without this, one outsized property (e.g. a single app with billions of avails)
            // jumps cumulativeAvails past several consecutive share-targets in one step, making
            // this point and the next few identical instead of a real curve.
            const take = Math.min(c.avails * MAX_FILL, targetAvails - cumulativeAvails);
            cumulativeAvails += take;
            cumulativeCost += (take / 1000) * c.cpm;
        }
        const impressions = Math.round(cumulativeAvails);
        const budget = Math.round(cumulativeCost);
        const { reach } = reachAndAudience(impressions, frequency);
        return {
            budget,
            reach,
            impressions,
            averageCpm: impressions > 0 ? Math.round((budget / impressions) * 1000) : 0,
            frequency: reach > 0 ? Math.round(frequency * 10) / 10 : null,
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

/** The start of the first segment whose marginal reach per rupee drops below 30% of the first segment's rate — past this point, extra spend buys comparatively little extra reach. Shared by both curve paths. */
const findDiminishingReturnsPoint = (
    points: BudgetCurvePoint[]
): BudgetCurveResult['diminishingReturnsPoint'] => {
    if (points.length < 2) return null;
    const firstMarginalRate = (points[1].reach - points[0].reach) / (points[1].budget - points[0].budget || 1);
    for (let i = 1; i < points.length; i++) {
        const marginalRate =
            (points[i].reach - points[i - 1].reach) / (points[i].budget - points[i - 1].budget || 1);
        if (firstMarginalRate > 0 && marginalRate < firstMarginalRate * 0.3) {
            return { budget: points[i - 1].budget, reach: points[i - 1].reach };
        }
    }
    return null;
};

/** Geometric budget steps from the bottom of the curve up to inventory saturation — packs most points into the rising part, where each step still buys real extra reach. */
const BUDGET_STEP_COUNT = 12;
const CURVE_START_MULTIPLIER = 0.25;
/** One point past saturation, so the curve visibly flattens at its peak instead of ending on it. */
const PAST_SATURATION_MULTIPLIER = 1.25;

/**
 * The budget past which the engine can't place another rupee: every candidate filled to its
 * MAX_FILL ceiling. Spillover can reach any candidate in the shortlist, not just the plan's
 * original picks, so this is the whole pool's buyable cost.
 */
const saturationBudget = (candidates: CandidateResult, givenBudget: number): number =>
    Math.max(
        givenBudget,
        Object.values(candidates.byLine)
            .flat()
            .reduce((sum, c) => sum + maxSpendFor(c), 0)
    );

const pointAtBudget = (candidates: CandidateResult, input: PlannerInput, budget: number): BudgetCurvePoint => {
    const core = buildPlanCore(candidates, { ...input, campaign: { ...input.campaign, budget } });
    return {
        budget,
        reach: core.keyFigures.estimatedReach,
        impressions: core.keyFigures.estimatedImpressions,
        averageCpm: core.keyFigures.averageCpm,
        frequency: core.keyFigures.estimatedFrequency,
    };
};

/**
 * Re-runs the real allocation engine at budget levels from a quarter of the given budget up to
 * where the selected inventory runs out — not a fitted curve, the actual plan the engine would
 * produce at each level. Reach is linear in spend until items start hitting their fill
 * ceilings, so a fixed 0.25×–2× window (all most briefs' budgets ever reached) drew a straight
 * line with no diminishing-returns point at all; the bend only exists out where inventory
 * saturates, so the range has to extend that far.
 */
export const buildBudgetCurve = (
    candidates: CandidateResult,
    input: PlannerInput
): BudgetCurveResult => {
    if (input.campaign.budget === null || input.campaign.budget <= 0) {
        return buildMarketBudgetCurve(candidates, campaignFrequency(input));
    }

    const givenBudget = input.campaign.budget;
    const start = givenBudget * CURVE_START_MULTIPLIER;
    const end = saturationBudget(candidates, givenBudget);
    const ratio = Math.pow(end / start, 1 / (BUDGET_STEP_COUNT - 1));
    const budgets = new Set<number>([givenBudget, Math.round(end * PAST_SATURATION_MULTIPLIER)]);
    for (let i = 0; i < BUDGET_STEP_COUNT; i++) {
        const step = start * Math.pow(ratio, i);
        // A step landing right next to the given budget adds a near-duplicate point, not information.
        if (Math.abs(step - givenBudget) / givenBudget > 0.1) budgets.add(Math.round(step));
    }
    const points = [...budgets].sort((a, b) => a - b).map(b => pointAtBudget(candidates, input, b));

    // A given budget is final (it already includes our margin — see planner.candidates.ts's
    // clientCpm), so the curve is only shown for context: no alternative budget is recommended
    // and the given one isn't judged against one. Spillover keeps reach climbing efficiently
    // far past any realistic spend, so a curve-derived "optimal" said "too-low" on nearly every
    // brief anyway.
    return {
        points,
        recommendedBudget: null,
        diminishingReturnsPoint: findDiminishingReturnsPoint(points),
        givenVsRecommended: null,
    };
};

// ============================================================================
// Best dates — from the calendar table (scripts/ingest-calendar.js): every possible flight
// window inside the calendar's coverage is scored by its average viewership multiplier,
// weighted by the plan's own channel mix, and the best non-overlapping ones are recommended.
// The narration call only writes each window's reason. Returns null when the calendar can't
// cover the flight (no data yet, or a flight longer than the covered run of days), and the
// narration call falls back to its own judgment.
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Flight length searched for when the input gives no dates. */
const DEFAULT_FLIGHT_DAYS = 7;
const MAX_WINDOWS = 3;

type Channel = 'ctv' | 'app' | 'web';

/** Which of the sheet's three multiplier columns each output line reads. */
const LINE_CHANNEL: Record<InventoryLine, Channel> = {
    'ctv-fast': 'ctv',
    'ctv-ott': 'ctv',
    'mobile-ott': 'app',
    'in-app': 'app',
    websites: 'web',
};

export interface ScoredWindow {
    startDate: string;
    endDate: string;
    score: number;
    viewershipMultiplier: number;
    events: string[];
}

export interface BestDatesResult {
    recommendedWindows: ScoredWindow[];
    /** Runs of days below typical-weekday viewership (weighted multiplier < 1) for this channel mix. */
    datesToAvoid: { startDate: string; endDate: string; viewershipMultiplier: number; events: string[] }[];
    givenVsBest: string | null;
}

const addDays = (iso: string, days: number): string => isoDay(new Date(new Date(iso).getTime() + days * DAY_MS));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Share of the plan's spend per channel. With no spend placed, the planned lines count equally; with no lines, all three channels do. */
const channelWeights = (core: GeneratedPlanCore): Record<Channel, number> => {
    const weights: Record<Channel, number> = { ctv: 0, app: 0, web: 0 };
    const total = core.budgetAllocation.reduce((sum, l) => sum + l.amount, 0);
    for (const line of core.budgetAllocation) {
        weights[LINE_CHANNEL[line.inventoryLine]] += total > 0 ? line.amount / total : 1 / core.budgetAllocation.length;
    }
    if (core.budgetAllocation.length === 0) return { ctv: 1 / 3, app: 1 / 3, web: 1 / 3 };
    return weights;
};

const flightDays = (input: PlannerInput): number => {
    const { startDate, endDate } = input.campaign;
    if (!startDate || !endDate) return DEFAULT_FLIGHT_DAYS;
    const days = Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / DAY_MS) + 1;
    return days >= 1 ? days : DEFAULT_FLIGHT_DAYS;
};

/** Splits the calendar into runs of consecutive dates — a window can't span a gap with no data. */
const consecutiveRuns = (days: CalendarDay[]): CalendarDay[][] => {
    const runs: CalendarDay[][] = [];
    for (const day of days) {
        const run = runs[runs.length - 1];
        if (run && addDays(run[run.length - 1].date, 1) === day.date) run.push(day);
        else runs.push([day]);
    }
    return runs;
};

const eventsIn = (days: CalendarDay[]): string[] =>
    days.filter(d => d.event !== null).map(d => `${d.date}: ${d.event}`);

const formatRange = (startDate: string, endDate: string): string =>
    startDate === endDate ? startDate : `${startDate} to ${endDate}`;

export const buildBestDates = (
    input: PlannerInput,
    core: GeneratedPlanCore,
    calendar: CalendarDay[]
): BestDatesResult | null => {
    const length = flightDays(input);
    const weights = channelWeights(core);
    const dayMultiplier = (d: CalendarDay): number =>
        weights.ctv * d.multipliers.ctv + weights.app * d.multipliers.app + weights.web * d.multipliers.web;

    const runs = consecutiveRuns(calendar);
    const windows: (ScoredWindow & { days: CalendarDay[] })[] = [];
    for (const run of runs) {
        for (let i = 0; i + length <= run.length; i++) {
            const days = run.slice(i, i + length);
            windows.push({
                startDate: days[0].date,
                endDate: days[days.length - 1].date,
                score: 0,
                viewershipMultiplier: days.reduce((sum, d) => sum + dayMultiplier(d), 0) / length,
                events: eventsIn(days),
                days,
            });
        }
    }
    if (windows.length === 0) return null;

    // Score = share of all possible windows this one beats, so 100 is the best the calendar
    // allows for this flight length and channel mix — relative, not a viewership figure.
    const sortedValues = windows.map(w => w.viewershipMultiplier).sort((a, b) => a - b);
    for (const w of windows) {
        const beaten = sortedValues.filter(v => v < w.viewershipMultiplier).length;
        w.score = windows.length === 1 ? 100 : Math.round((100 * beaten) / (windows.length - 1));
    }

    // Best first (earlier date on ties), then greedily skip any window overlapping one already picked.
    const ranked = [...windows].sort(
        (a, b) => b.viewershipMultiplier - a.viewershipMultiplier || a.startDate.localeCompare(b.startDate)
    );
    const picked: typeof windows = [];
    for (const w of ranked) {
        if (picked.length === MAX_WINDOWS) break;
        if (picked.every(p => w.endDate < p.startDate || w.startDate > p.endDate)) picked.push(w);
    }

    const datesToAvoid: BestDatesResult['datesToAvoid'] = [];
    for (const run of runs) {
        let low: CalendarDay[] = [];
        const flush = () => {
            if (low.length === 0) return;
            datesToAvoid.push({
                startDate: low[0].date,
                endDate: low[low.length - 1].date,
                viewershipMultiplier: round2(low.reduce((sum, d) => sum + dayMultiplier(d), 0) / low.length),
                events: eventsIn(low),
            });
            low = [];
        };
        for (const day of run) {
            if (dayMultiplier(day) < 1) low.push(day);
            else flush();
        }
        flush();
    }

    const best = picked[0];
    const { startDate, endDate } = input.campaign;
    let givenVsBest: string | null = null;
    if (startDate && endDate) {
        const given = windows.find(w => w.startDate === startDate && w.endDate === endDate);
        givenVsBest = given
            ? `Your flight (${formatRange(startDate, endDate)}) averages ${round2(given.viewershipMultiplier)}x typical-weekday viewership for this channel mix, against ${round2(best.viewershipMultiplier)}x for the top window (${formatRange(best.startDate, best.endDate)}).`
            : `Your flight (${formatRange(startDate, endDate)}) falls outside the viewership calendar (${calendar[0].date} to ${calendar[calendar.length - 1].date}), so it can't be compared.`;
    }

    return {
        recommendedWindows: picked.map(({ days, ...w }) => ({ ...w, viewershipMultiplier: round2(w.viewershipMultiplier) })),
        datesToAvoid,
        givenVsBest,
    };
};
