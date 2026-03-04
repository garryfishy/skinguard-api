const fs = require('fs');
const path = require('path');
const { doubleCheckIngredientSafetyOnline } = require('./verifyIngredientOnline');
const {
  isDatasetDangerousIngredient,
  getDatasetCanonicalKey,
} = require('./ingredientDataset');

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
  phenoxyethanol: ['fenoksietanol'],
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
const INTERNET_RECHECK_BUDGET = 40;
const INTERNET_RECHECK_CONCURRENCY = 4;

const HIGH_IMPACT_CODES = new Set([
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
  'H410',
]);

const ALWAYS_UNSAFE_KEYS = new Set([
  'mercury',
  'hydroquinone',
  'lead',
  'arsenic',
  'rhodamine b',
  'tretinoin',
  'clobetasol',
]);

const CONTEXTUAL_CAUTION_KEYS = new Set([
  'alcohol',
  'sodium benzoate',
  'fragrance',
  'phenoxyethanol',
  'salicylic acid',
  'benzyl alcohol',
  'benzoic acid',
  'potassium sorbate',
  'sorbic acid',
  'paraben',
  'propylene glycol',
  'butylene glycol',
  'caprylic',
  'caprylyl glycol',
  'sodium lactate',
  'zinc oxide',
  'titanium dioxide',
]);

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalKey(value) {
  const key = normalizeKey(value);
  const datasetCanonical = getDatasetCanonicalKey(value);
  if (datasetCanonical) {
    return datasetCanonical;
  }
  return ALIAS_TO_CANONICAL[key] || key;
}

function choosePreferredLanguageName(canonical, variants = []) {
  const cleanedVariants = variants
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (cleanedVariants.length === 0) {
    return '';
  }

  const canonicalHit = cleanedVariants.find((name) => normalizeKey(name) === canonical);
  if (canonicalHit) {
    return canonicalHit;
  }

  return cleanedVariants[0];
}

function isAlwaysUnsafeIngredient(value) {
  const key = canonicalKey(value);
  return ALWAYS_UNSAFE_KEYS.has(key) || isDatasetDangerousIngredient(value) || isDatasetDangerousIngredient(key);
}

function isContextualCautionIngredient(value) {
  return CONTEXTUAL_CAUTION_KEYS.has(canonicalKey(value));
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
    name: current.name || record.name,
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
  const grouped = new Map();
  const order = [];

  for (const value of names) {
    const name = String(value || '').trim();
    if (!name) {
      continue;
    }

    const key = canonicalKey(name);
    if (!key) {
      continue;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key).push(name);
  }

  return order
    .map((key) => choosePreferredLanguageName(key, grouped.get(key)))
    .filter(Boolean);
}

function toDisplayName(name, fallback = '') {
  const value = String(name || '').trim();
  return value || String(fallback || '').trim();
}

function hasHighImpactCodes(codes = []) {
  return Array.isArray(codes) && codes.some((code) => HIGH_IMPACT_CODES.has(String(code || '')));
}

function isHardUnsafeByCheck(name, check) {
  if (isAlwaysUnsafeIngredient(name)) {
    return true;
  }

  const highImpact = hasHighImpactCodes(check?.codes);
  if (!highImpact) {
    return false;
  }

  if (isContextualCautionIngredient(name)) {
    return false;
  }

  return true;
}

function buildRiskItemFromOnlineCheck(name, check) {
  const hardUnsafe = isHardUnsafeByCheck(name, check);

  return {
    name: toDisplayName(name, 'Unknown ingredient'),
    aliases: [],
    risk: String(
      check?.reason ||
        'Bahan ini memiliki indikator bahaya dari referensi online sehingga perlu kehati-hatian tinggi.'
    ),
    severity: hardUnsafe ? 'high' : 'medium',
    severityReason: hardUnsafe
      ? 'Terdapat kode bahaya GHS berdampak tinggi pada referensi online.'
      : 'Terdapat indikator kehati-hatian pada referensi online sehingga risikonya kontekstual (bergantung kadar/formulasi).',
    pregnancy: {
      safe: false,
      reason: hardUnsafe
        ? 'Tidak disarankan saat hamil karena ada indikasi toksisitas tinggi.'
        : 'Perlu kehati-hatian saat hamil; konsultasikan penggunaan terutama bila kulit sensitif atau ada riwayat iritasi.',
    },
    recommendation: {
      safe: !hardUnsafe,
      reason: hardUnsafe
        ? 'Tidak direkomendasikan sebelum ada konfirmasi kadar/formulasi dan evaluasi profesional.'
        : 'Masih bisa dipertimbangkan untuk dibeli, namun gunakan dengan hati-hati karena efeknya bergantung pada kadar dan toleransi kulit.',
    },
  };
}

