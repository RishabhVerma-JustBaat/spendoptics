import { randomUUID } from 'crypto';
import {
    generateCurveCommentary,
    generateNarration,
    generateRefinement,
    generateSuggestions,
    mergePlan,
    SuggestResult,
} from '../config/planner.prompts';
import { buildCandidateInventory } from './planner.candidates';
import { buildPlanCore } from './allocation.service';
import { buildBestDates, buildBudgetCurve, buildCpmCurve } from './curves.service';
import { getCalendar, getIabCategories, getSupportedCountries } from './inventory.service';
import { PlanService } from './plan.service';
import { PlanDocument, PlanSaveRequest } from '../types/plan.types';
import { GeneratedPlan, PlanDiff, PlannerInput, RefineResult } from '../types/planner.types';
import { ApiError } from '../utils/apiError';
import { findInvalidValues, validatePrompt } from '../validations/planner.validations';

export const SCHEMA_VERSION = 2; // 1 was the old, now-retired single-call /plan/analyse shape

/**
 * Converts a GeneratedPlan into the PlanSaveRequest envelope PlanService's storage already
 * understands. The envelope's inner blocks aren't shape-constrained at all beyond "an object"
 * (see plan.types.ts) — only the 10 top-level keys are a fixed contract — so this plan's very
 * different field names don't need the storage layer to change at all, just this mapping.
 */
const toPlanSaveRequest = (planId: string, input: PlannerInput, plan: GeneratedPlan): PlanSaveRequest => ({
    schemaVersion: SCHEMA_VERSION,
    planId,
    source: { app: 'ai-planner', trigger: 'generate' },
    brief: {
        // The original free-text brief, carried through from Call 1 via input.rawPrompt — null
        // for a plan built entirely by hand with no suggest call involved.
        text: input.rawPrompt ?? '',
        parsed: input as unknown as Record<string, unknown>,
        answers: {},
    },
    campaign: {
        title: plan.header.title,
        summary: plan.header.summary,
        status: plan.header.status,
        flight: plan.flight,
        keyFigures: plan.keyFigures,
    },
    market: {
        geoScope: input.audience.geoScope,
        states: input.audience.states,
        excludeStates: input.audience.excludeStates,
    },
    audience: {
        targetGroup: plan.audience.targetGroup,
    },
    inventory: {
        budgetAllocation: plan.budgetAllocation,
        plannedByTeam: plan.plannedByTeam,
        brandSafety: plan.brandSafety,
        buying: plan.buying,
    },
    forecast: {
        bestDates: plan.bestDates,
        budgetCurve: plan.budgetCurve,
        cpmCurve: plan.cpmCurve,
        benefitSummary: plan.benefitSummary,
        checks: plan.checks,
    },
});

/** Compares the plan being refined (round-tripped from the client, so not shape-checked — every access is guarded) with the freshly generated one. Lines are matched by inventoryLine, items within a line by name. */
const diffPlans = (previous: Partial<GeneratedPlan>, current: GeneratedPlan): PlanDiff => {
    const previousFigures = (previous.keyFigures ?? {}) as Partial<GeneratedPlan['keyFigures']>;
    const keyFigures = (Object.keys(current.keyFigures) as (keyof GeneratedPlan['keyFigures'])[]).map(field => {
        const before = typeof previousFigures[field] === 'number' ? (previousFigures[field] as number) : null;
        const after = current.keyFigures[field];
        return { field, previous: before, current: after, delta: before !== null && after !== null ? after - before : null };
    });

    const previousLines = Array.isArray(previous.budgetAllocation) ? previous.budgetAllocation : [];
    const previousByLine = new Map(previousLines.map(line => [line.inventoryLine, line]));
    const currentByLine = new Map(current.budgetAllocation.map(line => [line.inventoryLine, line]));
    const itemNames = (line: { recommendedInventory?: { name: string }[] }) =>
        new Set((Array.isArray(line.recommendedInventory) ? line.recommendedInventory : []).map(item => item.name));

    const lineChanges: PlanDiff['lineChanges'] = [];
    for (const line of current.budgetAllocation) {
        const before = previousByLine.get(line.inventoryLine);
        if (!before) continue;
        const beforeItems = itemNames(before);
        const afterItems = itemNames(line);
        lineChanges.push({
            inventoryLine: line.inventoryLine,
            previousSharePercent: before.sharePercent,
            currentSharePercent: line.sharePercent,
            previousAmount: before.amount,
            currentAmount: line.amount,
            itemsAdded: [...afterItems].filter(name => !beforeItems.has(name)),
            itemsRemoved: [...beforeItems].filter(name => !afterItems.has(name)),
        });
    }

    return {
        keyFigures,
        linesAdded: [...currentByLine.keys()].filter(line => !previousByLine.has(line)),
        linesRemoved: [...previousByLine.keys()].filter(line => !currentByLine.has(line)),
        lineChanges,
    };
};

export class PlannerService {
    private planService = new PlanService();

    /** Call 1 ("suggest") — free-text prompt in, a pre-filled (never blank) form out, with a provenance tag per field. The user vets this before it ever reaches generate(). */
    async suggest(prompt: string): Promise<SuggestResult> {
        validatePrompt(prompt);
        const iabCategories = await getIabCategories();
        return generateSuggestions(prompt, iabCategories);
    }

