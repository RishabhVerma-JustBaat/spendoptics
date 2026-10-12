import { Router } from 'express';
import { authenticateBearer } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { generatePlanSchema, savePlanSchema, suggestPromptSchema } from '../validations/planner.validations';
import { PlannerController } from '../controllers/planner.controller';

const router = Router();
const plannerController = new PlannerController();

// Resource-oriented, not verb-oriented: a "suggestion" (Call 1, prompt -> pre-filled draft) and
// a "plan" (Call 2 result, and the thing listed/fetched/created/approved once saved) are each
// their own resource. All mounted under /api/v1/planner in app.ts.
router.post('/suggestions', authenticateBearer, validateBody(suggestPromptSchema), plannerController.suggest);

// /plans (plural) generates and lists; /plan (singular) is the one place a new saved record
// actually gets created, with a server-minted id (see planner.service.ts's create() comment
// for why the id is never trusted from the caller here).
router.post('/plans', authenticateBearer, validateBody(generatePlanSchema), plannerController.generate);
router.get('/plans', authenticateBearer, plannerController.list);
router.get('/plans/:planId', authenticateBearer, plannerController.getById);
router.post('/plan', authenticateBearer, validateBody(savePlanSchema), plannerController.create);
// PUT, not POST — idempotent create-or-replace at a known id, for a caller that already has one
// (e.g. re-saving after an edit), unlike POST /plan above which always mints a new id.
router.put('/plans/:planId', authenticateBearer, validateBody(savePlanSchema), plannerController.save);
router.post('/plans/:planId/approve', authenticateBearer, plannerController.approve);

export { router as plannerRoutes };
