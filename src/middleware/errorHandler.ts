import { NextFunction, Response } from 'express';
import { config } from '../config/environment';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { RequestWithId } from './requestLogger';
import { sendError } from '../utils/apiResponse';

export const errorHandler = (error: any, req: RequestWithId, res: Response, next: NextFunction) => {
    let statusCode = 500;
    let message = 'Internal Server Error';

    if (error instanceof ApiError) {
        statusCode = error.statusCode;
        message = error.message;
    } else if (error?.name === 'ValidationError') {
        statusCode = 400;
        message = error.message;
    }

    logger.error(`Request failed: ${message}`, error, {
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        userId: req.user?.uid,
        statusCode,
    });

    sendError(req, res, statusCode, message, config.isDebug ? error?.stack : undefined);
};
