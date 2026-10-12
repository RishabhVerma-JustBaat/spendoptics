import { z } from 'zod';
import { generateStructured } from '../services/bedrock.service';
import {
    AnalyseContext,
    AnalyseResponse,
    CoreResponse,
    GENDER_SKEWS,
    GEO_TIERS,
    PROMPT_TYPES,
    PromptType,
    buildCoreSchema,
    buildDetailSchema,
    buildEstimatesSchema,
} from '../types/plan.types';
import {
    InventoryRfpFinalResponse,
    buildInventoryRfpResponseSchema,
} from '../types/inventory-rfp.types';
import {
    getIabCategories,
    hasAudienceSignal,
    matchCtvInventory,
    matchMobileOttInventory,
    matchPackages,
    matchWebInventory,
} from '../services/inventory.service';

export interface PromptProfile {
    run: (brief: string, context: AnalyseContext) => Promise<unknown>;
}

const buildCoreSystemPrompt = (
    context: AnalyseContext
): string => `You are the brief-parsing engine behind a DOOH/digital media-planning console for programmatic buyers in India.

You are given a free-text campaign brief. Extract only what it actually states into the fields below — every field here is a STATED FACT, not something to estimate. Leave anything unstated as null (or an empty array for list fields). Never guess one of these — a wrong budget or a wrong flight date is worse than a null one.

Hard rules — follow every one of these exactly:
1. If the brief does not state a field, it is null (or an empty array for list fields) — never guess.
2. Numbers are raw integers — no currency symbols, no Indian shorthand. "50 Lakh" -> 50 * 100000 = 5000000. "1 Crore" -> 10000000. "4M" -> 4000000. "1 month" for durationDays -> 30.
3. "objective" must be exactly one of: ${context.objectives.join(', ') || '(none provided)'}, or null.
4. "kpi" must be exactly one of: ${context.kpis.join(', ') || '(none provided)'}, or null.
5. "market.country" is always "IN". "audience.ageRange", when not null, is exactly two integers [from, to] — e.g. "25-44" becomes [25, 44]. "campaign.flight", when not null, always has both "start" and "end" — a brief that states only one edge of the flight leaves the whole object null.
6. "category" must be exactly one of: ${context.iabCategories?.join(', ') || '(none provided)'} — whichever one genuinely matches this brief's advertiser/product, or null if none of them fit. This isn't a free description; picking the closest real one (not inventing a new label) is what lets this plan use real rate-card data instead of an estimate.`;

