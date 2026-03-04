const fs = require('fs');
const path = require('path');

const DATASET_CANDIDATE_PATHS = [
  process.env.INGREDIENT_DATASET_PATH
    ? path.resolve(process.cwd(), process.env.INGREDIENT_DATASET_PATH)
    : '',
  path.join(__dirname, '..', 'skinguard_ingredients_dataset_12000.csv'),
  path.join(__dirname, '..', 'skinguard_ingredients_dataset_8000.csv'),
  path.join(__dirname, '..', 'cosmetic_ingredients_dataset_8000_en_id.csv'),
  path.join(__dirname, '..', 'cosmetic_ingredients_dataset_5000_en_id.csv'),
].filter(Boolean);

const INGREDIENT_CLASSIFICATIONS = Object.freeze({
  SAFE: 'SAFE',
  BOTANICAL: 'BOTANICAL',
  FAMILY_INGREDIENT: 'FAMILY_INGREDIENT',
  FUZZY_MATCH: 'FUZZY_MATCH',
  DANGEROUS: 'DANGEROUS',
  UNKNOWN: 'UNKNOWN',
});

const FUZZY_THRESHOLD_DEFAULT = Number(process.env.INGREDIENT_FUZZY_THRESHOLD || 0.85);
const BOTANICAL_KEYWORDS = new Set([
  'extract',
  'leaf',
  'root',
  'fruit',
  'seed',
  'flower',
  'juice',
  'oil',
]);
const DANGEROUS_KEYWORD_ALIASES = {
  mercury: ['mercury', 'merkuri', 'raksa', 'hg', 'mercuric chloride', 'mercury chloride'],
  lead: ['lead', 'timbal', 'pb'],
  arsenic: ['arsenic', 'arsen'],
  cadmium: ['cadmium', 'kadmium'],
  thallium: ['thallium', 'talium'],
  hydroquinone: ['hydroquinone', 'hidrokuinon', 'hydroquinon'],
  'retinoic acid': ['retinoic acid', 'asam retinoat', 'tretinoin'],
  clobetasol: ['clobetasol', 'clobetasol propionate'],
  betamethasone: ['betamethasone', 'betametason'],
  'rhodamine b': ['rhodamine b', 'rhodamin b', 'rhoda min b', 'rhoda mine b'],
};
const DANGEROUS_ALIAS_OVERRIDES = {
  mercury: ['merkuri', 'raksa', 'hg'],
  hydroquinone: ['hidrokuinon', 'hydroquinon'],
  lead: ['timbal', 'pb'],
  arsenic: ['arsen'],
  'rhodamine b': ['rhodamin b', 'rhoda min b', 'rhoda mine b'],
  tretinoin: ['retinoic acid', 'asam retinoat'],
  clobetasol: ['clobetasol propionate'],
  cadmium: ['kadmium'],
  thallium: ['talium'],
  betamethasone: ['betametason'],
};

let isLoaded = false;
let hasFile = false;
let loadError = null;
let totalRows = 0;
let dangerousRows = 0;
let resolvedDatasetPath = '';

const keyToEntry = new Map();
const compactKeyToEntry = new Map();
const fuzzyRecords = [];
const fuzzySearchCache = new Map();
const classificationCache = new Map();

