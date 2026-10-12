import { generateCurveCommentary, generateNarration, mergePlan } from '../config/ai-planner-prompts';
import { generateSuggestions, SuggestResult } from '../config/ai-planner-suggest-prompts';
import { buildCandidateInventory } from './candidate-inventory.service';
import { buildPlanCore } from './allocation.service';
import { buildBudgetCurve, buildCpmCurve } from './curves.service';
import { getIabCategories } from './inventory.service';
import { GeneratedPlan, PlannerInput } from '../types/ai-planner.types';

export class AiPlannerService {
    /** Call 1 ("suggest") — free-text prompt in, a pre-filled (never blank) form out, with a provenance tag per field. The user vets this before it ever reaches generate(). */
    async suggest(prompt: string): Promise<SuggestResult> {
        const iabCategories = await getIabCategories();
        return generateSuggestions(prompt, iabCategories);
    }

    /**
     * Call 2 ("generate") — takes the vetted form fields and produces the actual plan. Every
     * number and selection decision comes from candidate-inventory.service.ts / allocation
     * .service.ts / curves.service.ts (deterministic, real data only, except Best Dates'
     * "score" — see ai-planner-prompts.ts's narration call comment for that one exception).
     * The two LLM calls (narration, then curve commentary once the curves exist to describe)
     * only write text around decisions already made.
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
}
