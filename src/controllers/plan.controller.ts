import { NextFunction, Response } from 'express';
import { PlanService } from '../services/plan.service';
import { sendResponse } from '../utils/apiResponse';
import { RequestWithId } from '../middleware/requestLogger';
import { AnalyseRequestBody } from '../types/plan.types';

export class PlanController {
    private planService = new PlanService();

    analyseBrief = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const { brief, type, context } = req.body as AnalyseRequestBody;

            const data = await this.planService.analyseBrief(brief, type, context);

            sendResponse(req, res, 200, 'Brief analysed', data);
        } catch (error) {
            next(error);
        }
    };
}
