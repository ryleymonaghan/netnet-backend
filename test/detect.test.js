#!/usr/bin/env node
// Runs detectFormat() against every PDF in test/fixtures/ and prints the raw
// detected distribution — no pass/fail. detectFormat throws on anything that
// isn't clearly A or B; that's caught per-file here and reported as an error
// row rather than crashing the run.
const fs = require('fs');
const path = require('path');
const { extractText } = require('../lib/parsers/pdf');
const { detectFormat } = require('../lib/parsers/detect');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function firstStatementMonth(text) {
  const m = text.match(/\b(\d{2})\/\d{2}\/(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

async function main() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    console.error(`Fixtures directory not found: ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (files.length === 0) {
    console.error(`No PDF fixtures found in ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const rows = [];
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, file));
    let text = '';
    let error = null;
    try {
      text = await extractText(buffer);
    } catch (e) {
      error = e.message;
    }

    const month = text ? firstStatementMonth(text) : null;
    let detected = null;
    if (text && !error) {
      try {
        detected = detectFormat(text, file);
      } catch (e) {
        error = e.message;
      }
    }

    rows.push({ file, month, detected, error });
  }

  const nameW = Math.max(4, ...rows.map(r => r.file.length));
  const header = `${'FILE'.padEnd(nameW)}  MONTH  DETECTED`;
  console.log(header);
  console.log('-'.repeat(header.length));

  const counts = {};
  for (const r of rows) {
    const monthStr = r.month ? String(r.month).padStart(2, '0') : '??';
    const detectedStr = r.error ? `ERROR: ${r.error}` : String(r.detected);
    counts[r.error ? 'ERROR' : r.detected] = (counts[r.error ? 'ERROR' : r.detected] || 0) + 1;
    console.log(`${r.file.padEnd(nameW)}  ${monthStr.padEnd(5)}  ${detectedStr}`);
  }

  console.log('-'.repeat(header.length));
  console.log(`Distribution: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

main();
