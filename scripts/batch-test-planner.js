#!/usr/bin/env node
/**
 * Runs a batch of free-text briefs through the full suggest -> generate flow and records every
 * response (including errors) to one JSON file, for reviewing multiple prompts at once without
 * re-running each by hand. Never stops the batch on a single failure — a bad prompt's error is
 * recorded in place of its response, and the rest still run.
 *
 * Usage: node scripts/batch-test-planner.js <prompts.json> [--base-url=http://localhost:3000] [--out=results.json]
 *   <prompts.json> is a JSON file containing an array of prompt strings, e.g.:
 *     ["Run a reach campaign for Nykaa...", "Do you have inventory for Tarang Plus..."]
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const parseArgs = argv => {
    const positional = [];
    const flags = {};
    for (const arg of argv) {
        const match = arg.match(/^--([^=]+)=(.*)$/);
        if (match) flags[match[1]] = match[2];
        else positional.push(arg);
    }
    return { positional, flags };
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const promptsPath = positional[0];
if (!promptsPath) {
    console.error('Usage: node scripts/batch-test-planner.js <prompts.json> [--base-url=http://localhost:3000] [--out=results.json]');
    process.exit(1);
}

const baseUrl = flags['base-url'] || `http://localhost:${process.env.PORT || 3000}`;
const token = process.env.TEST_API_TOKEN;
const outPath = flags.out || `planner-batch-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
if (!Array.isArray(prompts) || !prompts.every(p => typeof p === 'string')) {
    console.error(`${promptsPath} must contain a JSON array of strings`);
    process.exit(1);
}

const callApi = async (urlPath, body) => {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }
    return { status: res.status, body: json };
};

async function main() {
    console.log(`Running ${prompts.length} prompt(s) against ${baseUrl}`);
    const results = [];

    for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        console.log(`\n[${i + 1}/${prompts.length}] ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`);
        const entry = { prompt, suggest: null, generate: null };

        try {
            entry.suggest = await callApi('/api/v1/planner/suggestions', { prompt });
            console.log(`  suggest: HTTP ${entry.suggest.status}`);
        } catch (err) {
            entry.suggest = { error: err.message };
            console.log(`  suggest: failed (${err.message})`);
        }

        const input = entry.suggest && entry.suggest.body && entry.suggest.body.data && entry.suggest.body.data.input;
        if (input) {
            try {
                entry.generate = await callApi('/api/v1/planner/generate', input);
                console.log(`  generate: HTTP ${entry.generate.status}`);
            } catch (err) {
                entry.generate = { error: err.message };
                console.log(`  generate: failed (${err.message})`);
            }
        } else {
            console.log('  generate: skipped (no input from suggest)');
        }

        results.push(entry);
    }

    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nWrote ${results.length} result(s) to ${path.resolve(outPath)}`);
}

main().catch(err => {
    console.error('Batch run failed:', err);
    process.exit(1);
});
