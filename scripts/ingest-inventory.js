#!/usr/bin/env node
/**
 * Loads the rate-card/inventory spreadsheets into the inventory_* reference tables
 * (see prisma/schema.prisma). Truncate + reinsert, not an upsert — there's no stable natural
 * key worth tracking across sheet versions, and these are read-only reference tables with no
 * foreign keys pointing at them.
 *
 * Usage: node scripts/ingest-inventory.js <Packages.xlsx> <RoughUploadingData.xlsx> <MasterSheet.xlsx> [WebsiteDemographics.xlsx]
 *        node scripts/ingest-inventory.js --embeddings
 *
 * --embeddings fills inventory_embeddings (one Titan v2 embedding per distinct inventory name,
 * for the planner's semantic match score and alternative suggestions). Only names not stored
 * yet are embedded, so re-running it after a sheet update costs only the new names. Run it after
 * every inventory ingest; the API caches embeddings per process, so restart it afterwards.
 */
require('dotenv').config();
const XLSX = require('xlsx');
const { PrismaClient } = require('../node_modules/@prisma/client');

const prisma = new PrismaClient();

const toInt = value => Math.round(Number(value) || 0);
const toBigInt = value => BigInt(Math.round(Number(value) || 0));
const toFloat = value => Number(value) || 0;
const toStr = value => (value === null || value === undefined ? '' : String(value).trim());
const toNullableStr = value => (value === null || value === undefined || value === '' ? null : String(value).trim());

/**
 * Parses the sheet's single free-text "Demographics" column (e.g. "Male 59%, Female 41%; Age
 * 18-24 22%, 25-34 29%, 35-44 24%, 45-54 16%, 55+ 9%") into real percentages. Positional, not
 * matched by band label text — verified live against all 30,585 real rows in the source file,
 * every single one has exactly this shape (gender first, then exactly 5 age bands in this exact
 * order), so position is reliable and sidesteps the sheet's en-dash character ("18–24") that's
 * easy to get wrong matching by label. Returns all nulls if the string doesn't parse — never a
 * guessed percentage.
 */
const parseDemographics = str => {
    const empty = {
        genderMalePct: null,
        genderFemalePct: null,
        age1824Pct: null,
        age2534Pct: null,
        age3544Pct: null,
        age4554Pct: null,
        age55PlusPct: null,
    };
    if (!str) return empty;
    const [genderPart, agePart] = str.split(';').map(s => s.trim());
    if (!genderPart || !agePart) return empty;

    const genders = [...genderPart.matchAll(/(\w+)\s+([\d.]+)%/g)];
    const ages = [...agePart.replace(/^Age\s*/i, '').matchAll(/\S+\s+([\d.]+)%/g)].map(m => Number(m[1]));
    if (genders.length !== 2 || ages.length !== 5) return empty;

    const male = genders.find(g => g[1].toLowerCase() === 'male');
    const female = genders.find(g => g[1].toLowerCase() === 'female');
    const [age1824, age2534, age3544, age4554, age55Plus] = ages;
    return {
        genderMalePct: male ? Number(male[2]) : null,
        genderFemalePct: female ? Number(female[2]) : null,
        age1824Pct: age1824,
        age2534Pct: age2534,
        age3544Pct: age3544,
        age4554Pct: age4554,
        age55PlusPct: age55Plus,
    };
};

/**
 * Parses the sheet's "CTR/VCR" column, a string like "65%+" or "0.20%+" (always a trailing "%",
 * sometimes a "+") into a plain 0-100 percentage number. Verified live against all 30,585 rows in
 * the 2026-10-14 source file — zero format mismatches. Returns null (not 0) for anything that
 * doesn't match, since 0 would misreport "no data" as "zero percent".
 */
const parseCtrVcrPercent = str => {
    if (!str) return null;
    const match = String(str).match(/^([\d.]+)%/);
    return match ? Number(match[1]) : null;
};

/**
 * Parses the sheet's single free-text "Wallet size" column (e.g. "T1 Premium (₹1,00,000+
 * household/month) 8%, T2 Upper-middle (₹60,000–₹99,999) 17%, T3 Middle (₹30,000–₹59,999) 30%,
 * T4 Lower-middle (₹15,000–₹29,999) 28%, T5 Value (under ₹15,000) 17%") into the 5 tier
 * percentages. Positional like parseDemographics above — verified live that all 30,585 rows have
 * exactly this shape (same 5 tiers, same order, every time), so the tier labels/income ranges
 * aren't stored at all (a fixed, repeated taxonomy, not real per-row data); only the percentages
 * that actually vary are kept.
 */
