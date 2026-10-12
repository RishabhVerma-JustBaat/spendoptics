import { NextFunction, Response } from 'express';
import { PlannerService } from '../services/planner.service';
import { sendResponse } from '../utils/apiResponse';
import { RequestWithId } from '../middleware/requestLogger';
import { GeneratedPlan, PlannerInput } from '../types/planner.types';

export class PlannerController {
    private plannerService = new PlannerService();

    suggest = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const { prompt } = req.body as { prompt: string };
            const data = await this.plannerService.suggest(prompt);
            sendResponse(req, res, 200, 'Suggestions generated', data);
        } catch (error) {
            next(error);
        }
    };

    generate = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const input = req.body as PlannerInput;
            const data = await this.plannerService.generate(input);
            sendResponse(req, res, 200, 'Plan generated', data);
        } catch (error) {
            next(error);
        }
    };

    create = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const { input, plan } = req.body as { input: PlannerInput; plan: GeneratedPlan };
            const data = await this.plannerService.create(input, plan);
            sendResponse(req, res, 201, 'Plan created', data);
        } catch (error) {
            next(error);
        }
    };

    save = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const { planId } = req.params;
            const { input, plan } = req.body as { input: PlannerInput; plan: GeneratedPlan };
            const data = await this.plannerService.save(planId, input, plan);
            sendResponse(req, res, 200, 'Plan saved', data);
        } catch (error) {
            next(error);
        }
    };

    list = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const limit = req.query.limit ? Number(req.query.limit) : undefined;
            const data = await this.plannerService.list(limit);
            sendResponse(req, res, 200, 'Plans', data);
        } catch (error) {
            next(error);
        }
    };

    getById = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const data = await this.plannerService.getById(req.params.planId);
            sendResponse(req, res, 200, 'Plan', data);
        } catch (error) {
            next(error);
        }
    };

    approve = async (req: RequestWithId, res: Response, next: NextFunction) => {
        try {
            const data = await this.plannerService.approve(req.params.planId, req.user!.uid);
            sendResponse(req, res, 200, 'Plan approved', data);
        } catch (error) {
            next(error);
        }
    };
}