const buildEstimatesSystemPrompt = (
    context: AnalyseContext
): string => `You are the second-pass engine behind a DOOH/digital media-planning console for programmatic buyers in India. A brief was already parsed for its stated facts; you're given the brief again, plus the exact list of fields that came back unstated (this includes "market.geos" whenever the brief named no geography at all — an unstated geo is as significant a gap as an unstated budget). You now do four things in one pass.

1. AUDIENCE/AVAILABILITY ESTIMATES — there is no live inventory system or audience-measurement data behind this endpoint, so every one of these is your best plausible estimate from general knowledge of the Indian digital/DOOH ad market, not a real number. Always attempt every field. Stay grounded: consistent with everything the brief actually states (a stated "Male 25-54" skew means your gender/age split reflects that, not a random one), and plausible in scale for the brief's budget, geography, and category.
   - "genderSplit"/"ageSplit"/"geoSplit" are each a list of "Label|percent" strings (e.g. "Male|63", "25-34|38") whose percents sum to 100.
   - "availableImpressions"/"availableUniques" are your estimated total addressable reach for this targeting; 0 only if you genuinely have no basis to estimate from.
   - "matchedTerms"/"unmatchedTerms" is a rough read on how well the brief's named placements map to known inventory — empty arrays are fine if nothing is named.

2. INVENTORY STATED FACTS — "formats"/"platforms"/"placementsNamed"/"videoPlacements"/"creativeDurations"/"languages"/"adUnits" are extracted exactly like a normal brief field: only what the brief actually says, empty array otherwise, never invented — these are not estimates.

3. GAP QUESTIONS — pick the 4 most significant unstated fields (fewer if there are fewer than 4 — budget, flight dates, geos, and objective/kpi usually outrank the rest) and write one question per field: "field" is the exact path you were given, unchanged (e.g. "campaign.budget"); exactly 4 options, the 4th always a generic "enter my own" with value null, the other 3 concrete and plausible for the brief's context; every option's "value" in the exact type of the field it fills (a number for a budget field, an array of strings for a geos field, an object like {"start":"...","end":"..."} for the flight field) so picking it writes straight into the plan with no parsing. If no fields were left unstated, return an empty "questions" array.

4. ASSUMED DEFAULTS — every OTHER unstated field you did NOT turn into one of the 4 gap questions above still gets filled, not left null: pick one plausible default, grounded in the brief, the advertiser, and its category — the same reasoning as the audience/availability estimates above, not a wild guess — so the plan is usable end to end rather than sitting on more nulls than necessary. Add each as a "field::jsonValue" string to "assumedDefaults": "field" is the exact dot path (e.g. "campaign.kpi"), "jsonValue" is that default JSON-encoded exactly matching the field's real type — a bare number ("30"), a quoted string ("\\"reach\\""), an array ("[\\"Mumbai\\",\\"Delhi NCR\\"]"), or an object ("{\\"start\\":\\"2026-10-01\\",\\"end\\":\\"2026-10-30\\"}") — joined with "::", e.g. campaign.kpi::"reach". A handful of fields only accept a fixed value, never a free description: "campaign.category" must be exactly one of ${context.iabCategories?.join(', ') || '(none provided)'}; "campaign.objective" must be exactly one of ${context.objectives.join(', ') || '(no fixed list — any short string is fine)'}; "campaign.kpi" must be exactly one of ${context.kpis.join(', ') || '(no fixed list — any short string is fine)'}; "market.geoTier" must be exactly one of ${GEO_TIERS.join(', ')}; "audience.genderSkew" must be exactly one of ${GENDER_SKEWS.join(', ')} — any other value for these five is dropped rather than applied, so don't invent a variant phrasing. Never include a field you already wrote a gap question for. If you have no reasonable basis for a field, leave it out rather than invent one.`;

const buildDetailSystemPrompt = (
    context: AnalyseContext
): string => `You are the inventory-detail estimation engine behind a DOOH/digital media-planning console for programmatic buyers in India. There is no live inventory system behind this endpoint, so every number you return is a plausible modelled estimate — grounded in the brief's stated budget, geography, and named placements, never wildly invented, never contradicting anything the brief actually states.

Hard rules:
1. "channels" covers every channel id the console supports — ${context.channels.join(', ') || '(none provided)'} — one entry each. "allocation" is a 0-100 percentage across all of them summing to 100 (concentrated on one channel when the brief names a single placement type, spread out when it doesn't). "rows"/"impressions"/"uniques" scale with "allocation" — a channel at 0% allocation gets 0/0/0.
2. "publishers" are plausible named publishers behind the brief's stated placements, each with an estimated "rows" and "impressions" that are a reasonable share of the total. Empty array if nothing is named in the brief.
3. "sites" are specific apps/properties under those publishers, each with "impressions"/"uniques" and a format split ("audioImpressions"/"displayImpressions"/"videoImpressions" — these three should roughly sum to "impressions"). Empty array if there's no reasonable basis to break it down this far. "platform" on every site must be exactly one of the channel ids from rule 1 (${context.channels.join(', ') || '(none provided)'}) — the one that site actually belongs under, never a different label.`;

/** Every field the facts call left null, as a dot path (e.g. "campaign.budget"), for the estimates call's questions. */
const collectNullFields = (core: CoreResponse): string[] => {
    const paths: string[] = [];
    const collect = (obj: Record<string, unknown>, prefix: string) => {
        for (const [key, value] of Object.entries(obj)) {
            if (value === null) paths.push(`${prefix}.${key}`);
        }
    };
    collect(core.campaign, 'campaign');
    collect(core.market, 'market');
    collect(core.audience, 'audience');
    // Empty is ambiguous here specifically — unlike excludedGeos/incomeStrata/affinitySegments/
    // etc., where empty legitimately means "no restriction stated", an empty geos list could
    // mean "target nationally" or "not decided yet". Treat it as unstated like any null field
    // rather than silently leaving it either way.
    if (core.market.geos.length === 0) {
        paths.push('market.geos');
    }
    return paths;
};

