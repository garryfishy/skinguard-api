const PUBCHEM_BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 2500;
const MAX_ONLINE_LOOKUPS = 24;
const LOOKUP_CONCURRENCY = 6;

const KNOWN_INGREDIENT_KEYS = new Set([
  'water',
  'aqua',
  'glycerin',
  'niacinamide',
  'fragrance',
  'parfum',
  'perfume',
  'alcohol',
  'ethanol',
  'ethyl alcohol',
  'alcohol denat',
  'sodium benzoate',
  'natrium benzoat',
  'phenoxyethanol',
  'salicylic acid',
  'asam salisilat',
  'benzyl alcohol',
  'benzoic acid',
  'potassium sorbate',
  'sorbic acid',
  'paraben',
  'methylparaben',
  'propylparaben',
  'butylparaben',
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
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyIngredient(value) {
  const text = canonicalizeText(value);
  if (!text || text.length < 2 || text.length > 80) {
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

function getCachedResult(key) {
  const cached = validationCache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    validationCache.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedResult(key, value) {
  validationCache.set(key, { value, ts: Date.now() });
}

async function lookupPubChem(name) {
  const key = normalizeKey(name);
  if (!key) {
    return false;
  }

  const cached = getCachedResult(key);
  if (cached !== null) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const url = `${PUBCHEM_BASE_URL}/${encodeURIComponent(name)}/cids/JSON`;
    const res = await fetch(url, { signal: controller.signal });

    if (res.status === 404 || res.status === 400) {
      setCachedResult(key, false);
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

    setCachedResult(key, Boolean(hasCid));
    return Boolean(hasCid);
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyIngredientCandidates(candidates, budget) {
  if (candidates.length === 0) {
    return false;
  }

  for (const candidate of candidates) {
    const key = normalizeKey(candidate);
    if (KNOWN_INGREDIENT_KEYS.has(key)) {
      return true;
    }
  }

  let hasUnknown = false;
  for (const candidate of candidates) {
    if (budget.remaining <= 0) {
      break;
    }

    budget.remaining -= 1;
    const result = await lookupPubChem(candidate);
    if (result === true) {
      return true;
    }
    if (result === null) {
      hasUnknown = true;
    }
  }

  if (hasUnknown) {
    return false;
  }

  return false;
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

function recomputeSummary(riskyCount, totalDetected) {
  return `${riskyCount} of ${totalDetected} detected ingredients are flagged as risky.`;
}

async function verifyParsedIngredientsOnline(parsedData) {
  if (!parsedData || typeof parsedData !== 'object') {
    return parsedData;
  }

  const budget = { remaining: MAX_ONLINE_LOOKUPS };
  let removedCount = 0;

  const riskyInput = Array.isArray(parsedData.riskyIngredients) ? parsedData.riskyIngredients : [];
  const safeInput = Array.isArray(parsedData.safeIngredients) ? parsedData.safeIngredients : [];

  const riskyChecks = await mapWithConcurrency(riskyInput, LOOKUP_CONCURRENCY, async (item) => {
    const candidates = buildCandidateList(item?.name, item?.aliases);
    const valid = await verifyIngredientCandidates(candidates, budget);
    if (!valid) {
      removedCount += 1;
      return null;
    }

    return {
      ...item,
      name: canonicalizeText(item.name),
      aliases: dedupeStrings(Array.isArray(item.aliases) ? item.aliases : []),
    };
  });

  const verifiedRisky = riskyChecks.filter(Boolean);
  const riskyKeys = new Set(verifiedRisky.map((item) => normalizeKey(item.name)));

  const safeChecks = await mapWithConcurrency(safeInput, LOOKUP_CONCURRENCY, async (name) => {
    const candidates = buildCandidateList(name, []);
    const valid = await verifyIngredientCandidates(candidates, budget);
    if (!valid) {
      removedCount += 1;
      return null;
    }

    const normalized = canonicalizeText(name);
    if (riskyKeys.has(normalizeKey(normalized))) {
      return null;
    }

    return normalized;
  });

  const verifiedSafe = dedupeStrings(safeChecks.filter(Boolean));
  const totalDetected = verifiedRisky.length + verifiedSafe.length;
  const safeCount = verifiedSafe.length;
  const summary = recomputeSummary(verifiedRisky.length, totalDetected);

  let warning = parsedData.warning ? String(parsedData.warning) : '';
  if (removedCount > 0) {
    const extra = `${removedCount} item dihapus karena tidak terverifikasi sebagai bahan (ingredient).`;
    warning = warning ? `${warning} ${extra}` : extra;
  }

  const result = {
    ...parsedData,
    riskyIngredients: verifiedRisky,
    safeIngredients: verifiedSafe,
    safeCount,
    totalDetected,
    summary,
  };

  if (warning) {
    result.warning = warning;
  } else {
    delete result.warning;
  }

  return result;
}

module.exports = {
  verifyParsedIngredientsOnline,
};
