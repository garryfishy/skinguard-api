const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DEFAULT_SOURCE_URL =
  'https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/main/taxonomies/beauty/ingredients-cosing-obf.txt';
const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), 'skinguard_ingredients_dataset_5000_online.csv');
const DEFAULT_TARGET_ROWS = 5000;
const LOCAL_DATASET_CANDIDATES = [
  path.join(process.cwd(), 'skinguard_ingredients_dataset_12000.csv'),
  path.join(process.cwd(), 'skinguard_ingredients_dataset_8000.csv'),
  path.join(process.cwd(), 'cosmetic_ingredients_dataset_8000_en_id.csv'),
  path.join(process.cwd(), 'cosmetic_ingredients_dataset_5000_en_id.csv'),
];

const DANGEROUS_RULES = [
  { pattern: /\bmercury\b/i, canonical: 'Mercury', indonesian: 'Merkuri', tokens: ['mercury', 'mercuric', 'mercurous'] },
  { pattern: /\blead\b/i, canonical: 'Lead', indonesian: 'Timbal', tokens: ['lead'] },
  { pattern: /\barsenic\b/i, canonical: 'Arsenic', indonesian: 'Arsenik', tokens: ['arsenic'] },
  { pattern: /\bcadmium\b/i, canonical: 'Cadmium', indonesian: 'Kadmium', tokens: ['cadmium'] },
  { pattern: /\bthallium\b/i, canonical: 'Thallium', indonesian: 'Talium', tokens: ['thallium'] },
  { pattern: /\bhydroquinone\b/i, canonical: 'Hydroquinone', indonesian: 'Hidrokuinon', tokens: ['hydroquinone'] },
  { pattern: /\bretinoic acid\b/i, canonical: 'Retinoic Acid', indonesian: 'Asam Retinoat', tokens: ['retinoic acid'] },
  { pattern: /\btretinoin\b/i, canonical: 'Tretinoin', indonesian: 'Tretinoin', tokens: ['tretinoin'] },
  { pattern: /\bclobetasol\b/i, canonical: 'Clobetasol', indonesian: 'Clobetasol', tokens: ['clobetasol'] },
  { pattern: /\bbetamethasone\b/i, canonical: 'Betamethasone', indonesian: 'Betametason', tokens: ['betamethasone'] },
  { pattern: /\brhodamine b\b/i, canonical: 'Rhodamine B', indonesian: 'Rhodamin B', tokens: ['rhodamine b'] },
];

function parseCliArgs(argv) {
  const options = {};

  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      continue;
    }

    const next = argv[i + 1];
    if (token === '--output' && next) {
      options.output = String(next);
      i += 1;
      continue;
    }

    if (token === '--target' && next) {
      options.target = Number(next);
      i += 1;
      continue;
    }

    if (token === '--source' && next) {
      options.source = String(next);
      i += 1;
      continue;
    }

    if (token === '--all') {
      options.all = true;
      continue;
    }
  }

  return options;
}

function normalizeIngredientKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[’'`"]/g, '')
    .replace(/[()/,[\]{}:%+;]+/g, ' ')
    .replace(/[\\]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bpeg\s+(\d{1,4})\b/g, 'peg$1')
    .replace(/\b([a-z]{1,8})\s+(\d{1,4})\b/g, '$1$2')
    .replace(/\b(\d{1,4})\s+([a-z]{1,8})\b/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCsvCell(value) {
  const text = String(value == null ? '' : value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsvLine(line) {
  const output = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      output.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  output.push(current);
  return output.map((item) => String(item || '').trim());
}

function loadExistingIndonesianMap() {
  const map = new Map();

  for (const filePath of LOCAL_DATASET_CANDIDATES) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) {
      continue;
    }

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const englishIndex = header.indexOf('english_name');
    const indonesianIndex = header.indexOf('indonesian_name');

    if (englishIndex === -1 || indonesianIndex === -1) {
      continue;
    }

    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i]);
      const englishName = String(cols[englishIndex] || '').trim();
      const indonesianName = String(cols[indonesianIndex] || '').trim();
      const key = normalizeIngredientKey(englishName);
      if (!key || !indonesianName) {
        continue;
      }

      if (!map.has(key)) {
        map.set(key, indonesianName);
      }
    }
  }

  return map;
}

function classifyDangerous(name) {
  const normalized = normalizeIngredientKey(name);
  const compact = normalized.replace(/\s+/g, '');
  if (!normalized) {
    return null;
  }

  for (const rule of DANGEROUS_RULES) {
    const tokens = Array.isArray(rule.tokens) ? rule.tokens : [rule.canonical];
    for (const token of tokens) {
      const normalizedToken = normalizeIngredientKey(token);
      if (!normalizedToken) {
        continue;
      }

      const compactToken = normalizedToken.replace(/\s+/g, '');
      if (normalized.includes(normalizedToken) || compact.includes(compactToken)) {
        return rule;
      }
    }

    if (rule.pattern.test(normalized)) {
      return rule;
    }
  }

  return null;
}

