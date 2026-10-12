import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import * as admin from 'firebase-admin';
import { config } from './config/environment';
import { app } from './app';
import { logger } from './utils/logger';

// Standalone entry point for hosting outside Firebase Functions (e.g. a PM2-managed VPS
// process). functions/api/spendoptix_api.ts is the Firebase Functions entry point instead —
// both wrap the same app from ./app.
//
// On real Firebase infra, admin.initializeApp() resolves credentials automatically. Here it
// doesn't, so we point it at an explicit service account file instead — the same Firebase
// project VisionPlayBackend's frontend already authenticates against (that frontend is
// shared with this console), copied in as <projectId>-firebase-adminsdk.json at the project
// root (gitignored — see .gitignore). Falls back to the ADC-based initializeApp() if that
// file isn't present, e.g. if this ever does run on infra where ADC is actually available.
if (!admin.apps.length) {
    const serviceAccountPath = path.resolve(
        process.cwd(),
        `${config.projectId}-firebase-adminsdk.json`
    );

    if (fs.existsSync(serviceAccountPath)) {
        admin.initializeApp({
            credential: admin.credential.cert(require(serviceAccountPath)),
        });
    } else {
        logger.warn('No service account file found for standalone hosting; falling back to ADC', {
            serviceAccountPath,
        });
        admin.initializeApp();
    }
}

const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
    logger.info(`SpendOptix backend listening on port ${port}`);
});
