const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(STORE_DIR, 'ingredient_decisions.json');

const CANONICAL_ALIASES = {
  mercury: ['merkuri', 'raksa', 'hg', 'mercuric chloride', 'mercury chloride'],
  hydroquinone: ['hidrokuinon'],
  lead: ['timbal', 'pb'],
  arsenic: ['arsen'],
  'rhodamine b': ['rhoda min b', 'rhoda mine b'],
  alcohol: ['ethanol', 'ethyl alcohol', 'alcohol denat', 'denatured alcohol'],
  fragrance: ['parfum', 'perfume'],
  'sodium benzoate': ['natrium benzoat'],
  water: ['aqua'],
};

const ALIAS_TO_CANONICAL = Object.entries(CANONICAL_ALIASES).reduce((acc, [canonical, aliases]) => {
  acc[canonical] = canonical;
  for (const alias of aliases) {
    acc[alias] = canonical;
  }
  return acc;
}, {});

let loaded = false;
let store = { version: 1, items: {} };

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalKey(value) {
  const key = normalizeKey(value);
  return ALIAS_TO_CANONICAL[key] || key;
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
  } catch (error) {
    // keep default empty store on any read/parse issue
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
    // non-fatal: if persistence fails, runtime still serves current response
  }
}

function buildRiskItemFromRecord(record, fallbackName) {
  return {
    name: record.name || fallbackName,
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    risk: String(record.risk || 'No description available'),
    severity: String(record.severity || 'medium'),
    severityReason: String(
      record.severityReason || 'Potential concern identified based on available safety context.'
    ),
    pregnancy: {
      safe: Boolean(record.pregnancy && record.pregnancy.safe),
      reason: String(
        (record.pregnancy && record.pregnancy.reason) ||
          'Perlu kehati-hatian saat hamil. Konsultasi medis disarankan.'
      ),
    },
    recommendation: {
      safe: Boolean(record.recommendation && record.recommendation.safe),
      reason: String(
        (record.recommendation && record.recommendation.reason) ||
          'Gunakan sesuai petunjuk dan evaluasi kondisi kulit secara berkala.'
      ),
    },
  };
}

function mergeWithRecord(current, record) {
  return {
    ...current,
    name: record.name || current.name,
    aliases:
      Array.isArray(record.aliases) && record.aliases.length > 0
        ? record.aliases
        : Array.isArray(current.aliases)
          ? current.aliases
          : [],
    risk: String(record.risk || current.risk || 'No description available'),
    severity: String(record.severity || current.severity || 'medium'),
    severityReason: String(
      record.severityReason ||
        current.severityReason ||
        'Potential concern identified based on available safety context.'
    ),
    pregnancy: {
      safe:
        typeof record?.pregnancy?.safe === 'boolean'
          ? record.pregnancy.safe
          : Boolean(current?.pregnancy?.safe),
      reason: String(
        record?.pregnancy?.reason ||
          current?.pregnancy?.reason ||
          'Perlu kehati-hatian saat hamil. Konsultasi medis disarankan.'
      ),
    },
    recommendation: {
      safe:
        typeof record?.recommendation?.safe === 'boolean'
          ? record.recommendation.safe
          : Boolean(current?.recommendation?.safe),
      reason: String(
        record?.recommendation?.reason ||
          current?.recommendation?.reason ||
          'Gunakan sesuai petunjuk dan evaluasi kondisi kulit secara berkala.'
      ),
    },
  };
}

function dedupeSafeIngredients(names) {
  const unique = [];
  const seen = new Set();

  for (const value of names) {
    const name = String(value || '').trim();
    if (!name) {
      continue;
    }

    const key = canonicalKey(name);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(name);
  }

  return unique;
}

function stabilizeWithIngredientMemory(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  ensureStoreLoaded();

  const now = new Date().toISOString();
  let changed = false;

  const riskyInput = Array.isArray(data.riskyIngredients) ? data.riskyIngredients : [];
  const safeInput = Array.isArray(data.safeIngredients) ? data.safeIngredients : [];

  const riskyMap = new Map();
  const safeMap = new Map();

  for (const item of riskyInput) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const key = canonicalKey(item.name);
    if (!key) {
      continue;
    }

    const record = store.items[key];
    if (record && record.verdict === 'safe') {
      const safeName = record.name || item.name;
      safeMap.set(key, safeName);
      continue;
    }

    if (record && record.verdict === 'risky') {
      riskyMap.set(key, mergeWithRecord(item, record));
      continue;
    }

    riskyMap.set(key, item);
  }

  for (const name of safeInput) {
    const key = canonicalKey(name);
    if (!key) {
      continue;
    }

    const record = store.items[key];
    if (record && record.verdict === 'risky') {
      riskyMap.set(key, buildRiskItemFromRecord(record, name));
      continue;
    }

    safeMap.set(key, record?.name || name);
  }

  for (const key of riskyMap.keys()) {
    safeMap.delete(key);
  }

  const riskyIngredients = Array.from(riskyMap.values());
  const safeIngredients = dedupeSafeIngredients(Array.from(safeMap.values()));

  for (const item of riskyIngredients) {
    const key = canonicalKey(item.name);
    if (!key) {
      continue;
    }

    const prev = store.items[key];
    const next = {
      verdict: 'risky',
      name: item.name,
      aliases: Array.isArray(item.aliases) ? item.aliases : [],
      risk: String(item.risk || 'No description available'),
      severity: String(item.severity || 'medium'),
      severityReason: String(item.severityReason || ''),
      pregnancy: {
        safe: Boolean(item?.pregnancy?.safe),
        reason: String(item?.pregnancy?.reason || ''),
      },
      recommendation: {
        safe: Boolean(item?.recommendation?.safe),
        reason: String(item?.recommendation?.reason || ''),
      },
      firstSeenAt: prev?.firstSeenAt || now,
      updatedAt: now,
      seenCount: Number(prev?.seenCount || 0) + 1,
    };

    store.items[key] = next;
    changed = true;
  }

  for (const name of safeIngredients) {
    const key = canonicalKey(name);
    if (!key) {
      continue;
    }

    const prev = store.items[key];
    if (prev && prev.verdict === 'risky') {
      continue;
    }

    store.items[key] = {
      verdict: 'safe',
      name,
      firstSeenAt: prev?.firstSeenAt || now,
      updatedAt: now,
      seenCount: Number(prev?.seenCount || 0) + 1,
    };
    changed = true;
  }

  if (changed) {
    persistStore();
  }

  const totalDetected = riskyIngredients.length + safeIngredients.length;
  const safeCount = safeIngredients.length;
  const summary = `${riskyIngredients.length} of ${totalDetected} detected ingredients are flagged as risky.`;

  return {
    ...data,
    riskyIngredients,
    safeIngredients,
    safeCount,
    totalDetected,
    summary,
  };
}

module.exports = {
  stabilizeWithIngredientMemory,
};

