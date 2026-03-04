const fs = require('fs');
const path = require('path');
const { isDatasetIngredient, getDatasetCanonicalKey } = require('./ingredientDataset');

const STORE_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(STORE_DIR, 'non_ingredient_tokens.json');
const MIN_COUNT_DEFAULT = Number(process.env.NON_INGREDIENT_MIN_COUNT || 2);
const SOFT_REJECTION_REASONS = new Set([
  'ai_rejected_candidate',
  'no_dataset_or_pubchem_match',
  'pipeline_rejected_candidate',
]);
const STRONG_REJECTION_REASONS = new Set(['empty_candidate', 'manual_block', 'validation_failed']);

let loaded = false;
let store = { version: 1, items: {} };

const INGREDIENT_LIKE_PATTERN =
  /\b(acid|extract|glycol|oxide|chloride|sulfate|phosphate|amide|amine|ester|alcohol|benzoate|paraben|hyaluronate|niacinamide|panthenol|tocopherol|allantoin|dimethicone|ceramide|peptide|vitamin|fragrance|perfume|oil|wax|butter|sodium|potassium|calcium|magnesium|zinc|titanium|capry|laur|stear|palmit|cetearyl|cetyl|polysorbate|sugar|gula|glucose|sucrose|mercury|merkuri|hydroquinone|hidrokuinon)\b/i;
const INGREDIENT_LIKE_SUFFIX_PATTERN = /(acid|ate|ite|ide|ine|ene|one|ol|ose|ium|yl|oxy)$/i;

function normalizeTokenKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalTokenKey(value) {
  for (const variant of buildLookupVariants(value)) {
    const datasetCanonical = getDatasetCanonicalKey(variant);
    if (datasetCanonical) {
      return normalizeTokenKey(datasetCanonical);
    }
  }

  return normalizeTokenKey(value);
}

function buildLookupVariants(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }

  const variants = new Set([raw]);
  const removedParens = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (removedParens) {
    variants.add(removedParens);
  }

  const parenMatches = raw.match(/\(([^)]*)\)/g) || [];
  for (const match of parenMatches) {
    const inside = String(match || '')
      .replace(/[()]/g, '')
      .trim();
    if (inside) {
      variants.add(inside);
    }
  }

  for (const part of raw.split(/[\/|]/g)) {
    const cleanPart = String(part || '').trim();
    if (cleanPart) {
      variants.add(cleanPart);
    }
  }

  return Array.from(variants);
}

function looksIngredientLikeToken(value) {
  return buildLookupVariants(value).some((variant) => {
    const text = String(variant || '').trim();
    if (!text) {
      return false;
    }

    if (INGREDIENT_LIKE_PATTERN.test(text)) {
      return true;
    }

    const singleWord = text.split(/\s+/).filter(Boolean);
    if (singleWord.length !== 1) {
      return false;
    }

    return INGREDIENT_LIKE_SUFFIX_PATTERN.test(singleWord[0].toLowerCase());
  });
}

function hasStrongReason(item) {
  const reasons = item && typeof item.reasons === 'object' ? item.reasons : {};
  return Object.entries(reasons).some(
    ([reason, count]) => STRONG_REJECTION_REASONS.has(String(reason || '')) && Number(count || 0) > 0
  );
}

function cleanupLikelyIngredientFalsePositives() {
  let changed = false;
  for (const [key, item] of Object.entries(store.items || {})) {
    const token = item?.token || key;
    if (!looksIngredientLikeToken(token)) {
      continue;
    }

    if (hasStrongReason(item)) {
      continue;
    }

    delete store.items[key];
    changed = true;
  }

  if (changed) {
    persistStore();
  }
}

function isDatasetIngredientByVariants(token) {
  return buildLookupVariants(token).some((variant) => isDatasetIngredient(variant));
}

function getStoreItemByToken(token) {
  const canonicalKey = canonicalTokenKey(token);
  const normalizedKey = normalizeTokenKey(token);

  if (store.items[canonicalKey]) {
    return store.items[canonicalKey];
  }

  if (normalizedKey && normalizedKey !== canonicalKey && store.items[normalizedKey]) {
    return store.items[normalizedKey];
  }

  return null;
}

function ensureStoreLoaded() {
  if (loaded) {
    return;
  }

  loaded = true;
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return;
    }

    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const items = parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
    store = {
      version: 1,
      items,
    };
    cleanupLikelyIngredientFalsePositives();
  } catch (error) {
    // keep default empty store on read/parse error
  }
}

function persistStore() {
  try {
    if (!fs.existsSync(STORE_DIR)) {
      fs.mkdirSync(STORE_DIR, { recursive: true });
    }

    const tempPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tempPath, STORE_PATH);
  } catch (error) {
    // non-fatal
  }
}

function isKnownNonIngredient(token, minCount = MIN_COUNT_DEFAULT) {
  ensureStoreLoaded();

  const key = canonicalTokenKey(token);
  if (!key) {
    return false;
  }

  const item = getStoreItemByToken(token);
  if (!item) {
    return false;
  }

  if (looksIngredientLikeToken(token) && !hasStrongReason(item)) {
    return false;
  }

  return Number(item.count || 0) >= Math.max(1, Number(minCount || MIN_COUNT_DEFAULT));
}

function recordNonIngredient(token, reason = 'validation_failed') {
  ensureStoreLoaded();

  const displayToken = String(token || '').trim();
  const key = canonicalTokenKey(displayToken);
  if (!displayToken || !key) {
    return false;
  }

  if (isDatasetIngredientByVariants(displayToken)) {
    return false;
  }

  const normalizedReason = String(reason || 'validation_failed').trim() || 'validation_failed';
  if (SOFT_REJECTION_REASONS.has(normalizedReason) && looksIngredientLikeToken(displayToken)) {
    return false;
  }

  const now = new Date().toISOString();
  const prev = getStoreItemByToken(displayToken);
  const reasons = prev && prev.reasons && typeof prev.reasons === 'object' ? prev.reasons : {};
  reasons[normalizedReason] = Number(reasons[normalizedReason] || 0) + 1;

  store.items[key] = {
    token: prev?.token || displayToken,
    normalizedKey: key,
    count: Number(prev?.count || 0) + 1,
    reasons,
    firstSeenAt: prev?.firstSeenAt || now,
    updatedAt: now,
  };

  persistStore();
  return true;
}

function getNonIngredientStoreInfo() {
  ensureStoreLoaded();
  return {
    path: STORE_PATH,
    loaded,
    totalTokens: Object.keys(store.items || {}).length,
    minCountDefault: MIN_COUNT_DEFAULT,
  };
}

module.exports = {
  normalizeTokenKey,
  isKnownNonIngredient,
  recordNonIngredient,
  getNonIngredientStoreInfo,
};
