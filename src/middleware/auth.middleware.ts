import { NextFunction, Response } from 'express';
import * as admin from 'firebase-admin';
import { config } from '../config/environment';
import { ApiError } from '../utils/apiError';
import { RequestWithId } from './requestLogger';

/**
 * Verifies the Firebase ID token issued by the console's Google/email sign-in, OR a static
 * long-lived TEST_API_TOKEN (config.testToken) — a Firebase ID token always expires in an
 * hour, so anyone testing without going through the real sign-in flow (e.g. a colleague
 * using the /tester page) needs something that doesn't. Checked first since it's a plain
 * string compare, no network round-trip; unset in prod unless TEST_API_TOKEN is deliberately
 * configured. There is no role/permission system in this app — every authenticated caller,
 * real or test-token, has the same access.
 */
export const authenticateBearer = async (req: RequestWithId, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new ApiError(401, 'Bearer token required');
        }

        const token = authHeader.split(' ')[1];

        if (config.testToken && token === config.testToken) {
            req.user = { uid: 'test-token', email: 'test-token@spendoptix.local', name: 'Test token' };
            return next();
        }

        const decoded = await admin.auth().verifyIdToken(token);

        req.user = { uid: decoded.uid, email: decoded.email, name: decoded.name };
        next();
    } catch (error) {
        if (error instanceof ApiError) {
            next(error);
        } else {
            next(new ApiError(401, 'Invalid or expired token'));
        }
    }
};