const parseWalletSize = str => {
    const empty = {
        walletT1Pct: null,
        walletT2Pct: null,
        walletT3Pct: null,
        walletT4Pct: null,
        walletT5Pct: null,
    };
    if (!str) return empty;
    const pcts = [...String(str).matchAll(/(\d+(?:\.\d+)?)%/g)].map(m => Number(m[1]));
    if (pcts.length !== 5) return empty;
    const [walletT1Pct, walletT2Pct, walletT3Pct, walletT4Pct, walletT5Pct] = pcts;
    return { walletT1Pct, walletT2Pct, walletT3Pct, walletT4Pct, walletT5Pct };
};

/** Reads a sheet as a raw array-of-arrays (not object-keyed) — one of this data's sheets has a trailing column with no header, which sheet_to_json's default object mode silently drops. */
const readRows = (workbook, sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
    return rows.slice(1); // drop header row
};

const BATCH_SIZE = 2000;
const insertInBatches = async (model, rows) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        await model.createMany({ data: rows.slice(i, i + BATCH_SIZE) });
    }
};

async function ingestPackages(workbook) {
    const rows = readRows(workbook, 'Sheet1');
    const data = rows.map(r => ({
        packageName: toStr(r[0]),
        details: toNullableStr(r[1]),
        floorCpm: toInt(r[2]),
        geo: toStr(r[3]),
        environment: toStr(r[4]),
        device: toStr(r[5]),
        inventoryType: toStr(r[6]),
        publishers: toStr(r[7]),
        dealType: toStr(r[8]),
        remarks: toNullableStr(r[9]),
    }));
    await prisma.inventoryPackage.deleteMany();
    await insertInBatches(prisma.inventoryPackage, data);
    console.log(`inventory_packages: ${data.length} rows`);
}

async function ingestCtv(workbook) {
    const rows = readRows(workbook, 'CTV+OEM').filter(
        r => toStr(r[1]).length > 0 && toFloat(r[4]) > 0
    );
    const data = rows.map(r => ({
        appUrl: toStr(r[0]),
        applicationName: toStr(r[1]),
        platform: toStr(r[2]),
        type: toStr(r[3]),
        totalImpressions: toBigInt(r[4]),
        totalUniques: toBigInt(r[5]),
        creativeDuration: toStr(r[6]),
        cpmOpen: toInt(r[7]),
        cpmPremiumAudience: toInt(r[8]),
        cpmAdvanced: toInt(r[9]),
        vcr: toFloat(r[10]),
        avgMarketCpm: toInt(r[11]),
        audienceCohorts: toNullableStr(r[12]),
        audienceCohortDetail: toNullableStr(r[13]),
    }));
    await prisma.inventoryCtvInventory.deleteMany();
    await insertInBatches(prisma.inventoryCtvInventory, data);
    console.log(`inventory_ctv: ${data.length} rows`);
}

async function ingestMobileOtt(workbook) {
    const rows = readRows(workbook, 'Mobile OTT');
    const data = rows
        // The sheet has trailing rows with no app identified and zero avails — not real
        // inventory, just blank rows that happened to carry over into the data range.
        .filter(r => toStr(r[1]).length > 0 && toFloat(r[3]) > 0)
        .map(r => {
            // This sheet's own "VCR(in %)" column is a 0-1 fraction (0.75-0.9 observed),
            // unlike the CTV+OEM tab's same-named column, which is already 0-100 (24-99
            // observed) — same metric, inconsistent units within the same workbook. Normalized
            // here so every vcr column in the database means the same thing.
            const rawVcr = toFloat(r[8]);
            return {
                packageId: toStr(r[0]),
                appName: toStr(r[1]),
                country: toStr(r[2]),
                totalAvails: toBigInt(r[3]),
                creativeDuration: toStr(r[4]),
                cpmOpen: toInt(r[5]),
                cpmPremiumAudience: toInt(r[6]),
                cpmAdvanced: toInt(r[7]),
                vcr: rawVcr <= 1 ? rawVcr * 100 : rawVcr,
                avgMarketCpm: toInt(r[9]),
                audienceCohorts: toNullableStr(r[10]),
                audienceCohortDetail: toNullableStr(r[11]),
            };
        });
    await prisma.inventoryMobileOttInventory.deleteMany();
    await insertInBatches(prisma.inventoryMobileOttInventory, data);
    console.log(`inventory_mobile_ott: ${data.length} rows`);
}

