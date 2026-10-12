import { z } from 'zod';
import { generateStructured } from '../services/bedrock.service';
import {
    CurveCommentary,
    GeneratedPlan,
    GeneratedPlanCore,
    PlanNarration,
    PlannerInput,
    TARGET_GROUP_TYPES,
} from '../types/ai-planner.types';
import { BudgetCurveResult, CpmCurveResult } from '../services/curves.service';

/**
 * The only LLM call in Call 2 ("generate") — everything it's given (the candidate selections,
 * the budget split, every number) was already decided by candidate-inventory.service.ts /
 * allocation.service.ts. This call never chooses anything; it only writes the text explaining
 * choices already made, which is why it runs at a low temperature (see bedrock.service.ts) —
 * describing fixed facts doesn't benefit from the creativity a higher temperature buys, and a
 * narration call drifting at temperature 1.0 is exactly the kind of variance this flow was
 * redesigned to avoid.
 *
 * Schema is flat "a::b" strings, not nested objects — the same reasoning as plan-prompts.ts's
 * assumedDefaults: object-shaped array items are the biggest known contributor to Bedrock's
 * grammar-size ceiling, and there's no reason to risk it for what's fundamentally a batch of
 * labelled strings.
 */
const buildNarrationSchema = () =>
    z.object({
        title: z.string(),
        summary: z.string(),
        // "type::value" — type is one of TARGET_GROUP_TYPES, enforced by prompt + a post-parse filter.
        targetGroup: z.array(z.string()),
        // "line::reason" — line is one of the real inventory lines that got a budget share.
        lineReasons: z.array(z.string()),
        // "line|inventoryId::reason" — the same real inventory id can legitimately appear
        // under more than one line (e.g. JioHotstar is a real row in both the CTV and Mobile
        // OTT tables), so the id alone isn't a unique key — line is part of it too.
        itemReasons: z.array(z.string()),
        assumptions: z.array(z.string()),
        // "startDate::endDate::score::reason" — Best Dates has no historical avails/CPM
        // time-series or events-calendar data behind it at all, so unlike everything else in
        // this call, "score" here is the model's own judgment, not a system computation — a
        // deliberate, scoped exception (see this file's top comment and the product decision
        // that Best Dates runs on AI reasoning until that data exists).
        recommendedWindows: z.array(z.string()),
        // "startDate::endDate::reason" — same 3-field shape as recommendedWindows (minus the
        // score) rather than a single "dateRange" field, since a date range naturally wants
        // its own "start::end"-shaped separator and that collided with the "::reason"
        // separator when tried as one combined field.
        datesToAvoid: z.array(z.string()),
        givenVsBest: z.string().nullable(),
    });

const buildNarrationSystemPrompt = (): string =>
    `You are the narration engine behind a programmatic media-planning console. A plan has already been fully decided by a deterministic engine — which inventory was picked, how much budget goes where, every number (reach, impressions, CPM). Your only job is to write the human-readable text explaining decisions that are already final. You do not choose anything, and nothing you write should contradict a number or a selection you're given — if a number looks surprising, explain it, don't second-guess it.

Hard rules:
1. "title" is a short campaign-plan name (brand + objective + flight, e.g. "Nyka Reach Campaign — Nov 2026"). "summary" is one sentence covering what this plan does and why.
2. "targetGroup" describes the audience actually targeted, as "type::value" strings — type is exactly one of ${TARGET_GROUP_TYPES.join(', ')}, value is the plain-text detail (e.g. "gender::Female", "age::25-34", "interest::Beauty & Fashion"). Only include what the brief/inputs actually specified — don't invent a target you weren't given.
3. "lineReasons" is one "line::reason" string per budget line you're given, each reason a short sentence on why that line earned its share (e.g. "ctv-oem-fast::Premium video inventory with the strongest VCR for an awareness objective.").
4. "itemReasons" is one "line|inventoryId::reason" string per recommended item you're given, each reason specific to that item's role and numbers WITHIN that line only (e.g. a reach-driver's reason cites its avails, a cost-efficient item's reason cites its CPM) — never a reason blending two different lines together. The same inventoryId can appear under more than one line (the same real property can be both a CTV row and a Mobile OTT row) — treat each line|inventoryId pair as its own separate item needing its own separate reason, even when the id repeats. Use the exact line and inventoryId you were given, unchanged — never invent either.
5. "assumptions" lists anything the deterministic engine had to default because the input didn't specify it (you're told what was left unset) — plain language, one per line.
6. "recommendedWindows" is up to 3 flight-date windows as "startDate::endDate::score::reason" strings (dates as YYYY-MM-DD, every date must be on or after ${new Date().toISOString().slice(0, 10)} — never recommend a window that's already in the past) — your own judgment on good timing for this brand/category/objective (seasonality, festivals, typical category patterns), since there's no real historical booking data behind this yet. "score" is a 0-100 confidence number you assign, not a measured figure — be honest that it's a judgment call, not a guarantee. "datesToAvoid" is "startDate::endDate::reason" strings (same date rule) for windows to avoid (e.g. clashing with a major unrelated event). "givenVsBest" compares the input's own dates (if given) to your top recommended window in one sentence, or null if no dates were given to compare.
7. All money amounts are in Indian Rupees — use "₹", never "$" or "USD", anywhere you mention an amount.`;

