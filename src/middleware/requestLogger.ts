import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { AuthenticatedUser } from '../types/common.types';

export interface RequestWithId extends Request {
    requestId?: string;
    requestStartTime?: number;
    user?: AuthenticatedUser;
}

export const requestLogger = (req: RequestWithId, res: Response, next: NextFunction) => {
    req.requestId = uuidv4();
    req.requestStartTime = Date.now();

    const originalEnd = res.end;
    // @ts-ignore - overriding to capture completion timing without changing the signature callers see
    res.end = function (chunk: any, encoding?: any) {
        const duration = Date.now() - (req.requestStartTime || Date.now());
        logger.logRequest(req.method, req.originalUrl || req.url, res.statusCode, duration);
        originalEnd.call(this, chunk, encoding);
    };

    next();
};
