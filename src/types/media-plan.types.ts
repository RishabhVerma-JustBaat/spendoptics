export interface MediaPlanFlight {
    start: string | null;
    end: string | null;
    durationDays: number | null;
}

export interface MediaPlanCampaign {
    name: string | null;
    advertiser: string | null;
    product: string | null;
    objective: string | null;
    kpi: string | null;
    budget: number | null;
    currency: string;
    flight: MediaPlanFlight;
}

export interface MediaPlanMarket {
    country: string;
    geos: string[];
}

export interface MediaPlanAudienceSplit {
    label: string;
    percent: number;
}

export interface MediaPlanAudience {
    basis: string;
    gender: MediaPlanAudienceSplit[];
    age: MediaPlanAudienceSplit[];
    geo: MediaPlanAudienceSplit[];
}

export interface MediaPlanChannelAllocation {
    id: string;
    name: string;
    allocation: number;
    amount: number;
    rows: number;
    impressions: number;
    uniques: number;
}

export interface MediaPlanPublisher {
    name: string;
    rows: number;
    impressions: number;
}

export interface MediaPlanTopSite {
    name: string;
    identifier: string;
    impressions: number;
    uniques: number;
}

export interface MediaPlanInventory {
    source: 'selection' | 'brief' | 'all';
    rows: number;
    available: { impressions: number; uniques: number };
    channels: MediaPlanChannelAllocation[];
    publishers: MediaPlanPublisher[];
    topSites: MediaPlanTopSite[];
    unmatchedTerms: string[];
}

export interface MediaPlanForecast {
    basis: string;
    impressions: number | null;
    reach: number | null;
    availableImpressions: number | null;
    availableUniques: number | null;
    goal: number | null;
}

export interface MediaPlanSource {
    app: string;
    trigger: string;
}

export interface MediaPlanBrief {
    text: string;
    parsed: Record<string, unknown>;
    answers: Record<string, string>;
}

export interface MediaPlanApproval {
    approved: boolean;
    approvedBy: string | null;
    approvedAt: string | null;
}

/**
 * The ten top-level keys from the save payload are the contract — never renamed, re-typed, or
 * removed. `approval` is set only by POST /media-plans/:planId/approve, never by a save call —
 * consumers that don't know it yet can ignore it like any other forward-compatible field.
 */
export interface MediaPlanDocument {
    schemaVersion: number;
    planId: string;
    savedAt: string;
    source: MediaPlanSource;
    brief: MediaPlanBrief;
    campaign: MediaPlanCampaign;
    market: MediaPlanMarket;
    audience: MediaPlanAudience;
    inventory: MediaPlanInventory;
    forecast: MediaPlanForecast;
    approval: MediaPlanApproval;
}

/** What the client sends. planId is stable per planning session and drives the upsert; savedAt and approval are server-owned. */
export type MediaPlanSaveRequest = Omit<MediaPlanDocument, 'savedAt' | 'approval'>;
