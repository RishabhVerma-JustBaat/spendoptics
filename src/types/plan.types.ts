export interface PlanSource {
    app: string;
    trigger: string;
}

export interface PlanBrief {
    text: string;
    parsed: Record<string, unknown>;
    answers: Record<string, string>;
}

export interface PlanApproval {
    approved: boolean;
    approvedBy: string | null;
    approvedAt: string | null;
}

/**
 * The ten top-level keys from the save payload are the contract — never renamed, re-typed, or
 * removed. `approval` is set only by POST /api/v1/planner/plans/:planId/approve, never by a
 * save call — consumers that don't know it yet can ignore it like any other
 * forward-compatible field.
 *
 * campaign/market/audience/inventory/forecast are intentionally untyped beyond "an object" —
 * nothing validates their shape beyond "is an object" (see planner.validations.ts's
 * savePlanSchema) — planner.service.ts's toPlanSaveRequest fills these five keys with whatever
 * shape a GeneratedPlan happens to produce, and that shape is free to change without this type
 * needing to change too.
 */
export interface PlanDocument {
    schemaVersion: number;
    planId: string;
    savedAt: string;
    source: PlanSource;
    brief: PlanBrief;
    campaign: Record<string, unknown>;
    market: Record<string, unknown>;
    audience: Record<string, unknown>;
    inventory: Record<string, unknown>;
    forecast: Record<string, unknown>;
    approval: PlanApproval;
}

/** What the client sends. planId is stable per planning session and drives the upsert; savedAt and approval are server-owned. */
export type PlanSaveRequest = Omit<PlanDocument, 'savedAt' | 'approval'>;
