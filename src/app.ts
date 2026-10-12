import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config } from './config/environment';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { planRoutes } from './routes/plan.routes';
import { mediaPlanRoutes } from './routes/media-plan.routes';
import { aiPlannerRoutes } from './routes/ai-planner.routes';

// The raw Express app, shared by both hosting modes: functions/api/spendoptix_api.ts wraps
// it for Firebase Functions, server.ts calls app.listen() directly for standalone/PM2 hosting.
export const app = express();

app.use(helmet());
app.use(
    cors({
        origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
    })
);
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(config.isDebug ? 'dev' : 'combined'));
app.use(requestLogger);

app.use('/plan', planRoutes);
app.use('/media-plans', mediaPlanRoutes);
// Versioned — a clean-slate route, unlike the legacy, unversioned routes above it.
app.use('/api/v1/planner', aiPlannerRoutes);

// A small static test page for hitting /plan/analyse and /media-plans without Postman —
// same-origin as the API, so it needs no CORS setup and no extra hosting of its own.
// process.cwd()-relative, same reasoning as server.ts's service-account path: PM2 runs
// this with cwd = project root, where the public/ folder actually lives.
app.use('/tester', express.static(path.resolve(process.cwd(), 'public')));

// The onespend box's haproxy does `GET / ` expecting 200/307/308 as its backend health
// check (see ops haproxy.cfg) — without this, haproxy marks the app down even while it's
// healthy, since there was previously no route at all here (a bare 404).
app.get('/', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        environment: config.projectId,
        timestamp: new Date().toISOString(),
    });
});

app.use(errorHandler);

app.use('*', (req, res) => {
    res.status(404).json({ message: 'Route not found' });
});