/** Parses a "field::jsonValue" entry; a malformed one (no "::", invalid JSON) is dropped rather than guessed at. */
const parseAssumedDefault = (entry: string): { field: string; value: unknown } | null => {
    const separator = entry.indexOf('::');
    if (separator === -1) return null;
    try {
        return { field: entry.slice(0, separator), value: JSON.parse(entry.slice(separator + 2)) };
    } catch {
        return null;
    }
};

/**
 * A handful of fields are constrained to a fixed or context-provided set of values (the core
 * schema enforces this on the facts call via z.enum(), but assumedDefaults is a freeform
 * "field::jsonValue" string with no schema-level constraint) — reject an out-of-set value here
 * rather than write something the rest of the app never expects to see in that field.
 * Everything else (budget, product name, durations, geos, ...) has no fixed vocabulary to
 * check against, so it's accepted as-is.
 */
const isValidAssumedValue = (field: string, value: unknown, context: AnalyseContext): boolean => {
    switch (field) {
        case 'campaign.objective':
            return context.objectives.length === 0
                ? typeof value === 'string'
                : context.objectives.includes(value as string);
        case 'campaign.kpi':
            return context.kpis.length === 0
                ? typeof value === 'string'
                : context.kpis.includes(value as string);
        case 'campaign.category':
            return (context.iabCategories ?? []).includes(value as string);
        case 'market.geoTier':
            return (GEO_TIERS as readonly string[]).includes(value as string);
        case 'audience.genderSkew':
            return (GENDER_SKEWS as readonly string[]).includes(value as string);
        case 'audience.ageRange':
            return (
                Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number')
            );
        case 'campaign.flight':
            return (
                typeof value === 'object' &&
                value !== null &&
                typeof (value as Record<string, unknown>).start === 'string' &&
                typeof (value as Record<string, unknown>).end === 'string'
            );
        default:
            return true;
    }
};

/**
 * Writes an assumed default into `core` at `field` (e.g. "audience.genderSkew"), but only if
 * that field is still genuinely empty (null, or an empty array for a list field like
 * "market.geos") — never overwrites anything the facts call actually extracted. Returns
 * whether it applied, so the caller can track which fields ended up assumed vs. still-null.
 */
const applyAssumedDefault = (core: CoreResponse, field: string, value: unknown): boolean => {
    const [section, key] = field.split('.');
    if (section !== 'campaign' && section !== 'market' && section !== 'audience') return false;
    const obj = core[section] as Record<string, unknown>;
    if (!(key in obj)) return false;

    const current = obj[key];
    if (current === null) {
        obj[key] = value;
        return true;
    }
    if (Array.isArray(current) && current.length === 0 && Array.isArray(value)) {
        obj[key] = value;
        return true;
    }
    return false;
};

/** Parses a "Label|percent" entry; a malformed one (no "|", non-numeric percent) is dropped rather than guessed at. */
const parseSplit = (entries: string[]): { label: string; percent: number }[] =>
    entries
        .map(entry => {
            const separator = entry.lastIndexOf('|');
            if (separator === -1) return null;
            const percent = Number(entry.slice(separator + 1));
            if (!Number.isFinite(percent)) return null;
            return { label: entry.slice(0, separator), percent };
        })
        .filter((split): split is { label: string; percent: number } => split !== null);

