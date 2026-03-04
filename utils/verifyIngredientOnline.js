const PUBCHEM_BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name';
const PUBCHEM_GHS_BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound';
const {
  INGREDIENT_CLASSIFICATIONS,
  isDatasetDangerousIngredient,
  classifyIngredientName,
} = require('./ingredientDataset');
const {
  isKnownNonIngredient,
  recordNonIngredient,
} = require('./nonIngredientMemory');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 2500;
const MAX_ONLINE_LOOKUPS = 120;
const LOOKUP_CONCURRENCY = 6;
const DEFAULT_SAFETY_RECHECK_BUDGET = 4;
const CANDIDATE_VALIDITY = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
});
const OUTPUT_CLASSIFICATIONS = new Set([
  INGREDIENT_CLASSIFICATIONS.SAFE,
  INGREDIENT_CLASSIFICATIONS.BOTANICAL,
  INGREDIENT_CLASSIFICATIONS.FAMILY_INGREDIENT,
  INGREDIENT_CLASSIFICATIONS.FUZZY_MATCH,
  INGREDIENT_CLASSIFICATIONS.DANGEROUS,
]);
const CLASSIFICATION_PRIORITY = {
  [INGREDIENT_CLASSIFICATIONS.DANGEROUS]: 5,
  [INGREDIENT_CLASSIFICATIONS.FUZZY_MATCH]: 4,
  [INGREDIENT_CLASSIFICATIONS.FAMILY_INGREDIENT]: 3,
  [INGREDIENT_CLASSIFICATIONS.BOTANICAL]: 2,
  [INGREDIENT_CLASSIFICATIONS.SAFE]: 1,
};

const HIGH_IMPACT_GHS_CODES = new Set([
  'H300',
  'H301',
  'H310',
  'H311',
  'H330',
  'H331',
  'H340',
  'H350',
  'H360',
  'H370',
  'H372',
]);

const CAUTION_GHS_CODES = new Set([
  'H302',
  'H312',
  'H315',
  'H317',
  'H318',
  'H319',
  'H332',
  'H334',
  'H335',
  'H336',
  'H341',
  'H351',
  'H361',
  'H362',
  'H371',
  'H373',
]);

const ALWAYS_RISKY_KEYS = new Set([
  'mercury',
  'merkuri',
  'raksa',
  'mercury chloride',
  'hydroquinone',
  'hidrokuinon',
  'lead',
  'timbal',
  'arsenic',
  'rhodamine b',
  'tretinoin',
  'retinoic acid',
  'clobetasol',
  'clobetasol propionate',
]);

const NON_INGREDIENT_PATTERNS = [
  /\b(manufactured ?by|manufacturedby|distributed ?by|distributedby)\b/i,
  /\b(diproduksi ?oleh|diproduksioleh|dipasarkan ?oleh|dipasarkanoleh)\b/i,
  /\b(company|address|alamat|customer ?service|customerservice)\b/i,
  /\b(bpom|batch|lot|mfg|exp|expiry|warning|peringatan|cara pakai|how to use)\b/i,
  /\b(pt|cv|ltd|inc|llc)\b/i,
  /\b(netto?|net)\s*\d+\s*(ml|l|g|kg|oz)\b/i,
  /^\d+(ml|l|g|kg|oz)$/i,
  /https?:\/\//i,
  /www\./i,
];

const validationCache = new Map();
const cidCache = new Map();
const hazardCache = new Map();

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeText(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[%]/g, ' ')
    .replace(/[,:;]+/g, ' ')
    .replace(/[.]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyIngredient(value) {
  const text = canonicalizeText(value);
  if (!text || text.length < 2 || text.length > 80) {
    return false;
  }

  if (isKnownNonIngredient(text)) {
    return false;
  }

  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (
    /^(netto?|net)\d+(ml|l|g|kg|oz)$/i.test(compact) ||
    /^\d+(ml|l|g|kg|oz)$/i.test(compact) ||
    /^(bpom|batch|lot|exp|expiry|mfg)[a-z0-9-]*$/i.test(compact)
  ) {
    return false;
  }

  if (NON_INGREDIENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 6) {
    return false;
  }

  if (/^[0-9.\-+%\s]+$/.test(text)) {
    return false;
  }

  return /[a-z]/i.test(text);
}

function isWeakUntrustedToken(value) {
  const text = canonicalizeText(value);
  if (!text) {
    return true;
  }

  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) {
    return false;
  }

  const token = parts[0].toLowerCase();
  if (!/^[a-z]+$/.test(token)) {
    return false;
  }

  return token.length <= 6;
}

