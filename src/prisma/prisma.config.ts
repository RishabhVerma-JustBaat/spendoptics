import { PrismaClient } from '@prisma/client';

let _instance: PrismaClient | undefined;

function getInstance(): PrismaClient {
    if (_instance) return _instance;

    const client = new PrismaClient(
        process.env.NODE_ENV !== 'production'
            ? { log: ['query', 'info', 'warn', 'error'] }
            : undefined
    );

    if (process.env.NODE_ENV !== 'production') {
        (global as any).__prisma ??= client;
        _instance = (global as any).__prisma;
    } else {
        _instance = client;
    }

    return _instance!;
}

const prisma = new Proxy({} as PrismaClient, {
    get(_: any, prop: string | symbol) {
        return Reflect.get(getInstance(), prop);
    },
});

export default prisma;