/** Parses a "key::value" entry; a malformed one (no "::") is dropped rather than guessed at. */
const parseKeyValue = (entry: string): { key: string; value: string } | null => {
    const separator = entry.indexOf('::');
    if (separator === -1) return null;
    return { key: entry.slice(0, separator), value: entry.slice(separator + 2) };
};

const buildNarrationPrompt = (input: PlannerInput, core: GeneratedPlanCore): string => {
    const unsetFields: string[] = [];
    if (input.campaign.budget === null) unsetFields.push('campaign.budget');
    if (input.campaign.startDate === null && input.campaign.endDate === null) {
        unsetFields.push('campaign.startDate/endDate');
    }
    if (input.audience.gender === null) unsetFields.push('audience.gender');
    if (input.audience.ageGroups.length === 0) unsetFields.push('audience.ageGroups');
    if (input.inventory.qualityTier === null) unsetFields.push('inventory.qualityTier');

    return `Brand: ${JSON.stringify(input.brand)}
Campaign: ${JSON.stringify(input.campaign)}
Audience targeting given: ${JSON.stringify(input.audience)}
Rate tier used: ${core.rateTier}
Fields left unset by the input (defaulted by the engine): ${unsetFields.join(', ') || '(none)'}

Budget lines (already decided):
${core.budgetAllocation
    .map(
        line =>
            `- ${line.inventoryLine}: ${line.sharePercent}% share, ₹${line.amount}, ${line.impressions} impressions\n` +
            line.recommendedInventory
                .map(
                    item =>
                        `    id=${item.inventoryId} name="${item.name}" role=${item.role} cpm=${item.cpm} avails=${item.avails}${item.vcr !== null ? ` vcr=${item.vcr}` : ''}`
                )
                .join('\n')
    )
    .join('\n')}

Key figures (already decided): ${JSON.stringify(core.keyFigures)}
KPI fit (already decided): ${JSON.stringify(core.kpiFit)}
Platforms that couldn't be planned automatically: ${JSON.stringify(core.plannedByTeam)}`;
};

