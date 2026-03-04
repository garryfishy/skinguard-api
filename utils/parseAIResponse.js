const NON_INGREDIENT_PATTERNS = [
  /\bmade in\b/i,
  /\bnetto\b/i,
  /\bexp(iry)?\b/i,
  /\bbatch\b/i,
  /\blot\b/i,
  /\bmfg\b/i,
  /\bbpom\b/i,
  /\bhow to use\b/i,
  /\bcara pakai\b/i,
  /\bwarning\b/i,
  /\bperingatan\b/i,
  /\bmanufactured by\b/i,
  /\bdistributed by\b/i,
  /\bdiproduksi oleh\b/i,
  /\bdipasarkan oleh\b/i,
  /\bcompany\b/i,
  /\balamat\b/i,
  /\baddress\b/i,
  /\bcustomer service\b/i,
  /\bpt\b/i,
  /\bcv\b/i,
  /\bltd\b/i,
  /\binc\b/i,
  /\bllc\b/i,
  /\bfor external use\b/i,
  /\bno\.?\s*\d+/i,
  /https?:\/\//i,
  /www\./i,
];

const CANONICAL_ALIASES = {
  mercury: ['merkuri', 'raksa', 'hg', 'mercuric chloride', 'mercury chloride'],
  hydroquinone: ['hidrokuinon'],
  tretinoin: ['retinoic acid', 'asam retinoat'],
  clobetasol: ['clobetasol propionate'],
  lead: ['timbal', 'pb'],
  arsenic: ['arsen'],
  'rhodamine b': ['rhoda min b', 'rhoda mine b'],
  alcohol: ['ethanol', 'ethyl alcohol', 'alcohol denat', 'denatured alcohol'],
  'sodium benzoate': ['natrium benzoat'],
  fragrance: ['parfum', 'perfume'],
  phenoxyethanol: [],
  'salicylic acid': ['asam salisilat', 'bha'],
  'benzyl alcohol': [],
  'benzoic acid': ['asam benzoat'],
  'potassium sorbate': [],
  'sorbic acid': [],
  paraben: ['parabens', 'methylparaben', 'propylparaben', 'butylparaben'],
  water: ['aqua'],
};

const DEFINITELY_DANGEROUS_KEYS = new Set([
  'mercury',
  'hydroquinone',
  'lead',
  'arsenic',
  'rhodamine b',
  'tretinoin',
  'clobetasol',
]);

const CONDITIONAL_CAUTION_KEYS = new Set([
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
]);

const ALIAS_TO_CANONICAL = Object.entries(CANONICAL_ALIASES).reduce((acc, [canonical, aliases]) => {
  acc[canonical] = canonical;
  for (const alias of aliases) {
    acc[alias] = canonical;
  }
  return acc;
}, {});

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

function clampSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function isLikelyIngredient(token) {
  if (!token || token.length < 2 || token.length > 80) {
    return false;
  }

  const normalized = token.toLowerCase();
  if (NON_INGREDIENT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const words = token.split(/\s+/).filter(Boolean).length;
  if (words > 6) {
    return false;
  }

  if (/^[0-9.\-+%\s]+$/.test(token)) {
    return false;
  }

  return /[a-z]/i.test(token);
}

function extractIngredientSection(ingredientText) {
  const text = String(ingredientText || '');
  if (!text.trim()) {
    return '';
  }

  const startRegex = /(ingredients?|komposisi|kandungan)\s*:/i;
  const startMatch = startRegex.exec(text);
  const start = startMatch ? startMatch.index + startMatch[0].length : 0;

  const lower = text.toLowerCase();
  const stopMarkers = [
    'how to use',
    'cara pakai',
    'warning',
    'peringatan',
    'manufactured by',
    'distributed by',
    'diproduksi oleh',
    'dipasarkan oleh',
    'bpom',
    'netto',
    'exp',
    'mfg',
    'batch',
    'lot',
    'alamat',
    'address',
  ];

  let end = text.length;
  for (const marker of stopMarkers) {
    const idx = lower.indexOf(marker, start);
    if (idx !== -1 && idx < end) {
      end = idx;
    }
  }

  return text.slice(start, end);
}

function extractDetectedIngredients(ingredientText) {
  if (typeof ingredientText !== 'string') {
    return [];
  }

  const sourceSection = extractIngredientSection(ingredientText);
  const cleaned = sourceSection
    .replace(/ingredients?|komposisi|kandungan\s*:/gi, '')
    .replace(/[()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return [];
  }

  const rawItems = cleaned
    .split(/[,;\n|/]+/)
    .map((part) => part.trim())
    .map((part) => part.replace(/^[\-\d.\s]+/, '').trim())
    .map((part) => part.replace(/^[:\-–—\s]+/, '').trim())
    .map((part) => part.replace(/\s{2,}/g, ' '));

  const unique = [];
  const seen = new Set();
  for (const item of rawItems) {
    if (!isLikelyIngredient(item)) {
      continue;
    }

    const key = canonicalKey(item);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDetectedKeySet(detectedIngredients) {
  const keys = new Set();
  for (const ingredient of detectedIngredients) {
    const key = canonicalKey(ingredient);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function isIngredientMentionedInSource(item, detectedKeySet, ingredientText) {
  const normalizedSource = normalizeKey(ingredientText);
  const candidates = [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])];

  for (const candidate of candidates) {
    const key = canonicalKey(candidate);
    if (!key) {
      continue;
    }

    if (detectedKeySet.has(key)) {
      return true;
    }

    const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, 'i');
    if (normalizedSource && regex.test(normalizedSource)) {
      return true;
    }
  }

  return false;
}

function sanitizeAliases(aliases) {
  if (!Array.isArray(aliases)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const alias of aliases) {
    const cleaned = String(alias || '').trim();
    if (!cleaned) {
      continue;
    }

    const key = canonicalKey(cleaned);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(cleaned);
    if (result.length >= 10) {
      break;
    }
  }

  return result;
}

function normalizeIngredient(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const name = String(item.name || '').trim();
  if (!name) {
    return null;
  }

  const severity = clampSeverity(item.severity);
  const severityReason = String(
    item.severityReason || item.severity_reason || item.severityExplanation || ''
  ).trim();

  let defaultSeverityReason = 'Potential concern identified based on available safety context.';
  if (severity === 'high') {
    defaultSeverityReason = 'High risk due to strong toxicity concerns and/or common regulatory restrictions.';
  } else if (severity === 'medium') {
    defaultSeverityReason = 'Moderate risk due to possible irritation/toxicity depending on concentration and exposure.';
  } else if (severity === 'low') {
    defaultSeverityReason = 'Lower risk in typical use, but still flagged due to possible sensitivity or misuse.';
  }

  const pregnancySafeRaw =
    item?.pregnancy?.safe ??
    item?.pregnancySafe ??
    item?.pregnancy_safe;
  const pregnancySafe = typeof pregnancySafeRaw === 'boolean' ? pregnancySafeRaw : false;
  const pregnancyReasonRaw =
    item?.pregnancy?.reason ??
    item?.pregnancyReason ??
    item?.pregnancy_reason;
  const pregnancyReason = String(pregnancyReasonRaw || '').trim();
  const defaultPregnancyReason = pregnancySafe
    ? 'Umumnya dianggap lebih aman untuk kehamilan bila digunakan sesuai aturan, namun tetap disarankan konsultasi medis.'
    : 'Tidak disarankan saat hamil karena potensi risiko pada ibu/janin dan keterbatasan data keamanan.';

  const recommendationReasonRaw =
    item?.recommendation?.reason ??
    item?.recommendationReason ??
    item?.recommendation_reason ??
    item?.safeToBuy?.reason ??
    item?.safe_to_buy?.reason ??
    item?.safeToBuyReason ??
    item?.safe_to_buy_reason;
  const recommendationReason = String(recommendationReasonRaw || '').trim();
  const recommendationSafeRaw =
    item?.recommendation?.safe ??
    item?.recommendationSafe ??
    item?.recommendation_safe ??
    item?.safeToBuy?.safe ??
    item?.safe_to_buy?.safe ??
    item?.safeToBuySafe ??
    item?.safe_to_buy_safe;
  const recommendationSafe = typeof recommendationSafeRaw === 'boolean' ? recommendationSafeRaw : null;

  return {
    name,
    aliases: sanitizeAliases(item.aliases),
    risk: String(item.risk || 'No description available').trim() || 'No description available',
    severity,
    severityReason: severityReason || defaultSeverityReason,
    pregnancy: {
      safe: pregnancySafe,
      reason: pregnancyReason || defaultPregnancyReason,
    },
    recommendation: {
      safe: recommendationSafe,
      reason: recommendationReason,
    },
  };
}

function buildDetectedIngredientIndex(detectedIngredients) {
  const indexMap = new Map();
  detectedIngredients.forEach((item, index) => {
    const key = canonicalKey(item);
    if (key && !indexMap.has(key)) {
      indexMap.set(key, index);
    }
  });
  return indexMap;
}

function findIngredientIndex(item, detectedIndexMap) {
  const candidates = [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])];
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const idx = detectedIndexMap.get(canonicalKey(candidate));
    if (typeof idx === 'number' && idx < best) {
      best = idx;
    }
  }
  return Number.isFinite(best) ? best : -1;
}

