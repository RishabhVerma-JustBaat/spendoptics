import { randomUUID } from 'crypto';
import { generateCurveCommentary, generateNarration, generateSuggestions, mergePlan, SuggestResult } from '../config/planner.prompts';
import { buildCandidateInventory } from './planner.candidates';
import { buildPlanCore } from './allocation.service';
import { buildBudgetCurve, buildCpmCurve } from './curves.service';
import { getIabCategories, getSupportedCountries } from './inventory.service';
import { PlanService } from './plan.service';
import { PlanDocument, PlanSaveRequest } from '../types/plan.types';
import { GeneratedPlan, PlannerInput } from '../types/planner.types';
import { ApiError } from '../utils/apiError';

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

        const candidates = await buildCandidateInventory(input);
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