export const generateNarration = async (
    input: PlannerInput,
    core: GeneratedPlanCore
): Promise<PlanNarration> => {
    const result = await generateStructured<ReturnType<typeof buildNarrationSchema>>({
        system: buildNarrationSystemPrompt(),
        prompt: buildNarrationPrompt(input, core),
        schema: buildNarrationSchema(),
        maxTokens: 2048,
        temperature: 0.2,
    });

    const targetGroup = result.targetGroup
        .map(parseKeyValue)
        .filter(
            (parsed): parsed is { key: string; value: string } =>
                parsed !== null && (TARGET_GROUP_TYPES as readonly string[]).includes(parsed.key)
        )
        .map(({ key, value }) => ({ type: key as PlanNarration['targetGroup'][number]['type'], value }));

    const lineReasons: Record<string, string> = {};
    for (const entry of result.lineReasons) {
        const parsed = parseKeyValue(entry);
        if (parsed) lineReasons[parsed.key] = parsed.value;
    }

    // Keyed by "line|inventoryId" — see buildNarrationSchema's comment for why the id alone
    // isn't unique enough.
    const itemReasons: Record<string, string> = {};
    for (const entry of result.itemReasons) {
        const parsed = parseKeyValue(entry);
        if (parsed) itemReasons[parsed.key] = parsed.value;
    }

    const recommendedWindows = result.recommendedWindows
        .map(entry => {
            const parts = entry.split('::');
            if (parts.length !== 4) return null;
            const [startDate, endDate, scoreStr, reason] = parts;
            const score = Number(scoreStr);
            if (!Number.isFinite(score)) return null;
            return { startDate, endDate, score: Math.max(0, Math.min(100, score)), reason };
        })
        .filter((w): w is NonNullable<typeof w> => w !== null);

    const datesToAvoid = result.datesToAvoid
        .map(entry => {
            const parts = entry.split('::');
            if (parts.length !== 3) return null;
            const [startDate, endDate, reason] = parts;
            return { dateRange: `${startDate} to ${endDate}`, reason };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);

    return {
        title: result.title,
        summary: result.summary,
        targetGroup,
        lineReasons,
        itemReasons,
        assumptions: result.assumptions,
        bestDates: {
            recommendedWindows,
            datesToAvoid,
            givenVsBest: result.givenVsBest,
        },
    };
};

/**
 * The second (and last) LLM call in Call 2 — runs only after the curves are computed, since it
 * has to describe their actual numbers. Same low-temperature, narration-only treatment as the
 * first call: it never recomputes a verdict (too-low/about-right/too-high is already decided
 * in curves.service.ts), it only explains one already decided.
 */
const buildCurveCommentarySchema = () =>
    z.object({
        givenVsRecommendedBudgetReason: z.string().nullable(),
        givenVsRecommendedCpmReason: z.string().nullable(),
        benefitSummary: z.array(z.string()),
    });

const buildCurveCommentarySystemPrompt = (): string =>
    `You are the narration engine behind a programmatic media-planning console. A budget curve and a CPM curve have already been computed by a deterministic engine, including their verdicts (too low / about right / too high). Your only job is to explain those already-decided verdicts in plain language — never restate or imply a different verdict than the one you're given, and never invent a number not already in what you're given.

Hard rules:
1. "givenVsRecommendedBudgetReason" is one sentence explaining the budget verdict you're given, citing the actual reach/cost numbers you're given — null if no budget verdict was computed (the user didn't give a budget).
2. "givenVsRecommendedCpmReason" is the same for the CPM verdict — null if none was computed.
3. "benefitSummary" is 3-5 short lines in plain words on what the user gains by following the recommended dates/budget/CPM instead of their own inputs — grounded only in the numbers you're given, nothing invented.
4. All money amounts are in Indian Rupees — use "₹", never "$" or "USD", anywhere you mention an amount.`;

const buildCurveCommentaryPrompt = (
    budgetCurve: BudgetCurveResult,
    cpmCurve: CpmCurveResult,
    bestDates: PlanNarration['bestDates']
): string => `Budget curve verdict: ${JSON.stringify(budgetCurve.givenVsRecommended)}
Budget curve recommended levels: ${JSON.stringify(budgetCurve.recommendedBudget)}
Budget curve diminishing-returns point: ${JSON.stringify(budgetCurve.diminishingReturnsPoint)}

CPM curve verdict: ${JSON.stringify(cpmCurve.givenVsRecommended)}
CPM curve recommended levels: ${JSON.stringify(cpmCurve.recommendedCpm)}

Best dates already suggested: ${JSON.stringify(bestDates.recommendedWindows)}`;

export const generateCurveCommentary = async (
    budgetCurve: BudgetCurveResult,
    cpmCurve: CpmCurveResult,
    bestDates: PlanNarration['bestDates']
): Promise<CurveCommentary> => {
    const result = await generateStructured<ReturnType<typeof buildCurveCommentarySchema>>({
        system: buildCurveCommentarySystemPrompt(),
        prompt: buildCurveCommentaryPrompt(budgetCurve, cpmCurve, bestDates),
        schema: buildCurveCommentarySchema(),
        maxTokens: 1024,
        temperature: 0.2,
    });
    return result;
};

/** Merges the deterministic core with the narration text and the two curves into what Call 2 actually returns. Any line/item the narration call didn't give a reason for (dropped during parsing, or the model just missed one) falls back to a plain generated sentence rather than null — the plan shouldn't have a visibly broken field just because narration was incomplete for one row. */
export const mergePlan = (
    input: PlannerInput,
    core: GeneratedPlanCore,
    narration: PlanNarration,
    budgetCurve: BudgetCurveResult,
    cpmCurve: CpmCurveResult,
    curveCommentary: CurveCommentary
): GeneratedPlan => ({
    header: {
        title: narration.title,
        summary: narration.summary,
        status: 'preliminary',
    },
    keyFigures: core.keyFigures,
    flight: core.flight,
    bestDates: narration.bestDates,
    budgetCurve: {
        points: budgetCurve.points,
        recommendedBudget: budgetCurve.recommendedBudget,
        diminishingReturnsPoint: budgetCurve.diminishingReturnsPoint,
        givenVsRecommended: budgetCurve.givenVsRecommended
            ? { ...budgetCurve.givenVsRecommended, reason: curveCommentary.givenVsRecommendedBudgetReason }
            : null,
    },
    cpmCurve: {
        points: cpmCurve.points,
        recommendedCpm: cpmCurve.recommendedCpm,
        givenVsRecommended: cpmCurve.givenVsRecommended
            ? { ...cpmCurve.givenVsRecommended, reason: curveCommentary.givenVsRecommendedCpmReason }
            : null,
    },
    benefitSummary: curveCommentary.benefitSummary,
    budgetAllocation: core.budgetAllocation.map(line => ({
        ...line,
        reason: narration.lineReasons[line.inventoryLine] ?? `${line.sharePercent}% of budget allocated to ${line.inventoryLine}.`,
        recommendedInventory: line.recommendedInventory.map(item => ({
            ...item,
            reason:
                narration.itemReasons[`${line.inventoryLine}|${item.inventoryId}`] ??
                `Selected as ${item.role.replace('-', ' ')}.`,
        })),
    })),
    plannedByTeam: core.plannedByTeam,
    audience: { targetGroup: narration.targetGroup },
    buying: { ...core.buying, dealType: input.buying.dealType },
    brandSafety: core.brandSafety,
    checks: {
        kpiFit: core.kpiFit,
        assumptions: narration.assumptions,
    },
});
