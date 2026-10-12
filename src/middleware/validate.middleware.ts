import { NextFunction, Response } from 'express';
import { ObjectSchema } from 'joi';
import { ApiError } from '../utils/apiError';
import { RequestWithId } from './requestLogger';

export const validateBody =
    (schema: ObjectSchema) => (req: RequestWithId, res: Response, next: NextFunction) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: false,
        });

        if (error) {
            next(new ApiError(400, error.details.map(d => d.message).join('; ')));
            return;
        }

        req.body = value;
        next();
    };
