import { PROMPT_PROFILES, classifyBriefType } from '../config/plan-prompts';
import { AnalyseContext, PromptType } from '../types/plan.types';

export class PlanService {
    async analyseBrief(
        brief: string,
        type: PromptType | undefined,
        context: AnalyseContext
    ): Promise<unknown> {
        const resolvedType = type ?? (await classifyBriefType(brief));
        const result = await PROMPT_PROFILES[resolvedType].run(brief, context);
        // Surfaced so a caller that didn't pass `type` can see what this was classified as
        // (and the tester page can confirm classification without a separate call).
        return { type: resolvedType, ...(result as object) };
    }
}
