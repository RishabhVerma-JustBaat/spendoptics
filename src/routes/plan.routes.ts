import { Router } from 'express';
import { authenticateBearer } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { analyseBriefSchema } from '../validations/plan.validations';
import { PlanController } from '../controllers/plan.controller';

const router = Router();
const planController = new PlanController();

router.post(
    '/analyse',
    authenticateBearer,
    validateBody(analyseBriefSchema),
    planController.analyseBrief
);

export { router as planRoutes };
