export interface EnvironmentConfig {
    projectId: string;
    isDebug: boolean;
    allowedOrigins: string[];
    /** A long-lived, non-expiring alternate credential for authenticateBearer — see its comment. */
    testToken?: string;
    bedrock: {
        region: string;
        /** Bedrock's bearer-token API key auth — preferred when set; see bedrock.service.ts. */
        apiKey?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        modelId: string;
    };
    /** Flat markup on every rate-card CPM — the planner quotes clients cost × (1 + this/100), and the difference is our commission. */
    plannerMarginPercent: number;
}

const getConfig = (): EnvironmentConfig => {
    const projectId = process.env.GCLOUD_PROJECT || 'spendoptix-dev';

    return {
        projectId,
        isDebug: process.env.NODE_ENV !== 'production',
        allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '*').split(','),
        testToken: process.env.TEST_API_TOKEN,
        bedrock: {
            region: process.env.AWS_REGION || 'us-east-1',
            apiKey: process.env.BEDROCK_API_KEY,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-opus-5',
        },
        plannerMarginPercent: Number(process.env.PLANNER_MARGIN_PERCENT ?? 10),
    };
};

export const config = Object.freeze(getConfig());
