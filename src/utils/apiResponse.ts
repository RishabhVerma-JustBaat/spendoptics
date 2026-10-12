import { Response } from 'express';
import { ApiResponse } from '../types/common.types';
import { RequestWithId } from '../middleware/requestLogger';

export const sendResponse = <T>(
    req: RequestWithId,
    res: Response,
    statusCode: number,
    message: string,
    data?: T
): Response => {
    const response: ApiResponse<T> = {
        success: statusCode < 400,
        message,
        requestId: req.requestId,
        data,
    };

    return res.status(statusCode).json(response);
};

export const sendError = (
    req: RequestWithId,
    res: Response,
    statusCode: number,
    message: string,
    error?: string
): Response => {
    const response: ApiResponse = {
        success: false,
        message,
        requestId: req.requestId,
        error,
    };

    return res.status(statusCode).json(response);
};