function strengthenRiskItemWithOnlineCheck(item, check) {
  if (!item || typeof item !== 'object') {
    return buildRiskItemFromOnlineCheck(item?.name || 'Unknown ingredient', check);
  }

  const hardUnsafe = isHardUnsafeByCheck(item.name, check);
  const keepHigh = item.severity === 'high' && hardUnsafe;
  const severity = hardUnsafe || keepHigh ? 'high' : 'medium';
  const severityReason = hardUnsafe
    ? 'Verifikasi internet menemukan indikator bahaya berdampak tinggi.'
    : item.severityReason ||
      'Verifikasi internet menunjukkan level kehati-hatian, sehingga penilaian bergantung kadar/formulasi.';
  const recommendationSafe = hardUnsafe ? false : true;
  const recommendationReason = hardUnsafe
    ? 'Tidak direkomendasikan sampai ada bukti kadar/formulasi yang jelas dan evaluasi lebih lanjut.'
    : 'Masih direkomendasikan dengan catatan: gunakan bertahap, perhatikan reaksi kulit, dan hindari pemakaian berlebihan.';

  return {
    ...item,
    severity,
    severityReason,
    risk: String(check?.reason || item.risk || 'No description available'),
    pregnancy: {
      safe: false,
      reason: hardUnsafe
        ? 'Tidak aman untuk kehamilan karena indikator bahaya tinggi.'
        : 'Perlu kehati-hatian saat hamil; gunakan seperlunya dan konsultasikan bila perlu.',
    },
    recommendation: {
      safe: recommendationSafe,
      reason: recommendationReason,
    },
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

function mergeWarnings(...warnings) {
  return warnings
    .map((w) => String(w || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function stabilizeWithIngredientMemory(data, options = {}) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  ensureStoreLoaded();

  const now = new Date().toISOString();
  const forceInternetRecheck = options.forceInternetRecheck !== false;
  const recheckBudgetValue =
    typeof options.internetRecheckBudget === 'number' && Number.isFinite(options.internetRecheckBudget)
      ? Math.max(0, Math.floor(options.internetRecheckBudget))
      : INTERNET_RECHECK_BUDGET;
  const recheckBudget = { remaining: recheckBudgetValue };
  let changed = false;

  const riskyInput = Array.isArray(data.riskyIngredients) ? data.riskyIngredients : [];
  const safeInput = Array.isArray(data.safeIngredients) ? data.safeIngredients : [];

  const riskyMap = new Map();
  const safeMap = new Map();
  const nameByKey = new Map();
  const aliasesByKey = new Map();
  const keysToRecheck = new Set();
  const internetCheckByKey = new Map();
  let escalatedByInternetCount = 0;
  let softenedByInternetCount = 0;

  for (const item of riskyInput) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const key = canonicalKey(item.name);
    if (!key) {
      continue;
    }
    if (forceInternetRecheck) {
      keysToRecheck.add(key);
    }

    nameByKey.set(key, toDisplayName(item.name, key));
    if (Array.isArray(item.aliases) && item.aliases.length > 0) {
      aliasesByKey.set(key, item.aliases);
    }

    const record = store.items[key];
    if (record && record.verdict === 'safe') {
      const safeName = record.name || item.name;
      safeMap.set(key, safeName);
      if (forceInternetRecheck) {
        keysToRecheck.add(key);
      }
      continue;
    }

    if (record && record.verdict === 'risky') {
      riskyMap.set(key, mergeWithRecord(item, record));
      if (forceInternetRecheck) {
        keysToRecheck.add(key);
      }
      continue;
    }

    riskyMap.set(key, item);
  }

  for (const name of safeInput) {
    const key = canonicalKey(name);
    if (!key) {
      continue;
    }
    if (forceInternetRecheck) {
      keysToRecheck.add(key);
    }

    nameByKey.set(key, toDisplayName(name, key));
    const record = store.items[key];
    if (record && record.verdict === 'risky') {
      if (isContextualCautionIngredient(name) && !isAlwaysUnsafeIngredient(name)) {
        const currentSafeName = safeMap.get(key) || '';
        const preferredSafeName = choosePreferredLanguageName(
          key,
          [currentSafeName, name, record?.name].filter(Boolean)
        );
        safeMap.set(key, preferredSafeName || record?.name || name);
        if (forceInternetRecheck) {
          keysToRecheck.add(key);
        }
        continue;
      }

      riskyMap.set(key, buildRiskItemFromRecord(record, name));
      if (forceInternetRecheck) {
        keysToRecheck.add(key);
      }
      continue;
    }

    const currentSafeName = safeMap.get(key) || '';
    const preferredSafeName = choosePreferredLanguageName(
      key,
      [currentSafeName, name, record?.name].filter(Boolean)
    );
    safeMap.set(key, preferredSafeName || record?.name || name);
    if (record && forceInternetRecheck) {
      keysToRecheck.add(key);
    }
  }

  if (forceInternetRecheck && keysToRecheck.size > 0 && recheckBudget.remaining > 0) {
    const entries = Array.from(keysToRecheck);
    const results = await mapWithConcurrency(
      entries,
      INTERNET_RECHECK_CONCURRENCY,
      async (key) => {
        const displayName = nameByKey.get(key) || store.items[key]?.name || key;
        const aliases = aliasesByKey.get(key) || store.items[key]?.aliases || [];
        const check = await doubleCheckIngredientSafetyOnline(displayName, aliases, {
          budget: recheckBudget,
        });
        return {
          key,
          displayName: toDisplayName(displayName, key),
          check,
        };
      }
    );

    for (const result of results) {
      if (!result || !result.key || !result.check) {
        continue;
      }

      const normalizedCheck = {
        status: String(result.check.status || 'unknown'),
        source: String(result.check.source || 'pubchem'),
        reason: String(result.check.reason || ''),
        checkedAt: now,
        codes: Array.isArray(result.check.codes) ? result.check.codes : [],
      };
      internetCheckByKey.set(result.key, normalizedCheck);

      const existingRisk = riskyMap.get(result.key);

      if (normalizedCheck.status === 'safe') {
        if (existingRisk && !isAlwaysUnsafeIngredient(existingRisk.name || result.displayName)) {
          riskyMap.delete(result.key);
          safeMap.set(result.key, toDisplayName(existingRisk.name, result.displayName));
          softenedByInternetCount += 1;
        }
        continue;
      }

      if (normalizedCheck.status === 'caution') {
        if (existingRisk) {
          riskyMap.set(result.key, strengthenRiskItemWithOnlineCheck(existingRisk, normalizedCheck));
          softenedByInternetCount += 1;
        } else if (isContextualCautionIngredient(result.displayName) && !safeMap.has(result.key)) {
          riskyMap.set(result.key, buildRiskItemFromOnlineCheck(result.displayName, normalizedCheck));
        }
        continue;
      }

      if (normalizedCheck.status !== 'risky') {
        continue;
      }

      const isContextualHighCode =
        isContextualCautionIngredient(result.displayName) &&
        !isAlwaysUnsafeIngredient(result.displayName);
      if (isContextualHighCode) {
        const existingContextualRisk = riskyMap.get(result.key);
        const softenedCheck = {
          ...normalizedCheck,
          status: 'caution',
          reason:
            'Terdapat indikator hazard pada data referensi bahan murni, namun untuk kosmetik penilaian tetap kontekstual (kadar, formulasi, dan cara pakai).',
        };
        if (existingContextualRisk) {
          riskyMap.set(result.key, strengthenRiskItemWithOnlineCheck(existingContextualRisk, softenedCheck));
          softenedByInternetCount += 1;
        }
        continue;
      }

      const wasSafe = safeMap.has(result.key);
      safeMap.delete(result.key);
      if (existingRisk) {
        riskyMap.set(result.key, strengthenRiskItemWithOnlineCheck(existingRisk, normalizedCheck));
      } else {
        riskyMap.set(result.key, buildRiskItemFromOnlineCheck(result.displayName, normalizedCheck));
      }

      if (wasSafe || !existingRisk) {
        escalatedByInternetCount += 1;
      }
    }
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
      internetCheck: internetCheckByKey.get(key) || prev?.internetCheck || null,
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
    const latestCheckStatus = internetCheckByKey.get(key)?.status || prev?.internetCheck?.status || '';
    const canDowngradeRiskyToSafe =
      prev &&
      prev.verdict === 'risky' &&
      (latestCheckStatus === 'safe' ||
        (isContextualCautionIngredient(name) &&
          !isAlwaysUnsafeIngredient(name) &&
          latestCheckStatus === 'caution')) &&
      !isAlwaysUnsafeIngredient(name);

    if (prev && prev.verdict === 'risky' && !canDowngradeRiskyToSafe) {
      continue;
    }

    store.items[key] = {
      verdict: 'safe',
      name,
      internetCheck: internetCheckByKey.get(key) || prev?.internetCheck || null,
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

  const baseWarning = String(data.warning || '').trim();
  const escalateMessage =
    escalatedByInternetCount > 0
      ? `${escalatedByInternetCount} bahan dipastikan berisiko melalui verifikasi internet tambahan.`
      : '';
  const softenMessage =
    softenedByInternetCount > 0
      ? `${softenedByInternetCount} bahan dilonggarkan ke status kehati-hatian/aman berdasarkan verifikasi internet terbaru.`
      : '';

  const finalWarning = mergeWarnings(
    baseWarning,
    escalateMessage && !baseWarning.includes(escalateMessage) ? escalateMessage : '',
    softenMessage && !baseWarning.includes(softenMessage) ? softenMessage : ''
  );

  const result = {
    ...data,
    riskyIngredients,
    safeIngredients,
    safeCount,
    totalDetected,
    summary,
  };

  if (finalWarning) {
    result.warning = finalWarning;
  } else {
    delete result.warning;
  }

  return result;
}

module.exports = {
  stabilizeWithIngredientMemory,
};
