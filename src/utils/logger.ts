/* eslint-disable no-console */
class Logger {
    info(message: string, context?: Record<string, unknown>) {
        console.log(JSON.stringify({ level: 'info', message, ...context }));
    }

    warn(message: string, context?: Record<string, unknown>) {
        console.warn(JSON.stringify({ level: 'warn', message, ...context }));
    }

    error(message: string, error?: unknown, context?: Record<string, unknown>) {
        console.error(
            JSON.stringify({
                level: 'error',
                message,
                error:
                    error instanceof Error ? { message: error.message, stack: error.stack } : error,
                ...context,
            })
        );
    }

    logRequest(method: string, url: string, statusCode: number, durationMs: number) {
        this.info('request completed', { method, url, statusCode, durationMs });
    }
}

export const logger = new Logger();
