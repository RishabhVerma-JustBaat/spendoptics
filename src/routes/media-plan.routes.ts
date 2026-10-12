import { Router } from 'express';
import { authenticateBearer } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { saveMediaPlanSchema } from '../validations/media-plan.validations';
import { MediaPlanController } from '../controllers/media-plan.controller';

const router = Router();
const mediaPlanController = new MediaPlanController();

router.get('/', authenticateBearer, mediaPlanController.list);
router.post('/', authenticateBearer, validateBody(saveMediaPlanSchema), mediaPlanController.save);
// Declared last so it never shadows '/' above.
router.get('/:planId', authenticateBearer, mediaPlanController.getById);
router.post('/:planId/approve', authenticateBearer, mediaPlanController.approve);

export { router as mediaPlanRoutes };
