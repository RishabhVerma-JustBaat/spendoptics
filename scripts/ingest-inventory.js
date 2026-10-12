#!/usr/bin/env node
/**
 * Loads the rate-card/inventory spreadsheets into the inventory_* reference tables
 * (see prisma/schema.prisma). Truncate + reinsert, not an upsert — there's no stable natural
 * key worth tracking across sheet versions, and these are read-only reference tables with no
 * foreign keys pointing at them.
 *
 * Usage: node scripts/ingest-inventory.js <Packages.xlsx> <RoughUploadingData.xlsx>
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
        iabCategories: toStr(r[4])
            .split(',')
            .map(c => c.trim())
            .filter(Boolean),
        geography: toStr(r[5]),
        totalImpressions: toBigInt(r[6]),
        totalUniqueAudience: r[7] === null || r[7] === undefined ? null : toBigInt(r[7]),
        eCpm: toFloat(r[8]),
        buyingCpm: toFloat(r[9]),
        floorCpm: toFloat(r[10]),
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

async function main() {
    const [packagesPath, roughDataPath, masterSheetPath] = process.argv.slice(2);
    if (!packagesPath || !roughDataPath || !masterSheetPath) {
        console.error(
            'Usage: node scripts/ingest-inventory.js <Packages.xlsx> <RoughUploadingData.xlsx> <MasterSheet.xlsx>'
        );
        process.exit(1);
    }

    const packagesWb = XLSX.readFile(packagesPath);
    await ingestPackages(packagesWb);

    const roughWb = XLSX.readFile(roughDataPath);
    await ingestCtv(roughWb);
    await ingestMobileOtt(roughWb);

    const masterWb = XLSX.readFile(masterSheetPath);
    await ingestWebsites(masterWb);
    await ingestMobileInApp(masterWb);

    await prisma.$disconnect();
}

main().catch(async err => {
    console.error('Ingestion failed:', err);
    await prisma.$disconnect();
    process.exit(1);
});
