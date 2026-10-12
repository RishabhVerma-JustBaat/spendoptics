import { NextFunction, Response } from 'express';
import { MediaPlanService } from '../services/media-plan.service';
import { sendResponse } from '../utils/apiResponse';
import { RequestWithId } from '../middleware/requestLogger';
import { MediaPlanSaveRequest } from '../types/media-plan.types';

export class MediaPlanController {
    private mediaPlanService = new MediaPlanService();

    save = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const data = await this.mediaPlanService.save(req.body as MediaPlanSaveRequest);

            sendResponse(req, res, 200, 'Media plan saved', data);
        } catch (error) {
            next(error);
        }
    };

    list = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const limit = req.query.limit ? Number(req.query.limit) : undefined;
            const data = await this.mediaPlanService.list(limit);

            sendResponse(req, res, 200, 'Media plans', data);
        } catch (error) {
            next(error);
        }
    };

    getById = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const data = await this.mediaPlanService.getById(req.params.planId);

            sendResponse(req, res, 200, 'Media plan', data);
        } catch (error) {
            next(error);
        }
    };

    approve = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const data = await this.mediaPlanService.approve(req.params.planId, req.user!.uid);

            sendResponse(req, res, 200, 'Media plan approved', data);
        } catch (error) {
            next(error);
        }
    };
}
