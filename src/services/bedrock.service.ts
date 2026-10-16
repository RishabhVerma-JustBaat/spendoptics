import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { config } from '../config/environment';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';

// The legacy AnthropicBedrock client, not the newer Mantle proxy — Mantle expects its own
// short model-id convention (e.g. "anthropic.claude-opus-5") and 404s on a real AWS
// model id / cross-region inference profile id (e.g. "us.anthropic.claude-haiku-4-5-...-v1:0"),
// confirmed against a live Bedrock call. apiKey (Bedrock's bearer-token auth) takes priority
// when set; otherwise the client falls back to the standard AWS SigV4 credential chain.
const client = new AnthropicBedrock(
    config.bedrock.apiKey
        ? { awsRegion: config.bedrock.region, apiKey: config.bedrock.apiKey }
        : { awsRegion: config.bedrock.region }
);

interface TextBlock {
    type: 'text';
    text: string;
}

/**
 * Asks Claude for a single structured JSON answer, shaped by `schema`.
 *
 * Uses output_config.format (structured outputs), not strict forced tool use. Both hit a
 * "compiled grammar is too large" ceiling on this Haiku-class Bedrock model past a certain
 * schema complexity, but confirmed live that the ceiling is NOT the same for both paths —
 * an identical schema that 400s under strict tool use can succeed under output_config.format.
 * Since every schema here is already pared down as far as it reasonably can be, the path
 * with more headroom wins.
 *
 * Request/response objects are handled loosely (not against the SDK's own types) because
 * this package embeds its own nested copy of @anthropic-ai/sdk, whose literal-union types
 * don't line up with a separately installed copy.
 */
export const generateStructured = async <S extends z.ZodTypeAny>(params: {
    system: string;
    prompt: string;
    schema: S;
    maxTokens?: number;
    // Unset uses the API default (1.0) — fine for calls that genuinely need judgment (reading
    // a free-text brief, ranking tradeoffs), but a call that only narrates numbers someone else
    // already computed should be passed something low (e.g. 0.2) so wording stays consistent
    // run to run instead of drifting at the same temperature a creative task would use.
    temperature?: number;
}): Promise<z.infer<S>> => {
    // zod-to-json-schema emits additionalProperties: false + a full `required` list for every
    // z.object() by default. Default (draft-7) target, not 'openApi3' — Bedrock's schema
    // validator expects plain JSON Schema nullability (`type: [T, "null"]` / `anyOf`), not
    // OpenAPI's `nullable: true`. $refStrategy: 'none' — a Zod sub-schema reused in more than
    // one place (e.g. one shape used for several array fields) otherwise dedupes into a local
    // `$ref`, which Bedrock's schema validator rejects outright ("JSON schema is invalid") —
    // confirmed against a live call. `as any` (not just `as z.ZodTypeAny`) is required — the
    // library's own generics recurse into the schema's structural type regardless, blowing the
    // instantiation depth limit (TS2589) unless the input is fully opaque to the type checker.
    const jsonSchema = zodToJsonSchema(params.schema as any, { $refStrategy: 'none' }) as Record<
        string,
        unknown
    >;
    delete jsonSchema.$schema;

    let response: { stop_reason?: string; content: TextBlock[] };
    try {
        response = (await client.messages.create({
            model: config.bedrock.modelId,
            max_tokens: params.maxTokens ?? 4096,
            system: params.system,
            messages: [{ role: 'user', content: params.prompt }],
            output_config: { format: { type: 'json_schema', schema: jsonSchema } },
            ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        } as any)) as any;
    } catch (error) {
        logger.error('Bedrock request failed', error);
        throw new ApiError(502, 'The AI service is unavailable right now. Please try again.');
    }

    if (response.stop_reason === 'refusal') {
        throw new ApiError(422, 'The AI declined to process this request.');
    }

    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock) {
        throw new ApiError(502, 'The AI did not return a structured result.');
    }

    let rawResult: unknown;
    try {
        rawResult = JSON.parse(textBlock.text);
    } catch (error) {
        logger.error('Bedrock response was not valid JSON', error, { text: textBlock.text });
        throw new ApiError(502, 'The AI returned a result that did not match the expected format.');
    }

    const parsed = params.schema.safeParse(rawResult);
    if (!parsed.success) {
        logger.error('Bedrock response failed schema validation', parsed.error, {
            input: rawResult,
        });
        throw new ApiError(502, 'The AI returned a result that did not match the expected format.');
    }

    return parsed.data;
};

/** Titan Text Embeddings v2 — what scripts/ingest-inventory.js --embeddings stored inventory_embeddings with; a query must use the same model and size to be comparable. */
export const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
export const EMBEDDING_DIMENSIONS = 256;
/** Titan v2 takes up to 8k tokens; a brief longer than this many characters is cut, not rejected. */
const MAX_EMBEDDING_CHARS = 20000;

/**
 * A normalized embedding of `text`, or null when it can't be had (no Bedrock API key — the
 * Anthropic client's SigV4 fallback doesn't cover a raw model call — or the call failed).
 * Callers treat null as "no semantic signal", never as an error: the plan still generates.
 */
export const embedText = async (text: string): Promise<Float32Array | null> => {
    if (!config.bedrock.apiKey || text.trim() === '') return null;
    try {
        const response = await fetch(
            `https://bedrock-runtime.${config.bedrock.region}.amazonaws.com/model/${encodeURIComponent(EMBEDDING_MODEL_ID)}/invoke`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.bedrock.apiKey}` },
                body: JSON.stringify({
                    inputText: text.slice(0, MAX_EMBEDDING_CHARS),
                    dimensions: EMBEDDING_DIMENSIONS,
                    normalize: true,
                }),
            }
        );
        if (!response.ok) {
            logger.warn('Bedrock embedding call failed', { status: response.status, body: await response.text() });
            return null;
        }
        const body = (await response.json()) as { embedding: number[] };
        return Float32Array.from(body.embedding);
    } catch (error) {
        logger.warn('Bedrock embedding call failed', { error: (error as Error).message });
        return null;
    }
};

/** Cosine similarity of two normalized vectors (a plain dot product). */
export const cosine = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
};