function hasHighConcentrationHint(item, ingredientIndex) {
  if (ingredientIndex !== -1 && ingredientIndex <= 2) {
    return true;
  }

  const text = `${item.risk || ''} ${item.severityReason || ''}`.toLowerCase();
  return /kadar tinggi|konsentrasi tinggi|high concentration|high amount|tinggi dalam komposisi/.test(text);
}

function computeRecommendation(item, ingredientIndex) {
  const key = canonicalKey(item.name);
  const definitelyDangerous = DEFINITELY_DANGEROUS_KEYS.has(key);
  const conditional = CONDITIONAL_CAUTION_KEYS.has(key);
  const highConcentrationLikely = hasHighConcentrationHint(item, ingredientIndex);

  if (definitelyDangerous) {
    return {
      safe: false,
      reason:
        'Tidak direkomendasikan untuk dibeli karena bahan ini termasuk berisiko tinggi dan umum dibatasi/dilarang dalam penggunaan kosmetik.',
    };
  }

  if (conditional) {
    if (item.severity === 'high' && highConcentrationLikely) {
      return {
        safe: false,
        reason:
          'Tidak direkomendasikan untuk dibeli karena bahan ini bersifat kontekstual namun terindikasi berisiko tinggi pada kadar/paparan yang kemungkinan tinggi.',
      };
    }

    return {
      safe: true,
      reason:
        'Masih bisa dipertimbangkan untuk dibeli, namun gunakan dengan hati-hati karena risiko bahan ini bergantung pada kadar, frekuensi pemakaian, dan sensitivitas kulit.',
    };
  }

  if (item.severity === 'high') {
    return {
      safe: false,
      reason:
        'Tidak direkomendasikan untuk dibeli karena tingkat risikonya tinggi berdasarkan profil toksisitas dan potensi dampak kesehatan.',
    };
  }

  if (item.severity === 'medium') {
    return {
      safe: true,
      reason:
        'Masih bisa dipertimbangkan untuk dibeli, tetapi perlu kehati-hatian dalam pemakaian dan sebaiknya dilakukan uji cocok (patch test).',
    };
  }

  return {
    safe: true,
    reason:
      'Secara umum masih layak dibeli, namun tetap gunakan sesuai petunjuk dan hentikan pemakaian jika muncul iritasi.',
  };
}

function normalizeRecommendationReason(aiReason, safeValue, fallbackReason) {
  const reason = String(aiReason || '').trim();
  if (!reason) {
    return fallbackReason;
  }

  const positivePattern = /\baman\b|\bdirekomendasikan\b|\blayak\b/i;
  const negativePattern = /\btidak disarankan\b|\bberisiko tinggi\b|\bjangan\b/i;

  if (safeValue === false && positivePattern.test(reason) && !negativePattern.test(reason)) {
    return fallbackReason;
  }

  if (safeValue === true && negativePattern.test(reason) && !positivePattern.test(reason)) {
    return fallbackReason;
  }

  return reason;
}

function extractJsonChunk(rawText) {
  const text = String(rawText || '');
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1);
  }

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');

  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }

  return '';
}

function severityScore(value) {
  if (value === 'high') {
    return 3;
  }
  if (value === 'medium') {
    return 2;
  }
  return 1;
}

