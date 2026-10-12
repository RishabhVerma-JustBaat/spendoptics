import prisma from '../prisma/prisma.config';
import { ApiError } from '../utils/apiError';
import { PlanDocument, PlanSaveRequest } from '../types/plan.types';

// prisma.mediaPlan / the `media_plans` table keep their existing names — this class is a thin
// wrapper around that table, no DB rename needed just because the wrapper's name changed.
type PlanRow = Awaited<ReturnType<typeof prisma.mediaPlan.upsert>>;

const toDocument = (row: PlanRow): PlanDocument => ({
    schemaVersion: row.schemaVersion,
    planId: row.planId,
    savedAt: row.savedAt.toISOString(),
    source: row.source as PlanDocument['source'],
    brief: row.brief as PlanDocument['brief'],
    campaign: row.campaign as PlanDocument['campaign'],
    market: row.market as PlanDocument['market'],
    audience: row.audience as PlanDocument['audience'],
    inventory: row.inventory as PlanDocument['inventory'],
    forecast: row.forecast as PlanDocument['forecast'],
    approval: {
        approved: row.approved,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    },
});

export class PlanService {
    /** Upsert on planId — saving again updates the same record instead of creating another. */
    async save(payload: PlanSaveRequest): Promise<{ id: string; savedAt: string }> {
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

    async getById(planId: string): Promise<PlanDocument> {
        const row = await prisma.mediaPlan.findUnique({ where: { planId } });

        if (!row) {
            throw new ApiError(404, 'Plan not found');
        }

        return toDocument(row);
    }

    async list(limit = 50): Promise<PlanDocument[]> {
        const rows = await prisma.mediaPlan.findMany({
            orderBy: { savedAt: 'desc' },
            take: limit,
        });

        return rows.map(toDocument);
    }

    /** Marks a saved plan approved. Idempotent — approving again just refreshes who/when. */
    async approve(planId: string, approvedBy: string): Promise<PlanDocument> {
        try {
            const row = await prisma.mediaPlan.update({
                where: { planId },
                data: { approved: true, approvedBy, approvedAt: new Date() },
            });

            return toDocument(row);
        } catch (error: any) {
            if (error?.code === 'P2025') {
                throw new ApiError(404, 'Plan not found');
            }
            throw error;
        }
    }
}
