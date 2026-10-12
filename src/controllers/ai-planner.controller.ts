import { NextFunction, Response } from 'express';
import { AiPlannerService } from '../services/ai-planner.service';
import { sendResponse } from '../utils/apiResponse';
import { RequestWithId } from '../middleware/requestLogger';
import { PlannerInput } from '../types/ai-planner.types';

export class AiPlannerController {
    private aiPlannerService = new AiPlannerService();

    suggest = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const { prompt } = req.body as { prompt: string };
            const data = await this.aiPlannerService.suggest(prompt);
            sendResponse(req, res, 200, 'Suggestions generated', data);
        } catch (error) {
            next(error);
        }
    };

    generate = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const input = req.body as PlannerInput;
            const data = await this.aiPlannerService.generate(input);
            sendResponse(req, res, 200, 'Plan generated', data);
        } catch (error) {
            next(error);
        }
    };
}
