import { Router } from 'express';
import { authenticateBearer } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { generatePlanSchema, savePlanSchema, suggestPromptSchema } from '../validations/planner.validations';
import { PlannerController } from '../controllers/planner.controller';

const router = Router();
const plannerController = new PlannerController();

// Resource-oriented, not verb-oriented: a "suggestion" (Call 1, prompt -> pre-filled draft) and
// a "plan" (Call 2 result, and the thing listed/fetched/approved once saved) are each their own
// resource. All mounted under /api/v1/planner in app.ts.
router.post('/suggestions', authenticateBearer, validateBody(suggestPromptSchema), plannerController.suggest);

router.post('/plans', authenticateBearer, validateBody(generatePlanSchema), plannerController.generate);
router.get('/plans', authenticateBearer, plannerController.list);
router.get('/plans/:planId', authenticateBearer, plannerController.getById);
// PUT, not POST — idempotent create-or-replace at a known id, unlike POST /plans above which
// always mints a new generated result.
router.put('/plans/:planId', authenticateBearer, validateBody(savePlanSchema), plannerController.save);
router.post('/plans/:planId/approve', authenticateBearer, plannerController.approve);

export { router as plannerRoutes };