    /**
     * Call 2 ("generate") — takes the vetted form fields and produces the actual plan. Every
     * number and selection decision comes from planner.candidates.ts / allocation.service.ts /
     * curves.service.ts (deterministic, real data only, except Best Dates' "score" when no calendar data covers the flight — see
     * planner.prompts.ts's narration call comment for that one exception). The two LLM calls
     * (narration, then curve commentary once the curves exist to describe) only write text
     * around decisions already made.
     */
    async generate(input: PlannerInput): Promise<GeneratedPlan> {
        // Every ingested sheet is India-only (inventory_mobile_ott.country is the one real,
        // literal column confirming this) and nothing anywhere filters candidates by
        // audience.country/states at all — so without this check, a request for a market this
        // platform has zero real data for (e.g. "Virginia, USA") would silently get Indian
        // inventory recommended back as if it were a valid answer. Reading the supported-market
        // list from the real data (not hardcoding "India") means this check tracks whatever the
        // ingested sheets actually cover if that ever changes. Only rejects when a country was
        // actually given and doesn't match — never blocks a direct generate() call that left
        // audience.country unset.
        if (input.audience.country) {
            const supportedCountries = await getSupportedCountries();
            const isSupported = supportedCountries.some(
                c => c.toLowerCase() === input.audience.country!.trim().toLowerCase()
            );
            if (!isSupported) {
                throw new ApiError(
                    422,
                    `This platform only has real inventory for ${supportedCountries.join(', ')} — "${input.audience.country}" isn't a market there's data for.`
                );
            }
        }

        // The planner submitted this form as-is, so a value that can't be right is rejected with
        // every problem listed, rather than silently dropped the way suggest/refine do.
        const invalid = findInvalidValues(input, await getIabCategories());
        if (invalid.length > 0) {
            throw new ApiError(422, `Fix these before generating: ${invalid.map(i => `${i.field}: ${i.message}`).join(' ')}`);
        }

        const [candidates, calendar] = await Promise.all([
            buildCandidateInventory(input),
            getCalendar(new Date().toISOString().slice(0, 10)),
        ]);
        const core = buildPlanCore(candidates, input);

        // Fail fast and explicitly rather than spend an LLM call narrating an empty plan —
        // zero selected lines means not one requested platform had any real inventory matching
        // the given filters (categories, CPM caps, viewability, etc. all tighten this), so
        // there's nothing left to plan with at all.
        if (core.budgetAllocation.length === 0) {
            const reasons = core.plannedByTeam.map(p => `${p.platform} (${p.reason})`).join('; ');
            throw new ApiError(
                422,
                `Not enough real inventory matched this input to generate a plan.${reasons ? ` ${reasons}` : ''} Try loosening the filters (platforms, IAB categories, CPM caps, or viewability/VCR minimums) and generate again.`
            );
        }

        // Both curves are synchronous/CPU-bound (no LLM, no extra DB round trip — see
        // curves.service.ts), so there's nothing to gain from Promise.all-ing them alongside
        // the narration call's actual network request.
        const budgetCurve = buildBudgetCurve(candidates, input);
        const cpmCurve = buildCpmCurve(candidates, input);

        const calendarDates = buildBestDates(input, core, calendar);
        const narration = await generateNarration(input, core, calendarDates);
        const curveCommentary = await generateCurveCommentary(budgetCurve, cpmCurve, narration.bestDates);

        return mergePlan(input, core, narration, budgetCurve, cpmCurve, curveCommentary);
    }

    /**
     * Refine — the planner tweaks an already-generated plan, by editing form fields, editing the
     * prompt, or both. Form edits arrive already applied in `input`. `prompt` is only sent when
     * the prompt text was edited; when it's absent (or identical to input.rawPrompt) the earlier
     * prompt stays as-is and no LLM call is spent on it. When it did change, only the fields the
     * edit itself affects are rewritten (see generateRefinement), so manual form edits survive.
     * Each response carries the refined input back, so the next round refines from it.
     */
    async refine(input: PlannerInput, prompt: string | undefined, previousPlan: Partial<GeneratedPlan>): Promise<RefineResult> {
        const newPrompt = prompt?.trim();
        const promptChanged = !!newPrompt && newPrompt !== (input.rawPrompt ?? '').trim();

        let refinedInput = input;
        let promptChanges: RefineResult['promptChanges'] = [];
        let warnings: RefineResult['warnings'] = [];
        if (promptChanged) {
            validatePrompt(newPrompt!);
            const iabCategories = await getIabCategories();
            ({ input: refinedInput, changes: promptChanges, warnings } = await generateRefinement(
                input,
                input.rawPrompt,
                newPrompt!,
                previousPlan,
                iabCategories
            ));
        }

        const plan = await this.generate(refinedInput);
        return { input: refinedInput, promptChanged, promptChanges, warnings, plan, diff: diffPlans(previousPlan, plan) };
    }

    /** Creates a new saved plan with a server-generated id — the actual "create" in this API, since the id is never trusted from the caller here (unlike save(), which updates a specific, already-known id). A random UUID rather than a client-supplied one is also the safer default: nothing in this storage layer checks who owns a planId, so a guessable or caller-chosen id would be an easy way to collide with (or overwrite) someone else's plan. */
    async create(input: PlannerInput, plan: GeneratedPlan): Promise<{ id: string; savedAt: string }> {
        return this.save(randomUUID(), input, plan);
    }

    /** Persists an already-generated plan under a known planId (upsert) — for a caller re-saving a plan it already has the id for. Reuses PlanService's existing storage machinery rather than duplicating it — toPlanSaveRequest above only adapts a GeneratedPlan into the save envelope it already accepts. */
    async save(planId: string, input: PlannerInput, plan: GeneratedPlan): Promise<{ id: string; savedAt: string }> {
        const request = toPlanSaveRequest(planId, input, plan);
        return this.planService.save(request);
    }

    async list(limit?: number): Promise<PlanDocument[]> {
        return this.planService.list(limit);
    }

    async getById(planId: string): Promise<PlanDocument> {
        return this.planService.getById(planId);
    }

    async approve(planId: string, approvedBy: string): Promise<PlanDocument> {
        return this.planService.approve(planId, approvedBy);
    }
}