function shouldSkipCandidate(name) {
  const value = String(name || '').trim();
  if (!value) {
    return true;
  }

  if (value.length < 2 || value.length > 220) {
    return true;
  }

  if (/^[0-9.\-+%\s]+$/.test(value)) {
    return true;
  }

  if (!/[a-z]/i.test(value)) {
    return true;
  }

  return false;
}

function parseOnlineIngredientNames(rawText) {
  const names = [];
  const lines = String(rawText || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (!trimmed.startsWith('en: ')) {
      continue;
    }

    const name = trimmed.slice(4).trim();
    if (shouldSkipCandidate(name)) {
      continue;
    }

    names.push(name);
  }

  return names;
}

function buildUniqueSortedNames(names) {
  const nameByKey = new Map();

  for (const value of names) {
    const englishName = String(value || '').trim();
    const key = normalizeIngredientKey(englishName);
    if (!key || nameByKey.has(key)) {
      continue;
    }

    nameByKey.set(key, englishName);
  }

  const output = Array.from(nameByKey.values());
  function sortKey(value) {
    const upper = String(value || '').toUpperCase();
    const trimmed = upper.replace(/^[^A-Z0-9]+/, '');
    return trimmed || upper;
  }

  output.sort((left, right) => {
    const leftKey = sortKey(left);
    const rightKey = sortKey(right);
    return leftKey.localeCompare(rightKey, 'en', { sensitivity: 'base' });
  });
  return output;
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const visit = (targetUrl, depth = 0) => {
      if (depth > 5) {
        reject(new Error('Too many redirects while downloading source dataset.'));
        return;
      }

      const parsedUrl = new URL(targetUrl);
      const client = parsedUrl.protocol === 'http:' ? http : https;

      const request = client.get(parsedUrl, (response) => {
        const statusCode = Number(response.statusCode || 0);
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          const nextUrl = new URL(location, parsedUrl).toString();
          response.resume();
          visit(nextUrl, depth + 1);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Failed to download source dataset. HTTP ${statusCode}`));
          response.resume();
          return;
        }

        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
      });

      request.on('error', (error) => reject(error));
      request.setTimeout(30000, () => {
        request.destroy(new Error('Download request timed out.'));
      });
    };

    visit(url);
  });
}

function buildDatasetRows(names, existingIndonesianMap, targetRows) {
  const rows = [];
  const seen = new Set();

  for (const rawName of names) {
    const englishName = String(rawName || '').trim();
    const key = normalizeIngredientKey(englishName);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    const dangerousRule = classifyDangerous(englishName);
    const isDangerous = Boolean(dangerousRule);
    const indonesianName =
      existingIndonesianMap.get(key) ||
      (dangerousRule ? dangerousRule.indonesian : englishName);

    rows.push({
      english_name: englishName,
      indonesian_name: indonesianName || englishName,
      is_dangerous: isDangerous ? 'True' : 'False',
    });

    if (rows.length >= targetRows) {
      break;
    }
  }

  return rows;
}

function writeCsv(filePath, rows) {
  const lines = ['english_name,indonesian_name,is_dangerous'];

  for (const row of rows) {
    lines.push(
      [
        escapeCsvCell(row.english_name),
        escapeCsvCell(row.indonesian_name),
        escapeCsvCell(row.is_dangerous),
      ].join(',')
    );
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const cli = parseCliArgs(process.argv);
  const sourceUrl = cli.source || process.env.ONLINE_INGREDIENT_SOURCE_URL || DEFAULT_SOURCE_URL;
  const outputPath = path.resolve(cli.output || process.env.ONLINE_INGREDIENT_OUTPUT || DEFAULT_OUTPUT_PATH);
  const targetRowsRaw = Number(cli.target || process.env.ONLINE_INGREDIENT_TARGET || DEFAULT_TARGET_ROWS);
  const targetRows = Number.isFinite(targetRowsRaw) && targetRowsRaw > 0
    ? Math.max(targetRowsRaw, DEFAULT_TARGET_ROWS)
    : DEFAULT_TARGET_ROWS;

  console.log(`Downloading source: ${sourceUrl}`);
  const sourceText = await downloadText(sourceUrl);
  const parsedNames = parseOnlineIngredientNames(sourceText);
  const names = buildUniqueSortedNames(parsedNames);

  if (names.length === 0) {
    throw new Error('No ingredient names found in online source.');
  }

  const existingMap = loadExistingIndonesianMap();
  const finalTargetRows = cli.all ? names.length : targetRows;
  const rows = buildDatasetRows(names, existingMap, finalTargetRows);

  if (rows.length < DEFAULT_TARGET_ROWS) {
    throw new Error(
      `Only ${rows.length} unique rows could be built. Minimum expected is ${DEFAULT_TARGET_ROWS}.`
    );
  }

  writeCsv(outputPath, rows);

  const dangerousCount = rows.filter((item) => item.is_dangerous === 'True').length;
  console.log(`Unique names from source: ${names.length}`);
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
  console.log(`Dangerous rows: ${dangerousCount}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
