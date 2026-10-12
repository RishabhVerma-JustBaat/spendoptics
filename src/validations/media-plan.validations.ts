import Joi from 'joi';

// The ten top-level keys are the contract and are required; everything inside a
// block is left open (`unknown(true)`) since fields inside a block may be added
// over time and old/new clients should both be able to save without a schema bump.
export const saveMediaPlanSchema = Joi.object({
    schemaVersion: Joi.number().integer().min(1).required(),
    planId: Joi.string().trim().min(1).required(),
    source: Joi.object({
        app: Joi.string().required(),
        trigger: Joi.string().required(),
    })
        .unknown(true)
        .required(),
    brief: Joi.object({
        text: Joi.string().allow('').required(),
        parsed: Joi.object().unknown(true).default({}),
        answers: Joi.object().unknown(true).default({}),
    })
        .unknown(true)
        .required(),
    campaign: Joi.object().unknown(true).required(),
    market: Joi.object().unknown(true).required(),
    audience: Joi.object().unknown(true).required(),
    inventory: Joi.object().unknown(true).required(),
    forecast: Joi.object().unknown(true).required(),
    // savedAt is server-stamped on every write, never client-supplied.
}).unknown(false);