// inventory_web_display / inventory_web_video (from "Rough Uploading Data.xlsx") are no longer
// re-ingested — superseded by ingestWebsites/ingestMobileInApp below, from the master sheet's
// richer, properly website-vs-in-app-split data. The two old tables and their Oct-5 data are
// left in place (kept in schema.prisma too) rather than dropped, but nothing refreshes them
// anymore.

async function ingestWebsites(workbook) {
    const rows = readRows(workbook, 'PAN IN-Websites');
    const data = rows.map(r => ({
        inventoryName: toStr(r[0]),
        adFormat: toStr(r[1]),
        environment: toStr(r[2]),
        supportedAdType: toStr(r[3]),
        // The old master sheet separates multiple categories with a comma; the new
        // demographics file (2026-10-13 onward) uses a semicolon instead — split on either so
        // both sources parse correctly rather than one silently producing one garbled compound
        // string per multi-category row.
        iabCategories: toStr(r[4])
            .split(/[,;]/)
            .map(c => c.trim())
            .filter(Boolean),
        geography: toStr(r[5]),
        totalImpressions: toBigInt(r[6]),
        totalUniqueAudience: r[7] === null || r[7] === undefined ? null : toBigInt(r[7]),
        eCpm: toFloat(r[8]),
        buyingCpm: toFloat(r[9]),
        floorCpm: toFloat(r[10]),
        // Columns 11-13 ("CTR/VCR", "Demographics", "Wallet size") only exist from the
        // 2026-10-13 "Demographics-By-Inventory" file onward — undefined (not present) on an
        // older sheet with just the original 11 columns, which every parser here treats as null
        // rather than guessing. CTR/VCR's own format changed again in the 2026-10-14
        // "WalletSize-CTR-VTR-Updated" file, from a raw fraction (0.705) to a percentage string
        // ("65%+") — parseCtrVcrPercent handles the current string format.
        ctrVcr: parseCtrVcrPercent(r[11]),
        ...parseDemographics(r[12]),
        ...parseWalletSize(r[13]),
    }));
    await prisma.inventoryWebsite.deleteMany();
    await insertInBatches(prisma.inventoryWebsite, data);
    console.log(`inventory_websites: ${data.length} rows`);
}

async function ingestMobileInApp(workbook) {
    const rows = readRows(workbook, 'PAN IN- Mobile In App');
    const data = rows.map(r => ({
        inventoryUrl: toStr(r[0]),
        appName: toStr(r[1]),
        adFormat: toStr(r[2]),
        platform: toStr(r[3]),
        totalRequests: toBigInt(r[4]),
        eCpm: toFloat(r[5]),
    }));
    await prisma.inventoryMobileInApp.deleteMany();
    await insertInBatches(prisma.inventoryMobileInApp, data);
    console.log(`inventory_mobile_inapp: ${data.length} rows`);
}

// Must match src/services/bedrock.service.ts (EMBEDDING_MODEL_ID / EMBEDDING_DIMENSIONS) and
// planner.candidates.ts's embeddingKey, or stored vectors won't line up with query vectors.
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIMENSIONS = 256;
const embeddingKey = name => name.trim().toLowerCase();
const EMBED_CONCURRENCY = 8;

