import { randomUUID } from 'crypto';
import { generateCurveCommentary, generateNarration, generateSuggestions, mergePlan, SuggestResult } from '../config/planner.prompts';
import { buildCandidateInventory } from './planner.candidates';
import { buildPlanCore } from './allocation.service';
import { buildBudgetCurve, buildCpmCurve } from './curves.service';
import { getIabCategories } from './inventory.service';
import { PlanService } from './plan.service';
import { PlanDocument, PlanSaveRequest } from '../types/plan.types';
import { GeneratedPlan, PlannerInput } from '../types/planner.types';

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

export class PlannerService {
    private planService = new PlanService();

    /** Call 1 ("suggest") — free-text prompt in, a pre-filled (never blank) form out, with a provenance tag per field. The user vets this before it ever reaches generate(). */
    async suggest(prompt: string): Promise<SuggestResult> {
        const iabCategories = await getIabCategories();
        return generateSuggestions(prompt, iabCategories);
    }

    /**
     * Call 2 ("generate") — takes the vetted form fields and produces the actual plan. Every
     * number and selection decision comes from planner.candidates.ts / allocation.service.ts /
     * curves.service.ts (deterministic, real data only, except Best Dates' "score" — see
     * planner.prompts.ts's narration call comment for that one exception). The two LLM calls
     * (narration, then curve commentary once the curves exist to describe) only write text
     * around decisions already made.
     */
    async generate(input: PlannerInput): Promise<GeneratedPlan> {
        const candidates = await buildCandidateInventory(input);
        const core = buildPlanCore(candidates, input);
        // Both curves are synchronous/CPU-bound (no LLM, no extra DB round trip — see
        // curves.service.ts), so there's nothing to gain from Promise.all-ing them alongside
        // the narration call's actual network request.
        const budgetCurve = buildBudgetCurve(candidates, input);
        const cpmCurve = buildCpmCurve(candidates, input.inventory.maxCpm);

        const narration = await generateNarration(input, core);
        const curveCommentary = await generateCurveCommentary(budgetCurve, cpmCurve, narration.bestDates);

        return mergePlan(input, core, narration, budgetCurve, cpmCurve, curveCommentary);
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
