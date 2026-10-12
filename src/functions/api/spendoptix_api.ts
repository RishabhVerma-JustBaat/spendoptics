import * as functions from 'firebase-functions';
import { app } from '../../app';

export const spendoptix_api = functions
    .runWith({
        timeoutSeconds: 120,
        memory: '512MB',
    })
    .region('asia-south1')
    .https.onRequest(app);