const embed = async text => {
    const region = process.env.AWS_REGION || 'us-east-1';
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(
            `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(EMBEDDING_MODEL_ID)}/invoke`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BEDROCK_API_KEY}` },
                body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
            }
        );
        if (response.ok) return (await response.json()).embedding;
        // Throttled: back off and retry; anything else is a real failure.
        if (response.status === 429 && attempt < 6) {
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
            continue;
        }
        throw new Error(`Embedding failed (${response.status}): ${await response.text()}`);
    }
};

async function ingestEmbeddings() {
    if (!process.env.BEDROCK_API_KEY) throw new Error('BEDROCK_API_KEY is required for --embeddings');

    // Same line mapping as planner.candidates.ts's fetchers; websites also carry their IAB
    // categories, which give a bare domain name something to embed against.
    const rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT application_name AS name,
                CASE WHEN type = 'OEM' THEN 'ctv-fast' ELSE 'ctv-ott' END AS line, NULL::text AS category
           FROM inventory_ctv
         UNION SELECT DISTINCT app_name, 'mobile-ott', NULL FROM inventory_mobile_ott
         UNION SELECT DISTINCT inventory_name, 'websites', unnest(iab_categories) FROM inventory_websites
         UNION SELECT DISTINCT app_name, 'in-app', NULL FROM inventory_mobile_inapp`
    );
    const byKey = new Map();
    for (const r of rows) {
        const key = embeddingKey(r.name);
        if (!key) continue;
        const entry = byKey.get(key) ?? { name: key, display: r.name.trim(), lines: new Set(), categories: new Set() };
        entry.lines.add(r.line);
        if (r.category) entry.categories.add(r.category);
        byKey.set(key, entry);
    }

    const stored = new Set((await prisma.inventoryEmbedding.findMany({ select: { name: true } })).map(r => r.name));
    const todo = [...byKey.values()].filter(e => !stored.has(e.name));
    console.log(`${byKey.size} distinct names, ${stored.size} already embedded, ${todo.length} to embed`);

    let done = 0;
    const pending = [];
    const flush = async () => {
        if (pending.length === 0) return;
        await prisma.inventoryEmbedding.createMany({ data: pending.splice(0), skipDuplicates: true });
    };
    for (let i = 0; i < todo.length; i += EMBED_CONCURRENCY) {
        const batch = todo.slice(i, i + EMBED_CONCURRENCY);
        const vectors = await Promise.all(
            batch.map(e => {
                const text = e.categories.size > 0 ? `${e.display} — ${[...e.categories].join(', ')}` : e.display;
                e.text = text;
                return embed(text);
            })
        );
        batch.forEach((e, j) =>
            pending.push({
                name: e.name,
                lines: [...e.lines],
                text: e.text,
                vector: Buffer.from(new Float32Array(vectors[j]).buffer),
            })
        );
        done += batch.length;
        if (pending.length >= 500) await flush();
        if (done % 1000 < EMBED_CONCURRENCY) console.log(`  ${done}/${todo.length}`);
    }
    await flush();
    console.log(`inventory_embeddings: ${done} added`);
}

async function main() {
    if (process.argv[2] === '--embeddings') {
        await ingestEmbeddings();
        await prisma.$disconnect();
        return;
    }
    const [packagesPath, roughDataPath, masterSheetPath, websiteDemographicsPath] = process.argv.slice(2);
    if (!packagesPath || !roughDataPath || !masterSheetPath) {
        console.error(
            'Usage: node scripts/ingest-inventory.js <Packages.xlsx> <RoughUploadingData.xlsx> <MasterSheet.xlsx> [WebsiteDemographics.xlsx]'
        );
        process.exit(1);
    }

    const packagesWb = XLSX.readFile(packagesPath);
    await ingestPackages(packagesWb);

    const roughWb = XLSX.readFile(roughDataPath);
    await ingestCtv(roughWb);
    await ingestMobileOtt(roughWb);

    const masterWb = XLSX.readFile(masterSheetPath);
    // The optional 4th file ("Spendoptix_Inventory_Demographics-By-Inventory.xlsx" as of
    // 2026-10-13) replaces the master sheet as the Websites source once given — same "PAN
    // IN-Websites" tab and the same first 11 columns, plus real CTR/VCR and Demographics columns
    // the master sheet doesn't have. Mobile In-App has no demographics tab yet, so it still
    // always comes from the master sheet.
    const websitesWb = websiteDemographicsPath ? XLSX.readFile(websiteDemographicsPath) : masterWb;
    await ingestWebsites(websitesWb);
    await ingestMobileInApp(masterWb);

    await prisma.$disconnect();
}

main().catch(async err => {
    console.error('Ingestion failed:', err);
    await prisma.$disconnect();
    process.exit(1);
});
