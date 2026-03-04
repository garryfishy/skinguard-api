const fs = require('fs');
const path = require('path');

const DATASET_CANDIDATE_PATHS = [
  process.env.INGREDIENT_DATASET_PATH
    ? path.resolve(process.cwd(), process.env.INGREDIENT_DATASET_PATH)
    : '',
  path.join(__dirname, '..', 'skinguard_ingredients_dataset_8000.csv'),
  path.join(__dirname, '..', 'cosmetic_ingredients_dataset_8000_en_id.csv'),
  path.join(__dirname, '..', 'cosmetic_ingredients_dataset_5000_en_id.csv'),
].filter(Boolean);

const DANGEROUS_ALIAS_OVERRIDES = {
  mercury: ['merkuri', 'raksa', 'hg'],
  hydroquinone: ['hidrokuinon', 'hydroquinon'],
  lead: ['timbal', 'pb'],
  arsenic: ['arsen'],
  'rhodamine b': ['rhodamin b', 'rhoda min b', 'rhoda mine b'],
  tretinoin: ['retinoic acid', 'asam retinoat'],
  clobetasol: ['clobetasol propionate'],
  cadmium: ['kadmium'],
};

let isLoaded = false;
let hasFile = false;
let loadError = null;
let totalRows = 0;
let dangerousRows = 0;
let resolvedDatasetPath = '';

const keyToEntry = new Map();

function normalizeIngredientKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBoolean(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y';
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
  return output.map((value) => String(value || '').trim());
}

function mergeEntry(base, incoming) {
  if (!base) {
    return {
      englishName: incoming.englishName,
      indonesianName: incoming.indonesianName,
      isDangerous: Boolean(incoming.isDangerous),
    };
  }

  return {
    englishName: base.englishName || incoming.englishName,
    indonesianName: base.indonesianName || incoming.indonesianName,
    isDangerous: Boolean(base.isDangerous || incoming.isDangerous),
  };
}

function addEntryKey(name, entry) {
  const key = normalizeIngredientKey(name);
  if (!key) {
    return;
  }

  const existing = keyToEntry.get(key);
  keyToEntry.set(key, mergeEntry(existing, entry));
}

function resolveDatasetPath() {
  for (const candidate of DATASET_CANDIDATE_PATHS) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return DATASET_CANDIDATE_PATHS[0] || '';
}

function buildDangerousOverrideEntry(canonical, aliases = []) {
  const firstAlias = Array.isArray(aliases) ? aliases.find((alias) => String(alias || '').trim()) : '';
  return {
    englishName: canonical,
    indonesianName: String(firstAlias || '').trim(),
    isDangerous: true,
  };
}

function applyDangerousAliasOverrides() {
  for (const [canonical, aliases] of Object.entries(DANGEROUS_ALIAS_OVERRIDES)) {
    const keys = [canonical, ...(Array.isArray(aliases) ? aliases : [])]
      .map((value) => normalizeIngredientKey(value))
      .filter(Boolean);

    let existing = null;
    for (const key of keys) {
      if (keyToEntry.has(key)) {
        existing = keyToEntry.get(key);
        break;
      }
    }

    const merged = mergeEntry(existing, buildDangerousOverrideEntry(canonical, aliases));
    merged.isDangerous = true;

    addEntryKey(canonical, merged);
    for (const alias of aliases) {
      addEntryKey(alias, merged);
    }
  }
}

function loadIngredientDataset() {
  if (isLoaded) {
    return;
  }

  isLoaded = true;
  hasFile = false;
  loadError = null;
  totalRows = 0;
  dangerousRows = 0;
  resolvedDatasetPath = resolveDatasetPath();

  try {
    if (!resolvedDatasetPath || !fs.existsSync(resolvedDatasetPath)) {
      applyDangerousAliasOverrides();
      return;
    }

    hasFile = true;
    const raw = fs.readFileSync(resolvedDatasetPath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) {
      applyDangerousAliasOverrides();
      return;
    }

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const englishIdx = header.indexOf('english_name');
    const indonesianIdx = header.indexOf('indonesian_name');
    const dangerousIdx = header.indexOf('is_dangerous');

    if (englishIdx === -1 || indonesianIdx === -1 || dangerousIdx === -1) {
      loadError = 'Invalid dataset header';
      applyDangerousAliasOverrides();
      return;
    }

    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i]);
      if (!Array.isArray(cols) || cols.length === 0) {
        continue;
      }

      const englishName = String(cols[englishIdx] || '').trim();
      const indonesianName = String(cols[indonesianIdx] || '').trim();
      const isDangerous = parseBoolean(cols[dangerousIdx]);

      if (!englishName && !indonesianName) {
        continue;
      }

      totalRows += 1;
      if (isDangerous) {
        dangerousRows += 1;
      }

      const entry = {
        englishName,
        indonesianName,
        isDangerous,
      };

      addEntryKey(englishName, entry);
      addEntryKey(indonesianName, entry);
    }

    applyDangerousAliasOverrides();
  } catch (error) {
    loadError = String(error?.message || error);
    applyDangerousAliasOverrides();
  }
}

function lookupIngredientInDataset(name) {
  loadIngredientDataset();
  const key = normalizeIngredientKey(name);
  if (!key) {
    return null;
  }

  return keyToEntry.get(key) || null;
}

function isDatasetIngredient(name) {
  return Boolean(lookupIngredientInDataset(name));
}

function isDatasetDangerousIngredient(name) {
  const entry = lookupIngredientInDataset(name);
  return Boolean(entry && entry.isDangerous);
}

function getDatasetPreferredName(name, language = 'id') {
  const entry = lookupIngredientInDataset(name);
  if (!entry) {
    return '';
  }

  if (language === 'id') {
    return entry.indonesianName || entry.englishName || '';
  }

  return entry.englishName || entry.indonesianName || '';
}

function getDatasetAliases(name) {
  const entry = lookupIngredientInDataset(name);
  if (!entry) {
    return [];
  }

  const aliases = [entry.englishName, entry.indonesianName]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return Array.from(new Set(aliases));
}

function getDatasetCanonicalKey(name) {
  const entry = lookupIngredientInDataset(name);
  if (!entry) {
    return '';
  }

  const baseName = String(entry.englishName || entry.indonesianName || '').trim();
  return normalizeIngredientKey(baseName);
}

function getIngredientDatasetInfo() {
  loadIngredientDataset();
  return {
    path: resolvedDatasetPath,
    hasFile,
    loaded: isLoaded,
    loadError,
    totalRows,
    dangerousRows,
    indexedNames: keyToEntry.size,
  };
}

module.exports = {
  normalizeIngredientKey,
  lookupIngredientInDataset,
  isDatasetIngredient,
  isDatasetDangerousIngredient,
  getDatasetPreferredName,
  getDatasetAliases,
  getDatasetCanonicalKey,
  getIngredientDatasetInfo,
};
