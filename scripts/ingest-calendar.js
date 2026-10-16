#!/usr/bin/env node
/**
 * Loads "<Month> <Year> Viewership Multiplier Calendar" sheets into calendar (see
 * prisma/schema.prisma). Upserted by date, not truncate + reinsert like ingest-inventory.js —
 * each file covers one month, so loading December must not wipe November.
 *
 * Every tab whose header row has Date / CTV Multiplier / App Multiplier / Web Multiplier is read
 * (the Notes tab is skipped). Blank multiplier cells mean "no event override" and are stored as
 * 1.00, per the sheet's own Notes tab.
 *
 * Usage: node scripts/ingest-calendar.js <Calendar.xlsx> [<Calendar.xlsx> ...]
 */
require('dotenv').config();
const XLSX = require('xlsx');
const { PrismaClient } = require('../node_modules/@prisma/client');

const prisma = new PrismaClient();

const REQUIRED_COLUMNS = ['Date', 'CTV Multiplier', 'App Multiplier', 'Web Multiplier'];

/** Accepts a real Excel date serial (what the sheet has) or a "Sun, 01 Nov 2026"-style string; returns a UTC-midnight Date, or null. */
const toDate = value => {
    if (typeof value === 'number') {
        const d = XLSX.SSF.parse_date_code(value);
        return d ? new Date(Date.UTC(d.y, d.m - 1, d.d)) : null;
    }
    if (value instanceof Date) return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    const parsed = new Date(`${String(value).replace(/^\w+,\s*/, '')} UTC`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** 1.25 or "1.25x" -> 1.25; blank -> 1 (no override). Anything else unparseable throws rather than silently becoming 1. */
const toMultiplier = (value, where) => {
    if (value === null || value === undefined || value === '') return 1;
    const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/x$/i, ''));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad multiplier "${value}" at ${where}`);
    return n;
};

const readCalendarRows = workbook => {
    const days = [];
    for (const sheetName of workbook.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
        if (rows.length === 0 || !REQUIRED_COLUMNS.every(c => c in rows[0])) continue;
        rows.forEach((r, i) => {
            const where = `${sheetName} row ${i + 2}`;
            const date = toDate(r['Date']);
            if (!date) throw new Error(`Bad date "${r['Date']}" at ${where}`);
            const event = r['Event'] === null || String(r['Event']).trim() === '' ? null : String(r['Event']).trim();
            days.push({
                date,
                event,
                ctvMultiplier: toMultiplier(r['CTV Multiplier'], where),
                appMultiplier: toMultiplier(r['App Multiplier'], where),
                webMultiplier: toMultiplier(r['Web Multiplier'], where),
            });
        });
    }
    return days;
};

async function main() {
    const paths = process.argv.slice(2);
    if (paths.length === 0) {
        console.error('Usage: node scripts/ingest-calendar.js <Calendar.xlsx> [<Calendar.xlsx> ...]');
        process.exit(1);
    }

    for (const path of paths) {
        const days = readCalendarRows(XLSX.readFile(path));
        if (days.length === 0) throw new Error(`No calendar tab found in ${path}`);
        await prisma.$transaction(
            days.map(({ date, ...rest }) =>
                prisma.calendar.upsert({ where: { date }, create: { date, ...rest }, update: rest })
            )
        );
        const iso = d => d.toISOString().slice(0, 10);
        console.log(`${path}: ${days.length} days (${iso(days[0].date)} to ${iso(days[days.length - 1].date)})`);
    }

    await prisma.$disconnect();
}

main().catch(async err => {
    console.error('Calendar ingestion failed:', err);
    await prisma.$disconnect();
    process.exit(1);
});