function mergeRiskyIngredients(items) {
  const merged = new Map();

  for (const item of items) {
    const key = canonicalKey(item.name);
    if (!key) {
      continue;
    }

    if (!merged.has(key)) {
      merged.set(key, {
        name: item.name,
        aliases: [...item.aliases],
        risk: item.risk,
        severity: item.severity,
        severityReason: item.severityReason,
        pregnancy: item.pregnancy,
        recommendation: item.recommendation,
      });
      continue;
    }

    const existing = merged.get(key);
    const aliasPool = [...existing.aliases, item.name, ...item.aliases];
    existing.aliases = sanitizeAliases(aliasPool);

    if (severityScore(item.severity) > severityScore(existing.severity)) {
      existing.severity = item.severity;
    }

    if (item.risk.length > existing.risk.length) {
      existing.risk = item.risk;
    }

    if (
      typeof item.severityReason === 'string' &&
      item.severityReason.length > String(existing.severityReason || '').length
    ) {
      existing.severityReason = item.severityReason;
    }

    if (item.pregnancy && typeof item.pregnancy.safe === 'boolean') {
      if (item.pregnancy.safe === false) {
        existing.pregnancy.safe = false;
      }

      if (
        typeof item.pregnancy.reason === 'string' &&
        item.pregnancy.reason.length > String(existing.pregnancy?.reason || '').length
      ) {
        existing.pregnancy.reason = item.pregnancy.reason;
      }
    }

    if (item.recommendation && typeof item.recommendation.safe === 'boolean') {
      if (item.recommendation.safe === false) {
        existing.recommendation.safe = false;
      }

      if (
        typeof item.recommendation.reason === 'string' &&
        item.recommendation.reason.length > String(existing.recommendation?.reason || '').length
      ) {
        existing.recommendation.reason = item.recommendation.reason;
      }
    }
  }

  return Array.from(merged.values());
}

function parseAIResponse(rawText, ingredientText = '') {
  const fallback = {
    riskyIngredients: [],
    safeIngredients: [],
    safeCount: 0,
    totalDetected: 0,
    summary: 'Could not reliably extract ingredients.',
    warning: 'AI response was ambiguous. Results may be incomplete.',
  };

  const jsonChunk = extractJsonChunk(rawText);
  if (!jsonChunk) {
    return fallback;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonChunk);
  } catch (error) {
    return fallback;
  }

  const detectedIngredients = extractDetectedIngredients(ingredientText);
  let rawIngredients = [];
  let aiTotalDetected = 0;

  if (Array.isArray(parsed)) {
    rawIngredients = parsed;
    aiTotalDetected = parsed.length;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.riskyIngredients)) {
      rawIngredients = parsed.riskyIngredients;
    }

    if (typeof parsed.totalDetected === 'number' && Number.isFinite(parsed.totalDetected)) {
      aiTotalDetected = Math.max(0, Math.floor(parsed.totalDetected));
    }
  }

  const normalizedRisky = rawIngredients.map(normalizeIngredient).filter(Boolean);
  const riskyIngredientsMerged = mergeRiskyIngredients(normalizedRisky);
  const detectedKeySet = buildDetectedKeySet(detectedIngredients);
  const riskyIngredientsInputMatched = riskyIngredientsMerged.filter((item) => {
    if (!isLikelyIngredient(item.name)) {
      return false;
    }

    if (detectedIngredients.length === 0) {
      return true;
    }

    return isIngredientMentionedInSource(item, detectedKeySet, ingredientText);
  });
  const detectedIndexMap = buildDetectedIngredientIndex(detectedIngredients);
  const riskyIngredients = riskyIngredientsInputMatched.map((item) => {
    const index = findIngredientIndex(item, detectedIndexMap);
    const computedRecommendation = computeRecommendation(item, index);
    const aiReason = String(item?.recommendation?.reason || '').trim();

    return {
      ...item,
      recommendation: {
        safe: computedRecommendation.safe,
        reason: normalizeRecommendationReason(
          aiReason,
          computedRecommendation.safe,
          computedRecommendation.reason
        ),
      },
    };
  });
  const riskyKeys = new Set();

  for (const risky of riskyIngredients) {
    riskyKeys.add(canonicalKey(risky.name));
    for (const alias of risky.aliases) {
      riskyKeys.add(canonicalKey(alias));
    }
  }

  const safeIngredients = detectedIngredients.filter((item) => !riskyKeys.has(canonicalKey(item)));

  let totalDetected = detectedIngredients.length;
  if (totalDetected === 0) {
    totalDetected = Math.max(aiTotalDetected, riskyIngredients.length);
  }
  if (totalDetected < riskyIngredients.length) {
    totalDetected = riskyIngredients.length;
  }

  const safeCount = detectedIngredients.length > 0
    ? safeIngredients.length
    : Math.max(0, totalDetected - riskyIngredients.length);
  const summary = `${riskyIngredients.length} of ${totalDetected} detected ingredients are flagged as risky.`;

  return {
    riskyIngredients,
    safeIngredients,
    safeCount,
    totalDetected,
    summary,
  };
}

module.exports = {
  parseAIResponse,
};