const runCampaignBrief = async (
    brief: string,
    baseContext: AnalyseContext
): Promise<AnalyseResponse> => {
    // Fetched once per request (cached in-process after the first call) — needed before the
    // core schema is built so "category" is constrained to categories that actually have
    // inventory behind them. See inventory.service.ts.
    const context: AnalyseContext = { ...baseContext, iabCategories: await getIabCategories() };
    const prompt = `Brief:\n"""\n${brief}\n"""`;

    // Doesn't depend on core's or estimates' output — starts immediately so it overlaps
    // with the two sequential calls below instead of adding its own wait.
    const detailPromise = generateStructured<ReturnType<typeof buildDetailSchema>>({
        system: buildDetailSystemPrompt(context),
        prompt,
        schema: buildDetailSchema(),
        maxTokens: 4096,
    });

    const core = await generateStructured<ReturnType<typeof buildCoreSchema>>({
        system: buildCoreSystemPrompt(context),
        prompt,
        schema: buildCoreSchema(context),
        maxTokens: 4096,
    });

    // Belt and suspenders: the prompt states these, but don't leave a hard business rule
    // resting on the model's wording being consistent.
    core.market.country = context.country || 'IN';

    // The schema can no longer enforce "exactly 2"/"both edges or neither" (Bedrock rejects
    // minItems > 1 outright) — a malformed value is worse than null, so drop it instead of
    // handing the console a range with one edge or three. Done before collecting null
    // fields so a dropped value still gets a gap question.
    if (core.audience.ageRange && core.audience.ageRange.length !== 2) {
        core.audience.ageRange = null;
    }
    if (core.campaign.flight && (!core.campaign.flight.start || !core.campaign.flight.end)) {
        core.campaign.flight = null;
    }
    // Derivable from stated flight dates, not a guess — fill it in rather than ask a gap
    // question for something already implied by campaign.flight.
    if (core.campaign.durationDays === null && core.campaign.flight) {
        const start = new Date(core.campaign.flight.start);
        const end = new Date(core.campaign.flight.end);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end >= start) {
            core.campaign.durationDays =
                Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
        }
    }

    const nullFields = collectNullFields(core);
    const estimates = await generateStructured<ReturnType<typeof buildEstimatesSchema>>({
        system: buildEstimatesSystemPrompt(context),
        prompt: `${prompt}\n\nFields left unstated: ${nullFields.join(', ') || '(none)'}`,
        schema: buildEstimatesSchema(context),
        maxTokens: 4096,
    });

    let questions = estimates.questions;
    if (questions.length > 4) {
        questions = questions.slice(0, 4);
    }
    for (const question of questions) {
        if (question.options.length > 4) {
            question.options = question.options.slice(0, 4);
        }
    }

    // Anything still unstated that DIDN'T become one of the 4 gap questions gets a modelled
    // default instead of sitting null — a question's own field always wins if the model
    // (incorrectly) also proposed a default for it.
    const questionFields = new Set(questions.map(question => question.field));
    const assumptions: string[] = [];
    for (const entry of estimates.assumedDefaults) {
        const parsed = parseAssumedDefault(entry);
        if (!parsed || questionFields.has(parsed.field)) continue;
        if (!isValidAssumedValue(parsed.field, parsed.value, context)) continue;
        if (applyAssumedDefault(core, parsed.field, parsed.value)) {
            assumptions.push(parsed.field);
        }
    }

    const detail = await detailPromise;

    // Real-data grounding — look up each channel against the ingested rate card instead of
    // trusting detail's modelled guess wherever a real match exists. CPM tier (open vs.
    // audience-targeted) is the same decision for every channel, so it's made once.
    const targeted = hasAudienceSignal(core.audience);
    const realMatches: Record<string, Awaited<ReturnType<typeof matchCtvInventory>>> = {
        ctv: await matchCtvInventory(targeted),
        'mobile-ott': await matchMobileOttInventory(targeted),
        'web-display': await matchWebInventory(core.campaign.category),
    };

    const channels = detail.channels.map(channel => {
        const match = realMatches[channel.id] ?? null;
        return {
            ...channel,
            amount: core.campaign.budget
                ? Math.round((core.campaign.budget * channel.allocation) / 100)
                : 0,
            cpm: match?.cpm ?? null,
            availableImpressions: match?.availableImpressions ?? null,
            source: (match ? 'real' : 'estimate') as 'real' | 'estimate',
        };
    });

    // Real sites replace the modelled ones for any channel that matched; channels with no
    // real data (audio, dooh, or a channel the brief didn't allocate to) keep detail's guess.
    const matchedChannelIds = new Set(Object.keys(realMatches).filter(id => realMatches[id]));
    const sites = [
        ...Object.entries(realMatches)
            .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null)
            .flatMap(([, match]) => match.sites.map(site => ({ ...site, source: 'real' as const }))),
        ...detail.sites
            .filter(site => !matchedChannelIds.has(site.platform))
            .map(site => ({ ...site, source: 'estimate' as const })),
    ];

    const packages = await matchPackages(core.market.country || 'IN', []);

    // Pure arithmetic, never asked of any call — computing it here keeps it always
    // internally consistent instead of trusting a model's math.
    const dailyBudget =
        core.campaign.budget && core.campaign.durationDays
            ? Math.round(core.campaign.budget / core.campaign.durationDays)
            : 0;
    const femaleWeight =
        core.audience.genderSkew === 'male' ? 35 : core.audience.genderSkew === 'female' ? 65 : 50;

    const { availableImpressions, availableUniques, ...inventoryRest } = estimates.inventory;

    return {
        campaign: { ...core.campaign, dailyBudget },
        market: core.market,
        audience: {
            ...core.audience,
            femaleWeight,
            gender: parseSplit(estimates.audience.genderSplit),
            age: parseSplit(estimates.audience.ageSplit),
            geo: parseSplit(estimates.audience.geoSplit),
        },
        inventory: {
            ...inventoryRest,
            source: 'brief',
            available: { impressions: availableImpressions, uniques: availableUniques },
            channels,
            publishers: detail.publishers,
            sites,
            packages: packages.map(p => ({
                packageName: p.packageName,
                details: p.details,
                floorCpm: p.floorCpm,
                device: p.device,
                publishers: p.publishers,
            })),
        },
        summary: {
            ...core.summary,
            basis: 'modelled-estimate',
            impressions: availableImpressions,
            reach: availableUniques,
            availableImpressions,
            availableUniques,
        },
        questions,
        assumptions,
    };
};

