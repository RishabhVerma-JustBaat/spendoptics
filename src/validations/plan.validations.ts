import Joi from 'joi';
import { PROMPT_TYPES } from '../types/plan.types';

export const analyseBriefSchema = Joi.object({
    brief: Joi.string().trim().min(1).max(20000).required(),
    // Same URL for every brief shape. Optional — the brief is free text, so leaving this
    // out lets plan.service.ts classify it automatically instead of requiring the caller
    // to already know which internal prompt/schema config/plan-prompts.ts should use.
    // Pass it explicitly to force a specific profile (e.g. for testing).
    type: Joi.string().valid(...PROMPT_TYPES),
    context: Joi.object({
        country: Joi.string().default('IN'),
        channels: Joi.array().items(Joi.string()).default([]),
        objectives: Joi.array().items(Joi.string()).default([]),
        kpis: Joi.array().items(Joi.string()).default([]),
    })
        .default({ country: 'IN', channels: [], objectives: [], kpis: [] })
        .unknown(true),
});
