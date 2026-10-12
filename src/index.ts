import * as admin from 'firebase-admin';

// No explicit service account: Cloud Functions injects default credentials at
// deploy time, and the Firebase emulator / `gcloud auth application-default
// login` supplies them for local runs.
if (!admin.apps.length) {
    admin.initializeApp();
}

export * from './functions';