const buildInventoryRfpSystemPrompt = (
    iabCategories: string[]
): string => `You are the RFP-parsing engine behind a DOOH/digital media-planning console used by programmatic buyers and sellers in India.

You are given a free-text brief from a media buyer asking about inventory availability, rates (CPM), performance benchmarks (CTR/VTR), premium site/publisher recommendations, or whether a stated goal is achievable. Your job is to structure the request — not answer it with numbers. You have no access to a live rate card or inventory system yourself, so any CPM, availability figure, benchmark percentage, or "yes this goal is achievable" you invented would be handed to a client as if it were fact, and it could be wrong — a separate lookup against a real rate card happens after you, keyed off "targeting.matchedIabCategory" below.

Hard rules — follow every one of these exactly:
1. Extract everything the brief states about targeting into "targeting": geos, category/vertical, platforms or device types, named placements or publishers, audience sources (internal DSP, DV360 segments, etc.), demographics, creative formats, flight duration, and any stated impression/reach goal. Leave anything unstated as null or an empty array. Numbers are raw integers — no shorthand ("1 month" -> durationDays 30, "4M" -> impressionGoal 4000000).
   - "matchedIabCategory" must be exactly one of: ${iabCategories.join(', ') || '(none provided)'} — whichever one genuinely matches this brief's advertiser/product/category, or null if none fit. Not a free description — picking the closest real one is what lets the lookup after you find real inventory.
2. "asks" is the literal list of deliverables the brief is requesting a response to, one short label per ask — e.g. "CPM — Mobile", "VTR benchmark — 15s creative", "Inventory availability — [named placement] [named geo] [category]", "Goal feasibility — [stated goal]", "Recommended premium site list". Build each label from what THIS brief actually says, not from these examples.
3. "suggestedPublisherProperties", "suggestedAdFormats", and "suggestedAudienceSegments" are real, named, checkable things — never a rate, an availability number, or a claim that something is actually available (that's still fabrication, just dressed as a name instead of a number). Ground every name in what THIS brief's own category/publishers/platforms actually are — the patterns below are illustrations of the kind of name to produce, not a fixed list to pick from or match against.
   - "suggestedPublisherProperties": actual named properties under whatever publisher the brief already named (e.g. a brief naming "Network18" could list real Network18 properties like "News18", "Moneycontrol", "CNBC-TV18", "Forbes India" — substitute whatever publisher group this brief actually names). If the brief named a specific platform directly, that's already captured in "targeting.placements" — don't repeat it here unless you're adding a genuinely different, real, named property.
   - "suggestedAdFormats": real, standard industry ad unit names/specs fitting the brief's stated format and platform — e.g. "MREC 300x250", "Leaderboard 728x90", "Native/sponsored content" for display; "Pre-roll (15s/30s, VAST)", "Outstream video" for video; "Host-read audio spot (15s/30s)", "Programmatic audio pre-roll" for audio.
   - "suggestedAudienceSegments": real, named audience-targeting segments from an actual platform taxonomy (DV360 In-Market/Affinity categories, or similar) matching THIS brief's own category — e.g. a travel brief might warrant "In-Market: Travel & Tourism" or "Affinity: Frequent Flyers"; a food brief might warrant "Affinity: Foodies" or "In-Market: Food Delivery Apps" — pick names appropriate to whatever category this brief actually states, not a fixed set.
   - If you aren't confident a name is real, leave it out of the array rather than invent a plausible-sounding one. Empty arrays are fine and expected when nothing fits.
4. "requiresManualInput" lists every entry from "asks" that needs a human — ad ops or sales, using the real rate card and inventory system — to answer before this goes back to the client. In practice that's almost every ask involving a number or a live availability check.
5. "notes" is for anything worth flagging that doesn't fit the structure above.`;

