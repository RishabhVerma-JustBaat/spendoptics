import prisma from '../prisma/prisma.config';
import { ApiError } from '../utils/apiError';
import { MediaPlanDocument, MediaPlanSaveRequest } from '../types/media-plan.types';

type MediaPlanRow = Awaited<ReturnType<typeof prisma.mediaPlan.upsert>>;

const toDocument = (row: MediaPlanRow): MediaPlanDocument => ({
    schemaVersion: row.schemaVersion,
    planId: row.planId,
    savedAt: row.savedAt.toISOString(),
    source: row.source as MediaPlanDocument['source'],
    brief: row.brief as MediaPlanDocument['brief'],
    campaign: row.campaign as MediaPlanDocument['campaign'],
    market: row.market as MediaPlanDocument['market'],
    audience: row.audience as MediaPlanDocument['audience'],
    inventory: row.inventory as MediaPlanDocument['inventory'],
    forecast: row.forecast as MediaPlanDocument['forecast'],
    approval: {
        approved: row.approved,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    },
});

export class MediaPlanService {
    /** Upsert on planId — re-opening section E updates the same record instead of creating another. */
    async save(payload: MediaPlanSaveRequest): Promise<{ id: string; savedAt: string }> {
        const {
            planId,
            schemaVersion,
            source,
            brief,
            campaign,
            market,
            audience,
            inventory,
            forecast,
        } = payload;

        const data = {
            schemaVersion,
            source,
            brief,
            campaign,
            market,
            audience,
            inventory,
            forecast,
        };

        // savedAt is left out of `data` on purpose — it's @updatedAt in the schema, so Prisma
        // stamps it with the current time on both the create and update branch below.
        const row = await prisma.mediaPlan.upsert({
            where: { planId },
            create: { planId, ...data },
            update: data,
        });

        return { id: row.planId, savedAt: row.savedAt.toISOString() };
    }

    async getById(planId: string): Promise<MediaPlanDocument> {
        const row = await prisma.mediaPlan.findUnique({ where: { planId } });

        if (!row) {
            throw new ApiError(404, 'Media plan not found');
        }

        return toDocument(row);
    }

    async list(limit = 50): Promise<MediaPlanDocument[]> {
        const rows = await prisma.mediaPlan.findMany({
            orderBy: { savedAt: 'desc' },
            take: limit,
        });

        return rows.map(toDocument);
    }

    /** Marks a saved plan approved. Idempotent — approving again just refreshes who/when. */
    async approve(planId: string, approvedBy: string): Promise<MediaPlanDocument> {
        try {
            const row = await prisma.mediaPlan.update({
                where: { planId },
                data: { approved: true, approvedBy, approvedAt: new Date() },
            });

            return toDocument(row);
        } catch (error: any) {
            if (error?.code === 'P2025') {
                throw new ApiError(404, 'Media plan not found');
            }
            throw error;
        }
    }
}