function buildCandidateList(name, aliases = []) {
  const raw = [name, ...aliases];
  const unique = [];
  const seen = new Set();

  for (const value of raw) {
    const cleaned = canonicalizeText(value);
    if (!isLikelyIngredient(cleaned)) {
      continue;
    }

    const key = normalizeKey(cleaned);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(cleaned);
  }

  return unique.slice(0, 5);
}

function normalizeClassificationValue(value, fallback = INGREDIENT_CLASSIFICATIONS.SAFE) {
  const normalized = String(value || '').trim().toUpperCase();
  if (OUTPUT_CLASSIFICATIONS.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function buildCandidateClassification(candidate, classified) {
  if (!classified || typeof classified !== 'object') {
    return null;
  }

  if (!classified.isIngredient) {
    return null;
  }

  const canonicalName = String(
    classified.canonicalName || classified.matchedName || candidate || ''
  ).trim();
  if (!canonicalName) {
    return null;
  }

  return {
    classification: normalizeClassificationValue(
      classified.classification,
      INGREDIENT_CLASSIFICATIONS.SAFE
    ),
    confidence: Number(classified.confidence || 0),
    source: String(classified.source || classified.matchType || 'rule'),
    matchType: String(classified.matchType || ''),
    matchedName: String(classified.matchedName || canonicalName),
    canonicalName,
    family: String(classified.family || ''),
  };
}

function classificationPriority(value) {
  const key = normalizeClassificationValue(value, '');
  return Number(CLASSIFICATION_PRIORITY[key] || 0);
}

function pickBetterClassification(current, candidate) {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  const currentPriority = classificationPriority(current.classification);
  const candidatePriority = classificationPriority(candidate.classification);
  if (candidatePriority > currentPriority) {
    return candidate;
  }

  if (candidatePriority < currentPriority) {
    return current;
  }

  return Number(candidate.confidence || 0) > Number(current.confidence || 0)
    ? candidate
    : current;
}

function defaultSafeClassification(name, source = 'pubchem') {
  const canonicalName = canonicalizeText(name);
  return {
    classification: INGREDIENT_CLASSIFICATIONS.SAFE,
    confidence: 0.86,
    source,
    matchType: source === 'pubchem' ? 'verification' : source,
    matchedName: canonicalName,
    canonicalName,
    family: '',
  };
}

function getCachedValue(cache, key) {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedValue(cache, key, value) {
  cache.set(key, { value, ts: Date.now() });
}

async function lookupPubChemCid(name) {
  const key = normalizeKey(name);
  if (!key) {
    return null;
  }

  const cached = getCachedValue(cidCache, key);
  if (cached !== null) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const url = `${PUBCHEM_BASE_URL}/${encodeURIComponent(name)}/cids/JSON`;
    const res = await fetch(url, { signal: controller.signal });

    if (res.status === 404 || res.status === 400) {
      setCachedValue(cidCache, key, null);
      return null;
    }

    if (!res.ok) {
      return undefined;
    }

    const payload = await res.json();
    const cid =
      payload &&
      payload.IdentifierList &&
      Array.isArray(payload.IdentifierList.CID) &&
      payload.IdentifierList.CID.length > 0
        ? Number(payload.IdentifierList.CID[0])
        : null;

    setCachedValue(cidCache, key, cid);
    return cid;
  } catch (error) {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupGhsCodesByCid(cid) {
  const cidNum = Number(cid);
  if (!Number.isFinite(cidNum) || cidNum <= 0) {
    return {
      all: [],
      high: [],
      caution: [],
    };
  }

  const cacheKey = String(cidNum);
  const cached = getCachedValue(hazardCache, cacheKey);
  if (cached !== null) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const url = `${PUBCHEM_GHS_BASE_URL}/${cidNum}/JSON?heading=GHS+Classification`;
    const res = await fetch(url, { signal: controller.signal });

    if (res.status === 404) {
      const empty = { all: [], high: [], caution: [] };
      setCachedValue(hazardCache, cacheKey, empty);
      return empty;
    }

    if (!res.ok) {
      return null;
    }

    const text = await res.text();
    const allCodes = Array.from(new Set(text.match(/\bH\d{3}\b/g) || []));
    const highCodes = allCodes.filter((code) => HIGH_IMPACT_GHS_CODES.has(code));
    const cautionCodes = allCodes.filter((code) => CAUTION_GHS_CODES.has(code));
    const value = {
      all: allCodes,
      high: highCodes,
      caution: cautionCodes,
    };
    setCachedValue(hazardCache, cacheKey, value);
    return value;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRiskyByRule(candidates) {
  for (const candidate of candidates) {
    if (ALWAYS_RISKY_KEYS.has(normalizeKey(candidate)) || isDatasetDangerousIngredient(candidate)) {
      return true;
    }
  }
  return false;
}

function ensureBudgetRef(options) {
  if (
    options &&
    options.budget &&
    typeof options.budget === 'object' &&
    typeof options.budget.remaining === 'number'
  ) {
    return options.budget;
  }

  return { remaining: DEFAULT_SAFETY_RECHECK_BUDGET };
}

async function doubleCheckIngredientSafetyOnline(name, aliases = [], options = {}) {
  const candidates = buildCandidateList(name, aliases);
  if (candidates.length === 0) {
    return {
      status: 'unknown',
      source: 'validation',
      reason: 'Data bahan tidak cukup untuk pengecekan tambahan.',
      codes: [],
    };
  }

  if (isRiskyByRule(candidates)) {
    return {
      status: 'risky',
      source: 'rule',
      reason: 'Bahan ini termasuk daftar bahan berisiko tinggi pada aturan internal.',
      codes: [],
    };
  }

  const budget = ensureBudgetRef(options);
  let hasResolvedSafe = false;

  for (const candidate of candidates) {
    if (budget.remaining <= 0) {
      break;
    }

    budget.remaining -= 1;
    const cid = await lookupPubChemCid(candidate);
    if (cid === undefined || cid === null) {
      continue;
    }

    const ghs = await lookupGhsCodesByCid(cid);
    if (ghs === null) {
      continue;
    }

    if (Array.isArray(ghs.high) && ghs.high.length > 0) {
      return {
        status: 'risky',
        source: 'pubchem',
        cid,
        reason: `Terindikasi kode bahaya GHS berdampak tinggi pada referensi PubChem (${ghs.high.join(
          ', '
        )}).`,
        codes: ghs.high,
      };
    }

    if (Array.isArray(ghs.caution) && ghs.caution.length > 0) {
      return {
        status: 'caution',
        source: 'pubchem',
        cid,
        reason: `Ada kode GHS level kehati-hatian pada referensi PubChem (${ghs.caution.join(
          ', '
        )}). Bahan ini tidak otomatis berbahaya, penilaian tetap bergantung kadar/formulasi.`,
        codes: ghs.caution,
      };
    }

    hasResolvedSafe = true;
  }

  if (hasResolvedSafe) {
    return {
      status: 'safe',
      source: 'pubchem',
      reason: 'Tidak ditemukan kode bahaya GHS berat pada referensi tambahan yang tersedia.',
      codes: [],
    };
  }

  return {
    status: 'unknown',
    source: 'pubchem',
    reason: 'Pengecekan tambahan belum konklusif untuk bahan ini.',
    codes: [],
  };
}

async function lookupPubChem(name) {
  const key = normalizeKey(name);
  if (!key) {
    return false;
  }

  const cached = getCachedValue(validationCache, key);
  if (cached !== null) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const url = `${PUBCHEM_BASE_URL}/${encodeURIComponent(name)}/cids/JSON`;
    const res = await fetch(url, { signal: controller.signal });

    if (res.status === 404 || res.status === 400) {
      setCachedValue(validationCache, key, false);
      return false;
    }

    if (!res.ok) {
      return null;
    }

    const payload = await res.json();
    const hasCid =
      payload &&
      payload.IdentifierList &&
      Array.isArray(payload.IdentifierList.CID) &&
      payload.IdentifierList.CID.length > 0;

    setCachedValue(validationCache, key, Boolean(hasCid));
    return Boolean(hasCid);
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyIngredientCandidates(candidates, budget) {
  if (candidates.length === 0) {
    return {
      validity: CANDIDATE_VALIDITY.INVALID,
      classification: null,
    };
  }

  if (candidates.some((candidate) => isKnownNonIngredient(candidate))) {
    return {
      validity: CANDIDATE_VALIDITY.INVALID,
      classification: null,
    };
  }

  let bestClassification = null;
  for (const candidate of candidates) {
    const classified = classifyIngredientName(candidate, {
      fuzzyThreshold: Number(process.env.INGREDIENT_FUZZY_THRESHOLD || 0.85),
    });
    const candidateClassification = buildCandidateClassification(candidate, classified);
    bestClassification = pickBetterClassification(bestClassification, candidateClassification);
    if (
      candidateClassification &&
      candidateClassification.classification === INGREDIENT_CLASSIFICATIONS.DANGEROUS
    ) {
      break;
    }
  }
  if (bestClassification) {
    return {
      validity: CANDIDATE_VALIDITY.VALID,
      classification: bestClassification,
    };
  }

  if (isWeakUntrustedToken(candidates[0])) {
    return {
      validity: CANDIDATE_VALIDITY.INVALID,
      classification: null,
    };
  }

  let hasUnknown = false;
  for (const candidate of candidates) {
    if (budget.remaining <= 0) {
      break;
    }

    budget.remaining -= 1;
    const result = await lookupPubChem(candidate);
    if (result === true) {
      return {
        validity: CANDIDATE_VALIDITY.VALID,
        classification: defaultSafeClassification(candidate, 'pubchem'),
      };
    }
    if (result === null) {
      hasUnknown = true;
    }
  }

  if (hasUnknown) {
    return {
      validity: CANDIDATE_VALIDITY.UNKNOWN,
      classification: null,
    };
  }

  return {
    validity: CANDIDATE_VALIDITY.INVALID,
    classification: null,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const output = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return output;
}

function dedupeStrings(items) {
  const unique = [];
  const seen = new Set();

  for (const item of items) {
    const clean = canonicalizeText(item);
    if (!isLikelyIngredient(clean)) {
      continue;
    }

    const key = normalizeKey(clean);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(clean);
  }

  return unique;
}

function upsertIngredientClassification(map, name, classificationInfo) {
  const canonicalName = canonicalizeText(name);
  if (!canonicalName) {
    return;
  }

  const key = normalizeKey(canonicalName);
  if (!key) {
    return;
  }

  const normalizedClassification = normalizeClassificationValue(
    classificationInfo?.classification,
    INGREDIENT_CLASSIFICATIONS.SAFE
  );
  const next = {
    name: canonicalName,
    classification: normalizedClassification,
    source: String(classificationInfo?.source || 'rule'),
    matchType: String(classificationInfo?.matchType || ''),
    confidence: Number(classificationInfo?.confidence || 0),
    matchedName: canonicalizeText(classificationInfo?.matchedName || canonicalName),
    family: String(classificationInfo?.family || ''),
  };

  const current = map.get(key);
  if (!current) {
    map.set(key, next);
    return;
  }

  const nextPriority = classificationPriority(next.classification);
  const currentPriority = classificationPriority(current.classification);
  if (nextPriority > currentPriority) {
    map.set(key, next);
    return;
  }

  if (nextPriority === currentPriority && next.confidence > current.confidence) {
    map.set(key, next);
  }
}

function buildIngredientClassificationOutput(riskyIngredients, safeIngredients, classificationMap) {
  const output = [];
  const seen = new Set();

  const appendClassification = (name, fallbackClassification) => {
    const canonicalName = canonicalizeText(name);
    const key = normalizeKey(canonicalName);
    if (!canonicalName || !key || seen.has(key)) {
      return;
    }

    seen.add(key);
    const existing = classificationMap.get(key);
    if (existing) {
      output.push(existing);
      return;
    }

    const classified = classifyIngredientName(canonicalName);
    const classification = normalizeClassificationValue(
      classified?.classification,
      fallbackClassification
    );
    output.push({
      name: canonicalName,
      classification,
      source: String(classified?.source || 'rule'),
      matchType: String(classified?.matchType || ''),
      confidence: Number(classified?.confidence || 0),
      matchedName: canonicalizeText(classified?.matchedName || canonicalName),
      family: String(classified?.family || ''),
    });
  };

  for (const item of riskyIngredients) {
    appendClassification(item?.name, INGREDIENT_CLASSIFICATIONS.DANGEROUS);
  }
  for (const safeName of safeIngredients) {
    appendClassification(safeName, INGREDIENT_CLASSIFICATIONS.SAFE);
  }

  return output;
}

function recomputeSummary(riskyCount, totalDetected) {
  return `${riskyCount} of ${totalDetected} detected ingredients are flagged as risky.`;
}

async function verifyParsedIngredientsOnline(parsedData) {
  if (!parsedData || typeof parsedData !== 'object') {
    return parsedData;
  }

  const budget = { remaining: MAX_ONLINE_LOOKUPS };
  const classificationMap = new Map();
  let removedInvalidCount = 0;
  let removedUnknownCount = 0;

  const riskyInput = Array.isArray(parsedData.riskyIngredients) ? parsedData.riskyIngredients : [];
  const safeInput = Array.isArray(parsedData.safeIngredients) ? parsedData.safeIngredients : [];

  const riskyChecks = await mapWithConcurrency(riskyInput, LOOKUP_CONCURRENCY, async (item) => {
    const candidates = buildCandidateList(item?.name, item?.aliases);
    if (candidates.length === 0) {
      recordNonIngredient(item?.name, 'empty_candidate');
      removedInvalidCount += 1;
      return null;
    }

    const verification = await verifyIngredientCandidates(candidates, budget);
    if (verification.validity !== CANDIDATE_VALIDITY.VALID) {
      if (verification.validity === CANDIDATE_VALIDITY.UNKNOWN) {
        removedUnknownCount += 1;
      } else {
        removedInvalidCount += 1;
      }
      return null;
    }

    const classificationInfo = verification.classification || defaultSafeClassification(item?.name);
    const preferredName =
      classificationInfo.matchType === 'keyword'
        ? item?.name
        : classificationInfo.canonicalName || item?.name;
    const outputName = canonicalizeText(preferredName);
    upsertIngredientClassification(classificationMap, outputName, classificationInfo);

    return {
      ...item,
      name: outputName,
      aliases: dedupeStrings(Array.isArray(item.aliases) ? item.aliases : []),
      classification: normalizeClassificationValue(
        classificationInfo.classification,
        INGREDIENT_CLASSIFICATIONS.DANGEROUS
      ),
    };
  });

  const verifiedRisky = riskyChecks.filter(Boolean);
  const riskyKeys = new Set(verifiedRisky.map((item) => normalizeKey(item.name)));

  const verifiedSafe = dedupeStrings(
    (
      await mapWithConcurrency(safeInput, LOOKUP_CONCURRENCY, async (name) => {
        const candidates = buildCandidateList(name, []);
        if (candidates.length === 0) {
          recordNonIngredient(name, 'empty_candidate');
          removedInvalidCount += 1;
          return null;
        }

        const verification = await verifyIngredientCandidates(candidates, budget);
        if (verification.validity !== CANDIDATE_VALIDITY.VALID) {
          if (verification.validity === CANDIDATE_VALIDITY.UNKNOWN) {
            removedUnknownCount += 1;
          } else {
            removedInvalidCount += 1;
          }
          return null;
        }

        const classificationInfo = verification.classification || defaultSafeClassification(name);
        const shouldUseCanonical = classificationInfo.matchType === 'exact' || classificationInfo.matchType === 'fuzzy';
        const outputName = canonicalizeText(
          shouldUseCanonical ? classificationInfo.canonicalName || name : name
        );
        upsertIngredientClassification(classificationMap, outputName, classificationInfo);

        return outputName;
      })
    ).filter(Boolean)
  ).filter((name) => !riskyKeys.has(normalizeKey(name)));
  const totalDetected = verifiedRisky.length + verifiedSafe.length;
  const safeCount = verifiedSafe.length;
  const summary = recomputeSummary(verifiedRisky.length, totalDetected);
  const ingredientClassifications = buildIngredientClassificationOutput(
    verifiedRisky,
    verifiedSafe,
    classificationMap
  );

  let warning = parsedData.warning ? String(parsedData.warning) : '';
  if (removedInvalidCount > 0) {
    const extra = `${removedInvalidCount} item dihapus karena tidak terverifikasi sebagai bahan (ingredient).`;
    warning = warning ? `${warning} ${extra}` : extra;
  }
  if (removedUnknownCount > 0) {
    const extra = `${removedUnknownCount} item tidak disertakan karena pengecekan tambahan belum konklusif.`;
    warning = warning ? `${warning} ${extra}` : extra;
  }

  const result = {
    ...parsedData,
    riskyIngredients: verifiedRisky,
    safeIngredients: verifiedSafe,
    safeCount,
    totalDetected,
    summary,
    ingredientClassifications,
  };

  delete result.aiDetectedValidated;

  if (warning) {
    result.warning = warning;
  } else {
    delete result.warning;
  }

  return result;
}

module.exports = {
  verifyParsedIngredientsOnline,
  doubleCheckIngredientSafetyOnline,
};