/** True if a platform/device string names the given channel — loose keyword match since "targeting.platforms" is free text the model wrote, not one of the console's fixed channel ids. */
const mentionsPlatform = (platforms: string[], ...keywords: string[]): boolean =>
    platforms.some(p => keywords.some(k => p.toLowerCase().includes(k)));

const toRateCardAnswer = (
    match: Awaited<ReturnType<typeof matchCtvInventory>>
): { cpm: number; availableImpressions: number; topSites: string[] } | null =>
    match
        ? {
              cpm: match.cpm,
              availableImpressions: match.availableImpressions,
              topSites: match.sites.slice(0, 5).map(site => site.name),
          }
        : null;

const runInventoryRfp = async (
    brief: string,
    context: AnalyseContext
): Promise<InventoryRfpFinalResponse> => {
    const iabCategories = await getIabCategories();
    const result = await generateStructured<ReturnType<typeof buildInventoryRfpResponseSchema>>({
        system: buildInventoryRfpSystemPrompt(iabCategories),
        prompt: `Brief:\n"""\n${brief}\n"""`,
        schema: buildInventoryRfpResponseSchema(iabCategories),
        maxTokens: 4096,
    });

    const targeted =
        result.targeting.audienceSources.length > 0 || result.targeting.demographics !== null;
    const { platforms } = result.targeting;

    const [ctv, mobileOtt, web] = await Promise.all([
        mentionsPlatform(platforms, 'ctv', 'connected tv', 'smart tv')
            ? matchCtvInventory(targeted)
            : Promise.resolve(null),
        mentionsPlatform(platforms, 'ott', 'mobile')
            ? matchMobileOttInventory(targeted)
            : Promise.resolve(null),
        matchWebInventory(result.targeting.matchedIabCategory),
    ]);

    return {
        ...result,
        rateCard: {
            ctv: toRateCardAnswer(ctv),
            mobileOtt: toRateCardAnswer(mobileOtt),
            web: toRateCardAnswer(web),
        },
    };
};

export const PROMPT_PROFILES: Record<PromptType, PromptProfile> = {
    'campaign-brief': { run: runCampaignBrief },
    'inventory-rfp': { run: runInventoryRfp },
};

const buildClassifierSystemPrompt = (): string =>
    `You classify a free-text advertising brief sent to a DOOH/digital media-planning console for Indian programmatic buyers, into exactly one of two types.

"campaign-brief": the writer is describing a campaign to plan — advertiser/product, budget, flight, targeting, objective — and expects a media plan (allocations, estimates, audience splits) built from it.
"inventory-rfp": the writer is asking a question about existing inventory or asking for information, not a plan to be built — CPMs, availability, benchmarks (CTR/VTR), whether a goal is feasible, or a request to recommend sites/publishers.

The deciding signal is intent, not vocabulary: if the brief is mostly questions expecting facts/numbers back ("what CPM", "is this available", "can you recommend"), it's "inventory-rfp". If it's describing a campaign and expects a plan back, it's "campaign-brief". When genuinely ambiguous, default to "campaign-brief".`;

/**
 * The caller doesn't have to know this endpoint's internal prompt/schema split — the brief
 * is free text, so the type is inferred from it rather than pushed onto the caller as a
 * required field. A tiny, cheap, single-field classification call (no schema complexity,
 * nothing close to the grammar-size ceiling that shaped every other schema in this file).
 * plan.service.ts only calls this when the request didn't explicitly pass a type — an
 * explicit type (e.g. for testing a specific profile) always wins.
 */
export const classifyBriefType = async (brief: string): Promise<PromptType> => {
    const result = await generateStructured<z.ZodType<{ type: PromptType }>>({
        system: buildClassifierSystemPrompt(),
        prompt: `Brief:\n"""\n${brief}\n"""`,
        schema: z.object({ type: z.enum(PROMPT_TYPES) }) as unknown as z.ZodType<{ type: PromptType }>,
        maxTokens: 16,
    });
    return result.type;
};

export type { AnalyseResponse, InventoryRfpFinalResponse };
