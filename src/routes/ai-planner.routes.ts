import { Router } from 'express';
import { authenticateBearer } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { generatePlanSchema, suggestPromptSchema } from '../validations/ai-planner.validations';
import { AiPlannerController } from '../controllers/ai-planner.controller';

const router = Router();
const aiPlannerController = new AiPlannerController();

// Resource-oriented, not verb-oriented: POST to a collection creates a new resource in it —
// a "suggestion" (Call 1, prompt -> pre-filled draft) and a "plan" (Call 2, vetted draft ->
// generated plan) are each their own thing, not actions on some other resource. Mounted at
// /api/v1/planner in app.ts; versioned since this is a clean-slate route, unlike the legacy
// /plan and /media-plans routes it sits alongside.
router.post('/suggestions', authenticateBearer, validateBody(suggestPromptSchema), aiPlannerController.suggest);
router.post('/plans', authenticateBearer, validateBody(generatePlanSchema), aiPlannerController.generate);

export { router as aiPlannerRoutes };