function clampThreshold(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  if (value < 0.5) {
    return 0.5;
  }

  if (value > 0.99) {
    return 0.99;
  }

  return value;
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

function normalizeIngredientCompactKey(value) {
  return normalizeIngredientKey(value).replace(/\s+/g, '');
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
  const normalizedKey = normalizeIngredientKey(name);
  if (!normalizedKey) {
    return;
  }

  const existingByKey = keyToEntry.get(normalizedKey);
  const merged = mergeEntry(existingByKey, entry);
  keyToEntry.set(normalizedKey, merged);

  const compactKey = normalizeIngredientCompactKey(normalizedKey);
  if (!compactKey) {
    return;
  }

  const existingByCompact = compactKeyToEntry.get(compactKey);
  compactKeyToEntry.set(compactKey, mergeEntry(existingByCompact, merged));
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

function rebuildFuzzyRecords() {
  fuzzyRecords.length = 0;
  fuzzySearchCache.clear();
  classificationCache.clear();

  for (const [key, entry] of keyToEntry.entries()) {
    const compact = normalizeIngredientCompactKey(key);
    if (!compact) {
      continue;
    }

    fuzzyRecords.push({
      key,
      compact,
      length: compact.length,
      entry,
    });
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
  keyToEntry.clear();
  compactKeyToEntry.clear();
  fuzzyRecords.length = 0;
  fuzzySearchCache.clear();
  classificationCache.clear();

  try {
    if (!resolvedDatasetPath || !fs.existsSync(resolvedDatasetPath)) {
      applyDangerousAliasOverrides();
      rebuildFuzzyRecords();
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
      rebuildFuzzyRecords();
      return;
    }

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const englishIdx = header.indexOf('english_name');
    const indonesianIdx = header.indexOf('indonesian_name');
    const dangerousIdx = header.indexOf('is_dangerous');

    if (englishIdx === -1 || indonesianIdx === -1 || dangerousIdx === -1) {
      loadError = 'Invalid dataset header';
      applyDangerousAliasOverrides();
      rebuildFuzzyRecords();
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
    rebuildFuzzyRecords();
  } catch (error) {
    loadError = String(error?.message || error);
    applyDangerousAliasOverrides();
    rebuildFuzzyRecords();
  }
}

function lookupIngredientInDataset(name) {
  loadIngredientDataset();
  const normalizedKey = normalizeIngredientKey(name);
  if (!normalizedKey) {
    return null;
  }

  const entryByKey = keyToEntry.get(normalizedKey);
  if (entryByKey) {
    return entryByKey;
  }

  const compactKey = normalizeIngredientCompactKey(normalizedKey);
  if (!compactKey) {
    return null;
  }

  return compactKeyToEntry.get(compactKey) || null;
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

function toCanonicalEntryName(entry) {
  return String(entry?.englishName || entry?.indonesianName || '').trim();
}

function getDatasetCanonicalKey(name) {
  const exact = lookupIngredientInDataset(name);
  if (exact) {
    const baseName = toCanonicalEntryName(exact);
    return normalizeIngredientKey(baseName);
  }

  const resolved = classifyIngredientName(name, { allowRuleBased: false });
  if (!resolved || !resolved.entry) {
    return '';
  }

  return normalizeIngredientKey(toCanonicalEntryName(resolved.entry));
}

function levenshteinDistance(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  if (source === target) {
    return 0;
  }

  if (!source) {
    return target.length;
  }

  if (!target) {
    return source.length;
  }

  const prev = new Array(target.length + 1);
  const curr = new Array(target.length + 1);

  for (let j = 0; j <= target.length; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= source.length; i += 1) {
    curr[0] = i;
    const sourceChar = source[i - 1];
    for (let j = 1; j <= target.length; j += 1) {
      const cost = sourceChar === target[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }

    for (let j = 0; j <= target.length; j += 1) {
      prev[j] = curr[j];
    }
  }

  return prev[target.length];
}

function levenshteinSimilarity(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  const maxLen = Math.max(source.length, target.length);
  if (maxLen === 0) {
    return 1;
  }

  const distance = levenshteinDistance(source, target);
  return Math.max(0, 1 - distance / maxLen);
}

function jaroSimilarity(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  if (source === target) {
    return 1;
  }

  const sourceLen = source.length;
  const targetLen = target.length;
  if (sourceLen === 0 || targetLen === 0) {
    return 0;
  }

  const matchDistance = Math.floor(Math.max(sourceLen, targetLen) / 2) - 1;
  const sourceMatches = new Array(sourceLen).fill(false);
  const targetMatches = new Array(targetLen).fill(false);
  let matches = 0;

  for (let i = 0; i < sourceLen; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, targetLen);

    for (let j = start; j < end; j += 1) {
      if (targetMatches[j]) {
        continue;
      }
      if (source[i] !== target[j]) {
        continue;
      }
      sourceMatches[i] = true;
      targetMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) {
    return 0;
  }

  let transpositions = 0;
  let targetIndex = 0;
  for (let i = 0; i < sourceLen; i += 1) {
    if (!sourceMatches[i]) {
      continue;
    }

    while (!targetMatches[targetIndex]) {
      targetIndex += 1;
    }

    if (source[i] !== target[targetIndex]) {
      transpositions += 1;
    }
    targetIndex += 1;
  }

  const transpositionHalf = transpositions / 2;
  return (
    (matches / sourceLen + matches / targetLen + (matches - transpositionHalf) / matches) / 3
  );
}

function jaroWinklerSimilarity(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  const jaro = jaroSimilarity(source, target);
  if (jaro < 0.7) {
    return jaro;
  }

  let prefix = 0;
  const prefixLimit = Math.min(4, source.length, target.length);
  while (prefix < prefixLimit && source[prefix] === target[prefix]) {
    prefix += 1;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

function stringSimilarity(a, b) {
  const source = String(a || '');
  const target = String(b || '');
  if (!source || !target) {
    return 0;
  }

  const lev = levenshteinSimilarity(source, target);
  const jw = jaroWinklerSimilarity(source, target);
  return Math.max(lev, jw);
}

function findBestFuzzyDatasetMatch(name, options = {}) {
  loadIngredientDataset();
  const threshold = clampThreshold(
    Number(options.fuzzyThreshold ?? FUZZY_THRESHOLD_DEFAULT),
    FUZZY_THRESHOLD_DEFAULT
  );
  const queryKey = normalizeIngredientKey(name);
  const queryCompact = normalizeIngredientCompactKey(queryKey);
  if (!queryCompact || queryCompact.length < 4) {
    return null;
  }

  const exact = lookupIngredientInDataset(queryKey);
  if (exact) {
    return {
      score: 1,
      entry: exact,
      matchedKey: normalizeIngredientKey(toCanonicalEntryName(exact)),
    };
  }

  const cacheKey = `${queryCompact}|${threshold}`;
  if (fuzzySearchCache.has(cacheKey)) {
    return fuzzySearchCache.get(cacheKey);
  }

  const maxLenDelta = Math.max(2, Math.floor(queryCompact.length * 0.35));
  const firstChar = queryCompact[0];
  const candidates = [];
  for (const record of fuzzyRecords) {
    if (!record || !record.compact) {
      continue;
    }
    if (record.compact[0] !== firstChar) {
      continue;
    }
    if (Math.abs(record.length - queryCompact.length) > maxLenDelta) {
      continue;
    }
    candidates.push(record);
  }

  const pool = candidates.length > 0 ? candidates : fuzzyRecords;
  let best = null;
  for (const record of pool) {
    const score = stringSimilarity(queryCompact, record.compact);
    if (!best || score > best.score) {
      best = {
        score,
        entry: record.entry,
        matchedKey: record.key,
      };
    }
  }

  if (!best || best.score < threshold) {
    fuzzySearchCache.set(cacheKey, null);
    return null;
  }

  fuzzySearchCache.set(cacheKey, best);
  return best;
}

function tokenSetFromText(value) {
  const normalized = normalizeIngredientKey(value);
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

function hasTermInText(value, term) {
  const text = normalizeIngredientKey(value);
  const normalizedTerm = normalizeIngredientKey(term);
  if (!text || !normalizedTerm) {
    return false;
  }

  if (normalizedTerm.includes(' ')) {
    const phrase = ` ${normalizedTerm} `;
    return ` ${text} `.includes(phrase);
  }

  const tokens = tokenSetFromText(text);
  return tokens.has(normalizedTerm);
}

function detectDangerousKeyword(name) {
  const normalized = normalizeIngredientKey(name);
  if (!normalized) {
    return null;
  }

  for (const [canonical, aliases] of Object.entries(DANGEROUS_KEYWORD_ALIASES)) {
    for (const alias of aliases) {
      if (hasTermInText(normalized, alias)) {
        return {
          canonical,
          matchedKeyword: normalizeIngredientKey(alias),
        };
      }
    }
  }

  return null;
}

function detectIngredientFamily(name) {
  const normalized = normalizeIngredientKey(name);
  const compact = normalizeIngredientCompactKey(normalized);
  if (!normalized || !compact) {
    return null;
  }

  if (/^peg\d*/i.test(compact) || compact.startsWith('peg')) {
    return { family: 'PEG' };
  }

  if (/\bglycol\b/i.test(normalized) || compact.includes('glycol')) {
    return { family: 'GLYCOL' };
  }

  return null;
}

function isBotanicalIngredientName(name) {
  const normalized = normalizeIngredientKey(name);
  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return false;
  }

  return tokens.some((token) => BOTANICAL_KEYWORDS.has(token));
}

function buildClassificationResponse(inputName, payload = {}) {
  const response = {
    input: String(inputName || '').trim(),
    normalized: normalizeIngredientKey(inputName),
    classification: payload.classification || INGREDIENT_CLASSIFICATIONS.UNKNOWN,
    isIngredient: Boolean(payload.isIngredient),
    isDangerous: Boolean(payload.isDangerous),
    confidence: Number(payload.confidence || 0),
    matchType: String(payload.matchType || ''),
    source: String(payload.source || ''),
    family: payload.family ? String(payload.family) : '',
    canonicalName: String(payload.canonicalName || '').trim(),
    matchedName: String(payload.matchedName || '').trim(),
    matchedKey: String(payload.matchedKey || '').trim(),
    entry: payload.entry || null,
  };

  return response;
}

function classifyIngredientName(name, options = {}) {
  loadIngredientDataset();

  const normalized = normalizeIngredientKey(name);
  const fuzzyThreshold = clampThreshold(
    Number(options.fuzzyThreshold ?? FUZZY_THRESHOLD_DEFAULT),
    FUZZY_THRESHOLD_DEFAULT
  );
  const allowRuleBased = options.allowRuleBased !== false;
  const cacheKey = `${normalized}|${fuzzyThreshold}|${allowRuleBased ? 1 : 0}`;

  if (classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey);
  }

  if (!normalized) {
    const emptyResult = buildClassificationResponse(name, {
      classification: INGREDIENT_CLASSIFICATIONS.UNKNOWN,
      isIngredient: false,
      source: 'empty',
    });
    classificationCache.set(cacheKey, emptyResult);
    return emptyResult;
  }

  const exactEntry = lookupIngredientInDataset(normalized);
  if (exactEntry) {
    const classification = exactEntry.isDangerous
      ? INGREDIENT_CLASSIFICATIONS.DANGEROUS
      : INGREDIENT_CLASSIFICATIONS.SAFE;
    const exactResult = buildClassificationResponse(name, {
      classification,
      isIngredient: true,
      isDangerous: Boolean(exactEntry.isDangerous),
      confidence: 1,
      matchType: 'exact',
      source: 'dataset',
      canonicalName: toCanonicalEntryName(exactEntry),
      matchedName: toCanonicalEntryName(exactEntry),
      matchedKey: normalizeIngredientKey(toCanonicalEntryName(exactEntry)),
      entry: exactEntry,
    });
    classificationCache.set(cacheKey, exactResult);
    return exactResult;
  }

  const dangerousByKeyword = detectDangerousKeyword(normalized);
  if (dangerousByKeyword) {
    const dangerResult = buildClassificationResponse(name, {
      classification: INGREDIENT_CLASSIFICATIONS.DANGEROUS,
      isIngredient: true,
      isDangerous: true,
      confidence: 0.96,
      matchType: 'keyword',
      source: 'dangerous_keyword',
      canonicalName: dangerousByKeyword.canonical,
      matchedName: dangerousByKeyword.canonical,
      matchedKey: dangerousByKeyword.matchedKeyword,
      entry: null,
    });
    classificationCache.set(cacheKey, dangerResult);
    return dangerResult;
  }

  if (!allowRuleBased) {
    const unknownResult = buildClassificationResponse(name, {
      classification: INGREDIENT_CLASSIFICATIONS.UNKNOWN,
      isIngredient: false,
      confidence: 0,
      matchType: 'none',
      source: 'unresolved',
    });
    classificationCache.set(cacheKey, unknownResult);
    return unknownResult;
  }

  const family = detectIngredientFamily(normalized);
  if (family && family.family) {
    const familyResult = buildClassificationResponse(name, {
      classification: INGREDIENT_CLASSIFICATIONS.FAMILY_INGREDIENT,
      isIngredient: true,
      isDangerous: false,
      confidence: 0.9,
      matchType: 'family_rule',
      source: 'family_rule',
      family: family.family,
      canonicalName: String(name || '').trim() || normalized,
      matchedName: String(name || '').trim() || normalized,
      matchedKey: normalizeIngredientKey(name),
      entry: null,
    });
    classificationCache.set(cacheKey, familyResult);
    return familyResult;
  }

  if (isBotanicalIngredientName(normalized)) {
    const botanicalResult = buildClassificationResponse(name, {
      classification: INGREDIENT_CLASSIFICATIONS.BOTANICAL,
      isIngredient: true,
      isDangerous: false,
      confidence: 0.86,
      matchType: 'botanical_rule',
      source: 'botanical_rule',
      canonicalName: String(name || '').trim() || normalized,
      matchedName: String(name || '').trim() || normalized,
      matchedKey: normalizeIngredientKey(name),
      entry: null,
    });
    classificationCache.set(cacheKey, botanicalResult);
    return botanicalResult;
  }

  const fuzzy = findBestFuzzyDatasetMatch(normalized, { fuzzyThreshold });
  if (fuzzy && fuzzy.entry) {
    const isDangerous = Boolean(fuzzy.entry.isDangerous);
    const fuzzyResult = buildClassificationResponse(name, {
      classification: isDangerous
        ? INGREDIENT_CLASSIFICATIONS.DANGEROUS
        : INGREDIENT_CLASSIFICATIONS.FUZZY_MATCH,
      isIngredient: true,
      isDangerous,
      confidence: Number(fuzzy.score || 0),
      matchType: 'fuzzy',
      source: 'dataset_fuzzy',
      canonicalName: toCanonicalEntryName(fuzzy.entry),
      matchedName: toCanonicalEntryName(fuzzy.entry),
      matchedKey: fuzzy.matchedKey,
      entry: fuzzy.entry,
    });
    classificationCache.set(cacheKey, fuzzyResult);
    return fuzzyResult;
  }

  const unknownResult = buildClassificationResponse(name, {
    classification: INGREDIENT_CLASSIFICATIONS.UNKNOWN,
    isIngredient: false,
    confidence: 0,
    matchType: 'none',
    source: 'unresolved',
  });
  classificationCache.set(cacheKey, unknownResult);
  return unknownResult;
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
    indexedCompactNames: compactKeyToEntry.size,
    fuzzyRecords: fuzzyRecords.length,
    fuzzyThresholdDefault: clampThreshold(FUZZY_THRESHOLD_DEFAULT, 0.85),
  };
}

module.exports = {
  INGREDIENT_CLASSIFICATIONS,
  normalizeIngredientKey,
  normalizeIngredientCompactKey,
  lookupIngredientInDataset,
  isDatasetIngredient,
  isDatasetDangerousIngredient,
  getDatasetPreferredName,
  getDatasetAliases,
  getDatasetCanonicalKey,
  getIngredientDatasetInfo,
  classifyIngredientName,
  findBestFuzzyDatasetMatch,
  detectDangerousKeyword,
  detectIngredientFamily,
  isBotanicalIngredientName,
  stringSimilarity,
};
