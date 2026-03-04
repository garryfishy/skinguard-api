const express = require('express');
const {
  analyzeIngredients,
  refineDetectedIngredientsWithAI,
  scoreRiskyIngredientsForSkincare,
  HF_MODEL_ID,
} = require('../services/huggingface');
const { parseAIResponse } = require('../utils/parseAIResponse');
const { verifyParsedIngredientsOnline } = require('../utils/verifyIngredientOnline');
const { stabilizeWithIngredientMemory } = require('../utils/ingredientDecisionMemory');
const {
  INGREDIENT_CLASSIFICATIONS,
  isDatasetIngredient,
  getDatasetCanonicalKey,
  classifyIngredientName,
} = require('../utils/ingredientDataset');
const { isKnownNonIngredient, recordNonIngredient } = require('../utils/nonIngredientMemory');

const router = express.Router();
const ANALYSIS_CACHE_TTL_MS = Number(process.env.ANALYSIS_CACHE_TTL_MS || 30 * 60 * 1000);
const ANALYSIS_CACHE_RECHECK_INTERVAL_MS = Number(
  process.env.ANALYSIS_CACHE_RECHECK_INTERVAL_MS || 10 * 60 * 1000
);
const MAX_ANALYSIS_CACHE_SIZE = 500;
const analysisCache = new Map();
const cacheRecheckInFlight = new Set();

function normalizeCacheKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getCachedAnalysis(key) {
  const cached = analysisCache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.ts > ANALYSIS_CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }

  return cached;
}

function setCachedAnalysis(key, data, options = {}) {
  if (analysisCache.size >= MAX_ANALYSIS_CACHE_SIZE) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey) {
      analysisCache.delete(oldestKey);
    }
  }

  const now = Date.now();
  const lastRecheckedAt =
    typeof options.lastRecheckedAt === 'number' && Number.isFinite(options.lastRecheckedAt)
      ? options.lastRecheckedAt
      : now;
  analysisCache.set(key, { data, ts: now, lastRecheckedAt });
}

function shouldScheduleCacheRecheck(cachedEntry) {
  if (!cachedEntry) {
    return false;
  }

  if (!Number.isFinite(ANALYSIS_CACHE_RECHECK_INTERVAL_MS) || ANALYSIS_CACHE_RECHECK_INTERVAL_MS <= 0) {
    return false;
  }

  const lastRecheckedAt = Number(cachedEntry.lastRecheckedAt || cachedEntry.ts || 0);
  if (!Number.isFinite(lastRecheckedAt) || lastRecheckedAt <= 0) {
    return true;
  }

  return Date.now() - lastRecheckedAt >= ANALYSIS_CACHE_RECHECK_INTERVAL_MS;
}

async function refreshCachedAnalysisInBackground(cacheKey, cachedData, ingredientText = '') {
  if (!cacheKey || !cachedData || cacheRecheckInFlight.has(cacheKey)) {
    return;
  }

  cacheRecheckInFlight.add(cacheKey);
  try {
    const refreshed = await stabilizeWithIngredientMemory(cachedData, {
      forceInternetRecheck: true,
    });
    if (Number(refreshed?.totalDetected || 0) > 0) {
      const classified = attachIngredientClassifications(refreshed);
      const withNarrative = attachNarrativeSummaries(classified);
      const withSkincareAssessment = await applySkincareContextAIGating(
        withNarrative,
        ingredientText
      );
      const preparedRefreshed = sanitizeUserFacingData(withSkincareAssessment);
      setCachedAnalysis(cacheKey, preparedRefreshed, { lastRecheckedAt: Date.now() });
      return;
    }
  } catch (error) {
    // keep serving cached data when background refresh fails
  } finally {
    const existing = analysisCache.get(cacheKey);
    if (existing) {
      analysisCache.set(cacheKey, {
        ...existing,
        lastRecheckedAt: Date.now(),
      });
    }
    cacheRecheckInFlight.delete(cacheKey);
  }
}

function normalizeIngredientKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeClassificationValue(value, fallback = INGREDIENT_CLASSIFICATIONS.SAFE) {
  const normalized = String(value || '').trim().toUpperCase();
  if (
    normalized === INGREDIENT_CLASSIFICATIONS.SAFE ||
    normalized === INGREDIENT_CLASSIFICATIONS.BOTANICAL ||
    normalized === INGREDIENT_CLASSIFICATIONS.FAMILY_INGREDIENT ||
    normalized === INGREDIENT_CLASSIFICATIONS.FUZZY_MATCH ||
    normalized === INGREDIENT_CLASSIFICATIONS.DANGEROUS
  ) {
    return normalized;
  }

  return fallback;
}

function sanitizeUserFacingText(value) {
  return String(value || '')
    .replace(/verifikasi online/gi, 'pengecekan tambahan')
    .replace(/verifikasi internet/gi, 'pengecekan tambahan')
    .replace(/referensi online/gi, 'referensi tambahan')
    .replace(/referensi internet/gi, 'referensi tambahan');
}

function sanitizeUserFacingData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const safeIngredients = Array.isArray(data.safeIngredients) ? data.safeIngredients : [];
  const riskyIngredients = Array.isArray(data.riskyIngredients) ? data.riskyIngredients : [];
  const ingredientClassifications = Array.isArray(data.ingredientClassifications)
    ? data.ingredientClassifications
    : [];

  return {
    ...data,
    warning: data.warning ? sanitizeUserFacingText(data.warning) : data.warning,
    summary: data.summary ? sanitizeUserFacingText(data.summary) : data.summary,
    riskNarrative: sanitizeUserFacingText(data.riskNarrative || ''),
    overallRecommendation: data?.overallRecommendation
      ? {
          safe: Boolean(data.overallRecommendation.safe),
          reason: sanitizeUserFacingText(data.overallRecommendation.reason || ''),
        }
      : data?.overallRecommendation,
    skincareContextAssessment: data?.skincareContextAssessment
      ? {
          ...data.skincareContextAssessment,
          reason: sanitizeUserFacingText(data.skincareContextAssessment.reason || ''),
          items: Array.isArray(data.skincareContextAssessment.items)
            ? data.skincareContextAssessment.items.map((item) => ({
                ...item,
                ingredient: String(item?.ingredient || '').trim(),
                reason: sanitizeUserFacingText(item?.reason || ''),
                score: Number(item?.score || 0),
                confidence: Number(item?.confidence || 0),
              }))
            : [],
        }
      : data?.skincareContextAssessment,
    pregnancy: data?.pregnancy
      ? {
          safe: Boolean(data.pregnancy.safe),
          reason: sanitizeUserFacingText(data.pregnancy.reason || ''),
          affectedIngredients: Array.isArray(data.pregnancy.affectedIngredients)
            ? data.pregnancy.affectedIngredients.map((name) => String(name || '').trim()).filter(Boolean)
            : [],
        }
      : data?.pregnancy,
    riskyIngredients: riskyIngredients.map((item) => ({
      ...item,
      risk: sanitizeUserFacingText(item?.risk || ''),
      severityReason: sanitizeUserFacingText(item?.severityReason || ''),
      skincareRiskScore: Number(item?.skincareRiskScore || 0),
      skincareRiskReason: sanitizeUserFacingText(item?.skincareRiskReason || ''),
      skincareRiskConfidence: Number(item?.skincareRiskConfidence || 0),
      pregnancy: item?.pregnancy
        ? {
            ...item.pregnancy,
            reason: sanitizeUserFacingText(item.pregnancy.reason || ''),
          }
        : item?.pregnancy,
      recommendation: item?.recommendation
        ? {
            ...item.recommendation,
            reason: sanitizeUserFacingText(item.recommendation.reason || ''),
          }
        : item?.recommendation,
    })),
    safeIngredients,
    ingredientClassifications: ingredientClassifications.map((item) => ({
      ...item,
      name: String(item?.name || '').trim(),
      classification: normalizeClassificationValue(item?.classification),
      source: sanitizeUserFacingText(item?.source || ''),
      matchType: String(item?.matchType || ''),
      matchedName: String(item?.matchedName || '').trim(),
      confidence: Number(item?.confidence || 0),
      family: String(item?.family || ''),
    })),
  };
}

function joinNaturalLanguage(items = []) {
  const values = Array.isArray(items)
    ? items.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (values.length === 0) {
    return '';
  }
  if (values.length === 1) {
    return values[0];
  }
  if (values.length === 2) {
    return `${values[0]} dan ${values[1]}`;
  }
  const head = values.slice(0, -1).join(', ');
  return `${head}, dan ${values[values.length - 1]}`;
}

const PREGNANCY_EFFECT_RULES = [
  {
    pattern: /\b(mercury|merkuri|raksa)\b/i,
    effect:
      'Paparan merkuri dapat bersifat neurotoksik dan berisiko mengganggu perkembangan janin.',
  },
  {
    pattern: /\b(lead|timbal|pb)\b/i,
    effect:
      'Paparan timbal dapat berdampak pada sistem saraf dan berisiko pada pertumbuhan serta perkembangan janin.',
  },
  {
    pattern: /\b(arsenic|arsen)\b/i,
    effect:
      'Paparan arsenik berkaitan dengan toksisitas sistemik yang tidak dianjurkan selama kehamilan.',
  },
  {
    pattern: /\b(cadmium|kadmium|thallium|talium)\b/i,
    effect:
      'Logam berat seperti kadmium atau talium berisiko menambah beban toksik pada ibu dan janin.',
  },
  {
    pattern: /\b(hydroquinone|hidrokuinon)\b/i,
    effect:
      'Hydroquinone memiliki potensi penyerapan sistemik relatif tinggi sehingga sebaiknya dihindari saat hamil.',
  },
  {
    pattern: /\b(retinoic acid|asam retinoat|tretinoin)\b/i,
    effect:
      'Turunan retinoid tidak disarankan pada kehamilan karena berpotensi meningkatkan risiko gangguan perkembangan janin.',
  },
  {
    pattern: /\b(clobetasol|betamethasone|betametason)\b/i,
    effect:
      'Kortikosteroid poten berisiko menimbulkan efek sistemik bila digunakan luas atau jangka panjang selama kehamilan.',
  },
];

function resolvePregnancyEffectByName(name) {
  const key = normalizeIngredientKey(name);
  if (!key) {
    return '';
  }

  for (const rule of PREGNANCY_EFFECT_RULES) {
    if (rule.pattern.test(key)) {
      return rule.effect;
    }
  }

  return '';
}

function buildRiskNarrative(data) {
  const riskyIngredients = Array.isArray(data?.riskyIngredients) ? data.riskyIngredients : [];
  if (riskyIngredients.length === 0) {
    return 'Berdasarkan bahan yang terdeteksi, tidak ada indikasi utama bahan berisiko tinggi pada komposisi produk ini.';
  }

  const names = riskyIngredients
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const nameText = joinNaturalLanguage(names);

  const reasons = riskyIngredients
    .map((item) => String(item?.risk || item?.severityReason || '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((text) => text.replace(/[.]+$/g, ''));

  const reasonText =
    reasons.length > 0
      ? reasons.join('. ')
      : 'bahan-bahan tersebut memiliki profil risiko yang perlu diwaspadai';

  const hasHighDanger = riskyIngredients.some(
    (item) =>
      String(item?.classification || '').toUpperCase() === INGREDIENT_CLASSIFICATIONS.DANGEROUS ||
      String(item?.severity || '').toLowerCase() === 'high'
  );
  const closing = hasHighDanger
    ? 'Karena itu, produk ini termasuk kurang direkomendasikan tanpa pertimbangan medis.'
    : 'Produk masih bisa dipertimbangkan dengan pemakaian hati-hati dan uji cocok terlebih dahulu.';

  return `Adanya bahan ${nameText} membuat produk ini perlu diwaspadai karena ${reasonText}. ${closing}`;
}

function buildPregnancySummary(data) {
  const riskyIngredients = Array.isArray(data?.riskyIngredients) ? data.riskyIngredients : [];
  const pregnancyRiskItems = riskyIngredients.filter((item) => {
    if (item?.pregnancy && item.pregnancy.safe === false) {
      return true;
    }

    const classification = String(item?.classification || '').toUpperCase();
    if (classification === INGREDIENT_CLASSIFICATIONS.DANGEROUS) {
      return true;
    }

    return String(item?.severity || '').toLowerCase() === 'high';
  });

  if (pregnancyRiskItems.length === 0) {
    return {
      safe: true,
      reason:
        'Berdasarkan komposisi yang terdeteksi, tidak ditemukan sinyal utama bahan berisiko tinggi untuk kehamilan. Tetap gunakan sesuai aturan dan hentikan pemakaian bila muncul iritasi.',
      affectedIngredients: [],
    };
  }

  const affectedIngredients = pregnancyRiskItems
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const affectedText = joinNaturalLanguage(affectedIngredients);

  const effects = pregnancyRiskItems
    .map((item) => resolvePregnancyEffectByName(item?.name))
    .filter(Boolean);
  const uniqueEffects = Array.from(new Set(effects)).slice(0, 2);

  const fallbackEffect =
    'Bahan-bahan tersebut dapat meningkatkan risiko iritasi berat, paparan toksik sistemik, atau efek yang tidak diinginkan pada ibu hamil.';
  const effectParagraph = uniqueEffects.length > 0 ? uniqueEffects.join(' ') : fallbackEffect;

  return {
    safe: false,
    reason: `Produk ini tidak disarankan untuk ibu hamil karena mengandung ${affectedText}. ${effectParagraph} Sebaiknya pilih alternatif yang lebih aman dan konsultasikan ke tenaga medis sebelum pemakaian.`,
    affectedIngredients,
  };
}

function attachNarrativeSummaries(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  return {
    ...data,
    riskNarrative: buildRiskNarrative(data),
    pregnancy: buildPregnancySummary(data),
  };
}

function buildSkincareAssessmentReason({
  isSafe,
  averageScore,
  maxScore,
  maxIngredientName,
  strictDangerNames,
  avgThreshold,
  highThreshold,
}) {
  const roundedAvg = Number(averageScore.toFixed(2));
  const roundedMax = Number(maxScore.toFixed(2));

  if (Array.isArray(strictDangerNames) && strictDangerNames.length > 0) {
    const strictNames = joinNaturalLanguage(strictDangerNames.slice(0, 3));
    return `Produk tidak disarankan karena terdapat bahan berisiko tinggi (${strictNames}) yang secara umum masuk kategori berbahaya dalam konteks skincare.`;
  }

  if (!isSafe && roundedMax >= highThreshold) {
    return `Produk tidak disarankan karena ada bahan dengan skor risiko tinggi (${roundedMax}/10) pada konteks skincare, khususnya ${maxIngredientName}.`;
  }

  if (!isSafe && roundedAvg >= avgThreshold) {
    return `Produk tidak disarankan karena rata-rata skor risiko bahan bermasalah mencapai ${roundedAvg}/10 dalam konteks skincare.`;
  }

  return `Walaupun ada bahan yang perlu diperhatikan, rata-rata skor risiko dalam konteks skincare adalah ${roundedAvg}/10 (maksimum ${roundedMax}/10), sehingga produk masih tergolong aman dipakai sesuai aturan pakai.`;
}

async function applySkincareContextAIGating(data, ingredientText = '') {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const riskyIngredients = Array.isArray(data.riskyIngredients) ? data.riskyIngredients : [];
  if (riskyIngredients.length === 0) {
    return {
      ...data,
      skincareContextAssessment: {
        enabled: true,
        scoredCount: 0,
        averageScore: 0,
        maxScore: 0,
        thresholdAverage: 6,
        thresholdHighItem: 8,
        isSafe: true,
        reason:
          'Tidak ada bahan berisiko yang perlu dinilai ulang, sehingga produk dinilai aman pada konteks skincare.',
        items: [],
        checkedAt: new Date().toISOString(),
      },
      overallRecommendation: {
        safe: true,
        reason:
          'Tidak ada bahan berisiko tinggi yang terdeteksi, sehingga produk dinilai aman dipakai sesuai aturan pakai.',
      },
    };
  }

  const hasReusableAssessment =
    data?.skincareContextAssessment &&
    Array.isArray(data.skincareContextAssessment.items) &&
    Number(data.skincareContextAssessment.items.length || 0) >= riskyIngredients.length;
  if (hasReusableAssessment) {
    return data;
  }

  let scoredItems = [];
  try {
    scoredItems = await scoreRiskyIngredientsForSkincare(riskyIngredients, { ingredientText });
  } catch (error) {
    scoredItems = [];
  }

  if (!Array.isArray(scoredItems) || scoredItems.length === 0) {
    return data;
  }

  const scoreByKey = new Map();
  for (const item of scoredItems) {
    const key = normalizeRefinementKey(item?.ingredient || item?.name);
    if (!key) {
      continue;
    }
    scoreByKey.set(key, item);
  }

  const riskyWithScores = riskyIngredients.map((item) => {
    const key = normalizeRefinementKey(item?.name);
    const scored = scoreByKey.get(key);
    if (!scored) {
      return item;
    }

    return {
      ...item,
      skincareRiskScore: Number(scored.score || 0),
      skincareRiskReason: String(scored.reason || '').trim(),
      skincareRiskConfidence: Number(scored.confidence || 0),
    };
  });

  const validScores = scoredItems
    .map((item) => Number(item?.score))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (validScores.length === 0) {
    return {
      ...data,
      riskyIngredients: riskyWithScores,
    };
  }

  const avgThreshold = Number(process.env.SKINCARE_AI_SCORE_AVG_THRESHOLD || 6);
  const highThreshold = Number(process.env.SKINCARE_AI_SCORE_HIGH_THRESHOLD || 8);
  const sum = validScores.reduce((acc, value) => acc + value, 0);
  const averageScore = sum / validScores.length;

  let maxScore = 0;
  let maxIngredientName = '';
  for (const item of scoredItems) {
    const score = Number(item?.score || 0);
    if (score > maxScore) {
      maxScore = score;
      maxIngredientName = String(item?.ingredient || '').trim();
    }
  }

  const strictDangerNames = riskyWithScores
    .filter(
      (item) =>
        String(item?.classification || '').toUpperCase() === INGREDIENT_CLASSIFICATIONS.DANGEROUS
    )
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);

  const hasHighItem = maxScore >= highThreshold;
  const hasHighAverage = averageScore >= avgThreshold;
  const hasStrictDanger = strictDangerNames.length > 0;
  const isSafe = !hasStrictDanger && !hasHighItem && !hasHighAverage;
  const reason = buildSkincareAssessmentReason({
    isSafe,
    averageScore,
    maxScore,
    maxIngredientName,
    strictDangerNames,
    avgThreshold,
    highThreshold,
  });

  const existingNarrative = String(data.riskNarrative || '').trim();
  const narrativePrefix = reason.replace(/[.]+$/g, '');
  const riskNarrative = existingNarrative
    ? `${narrativePrefix}. ${existingNarrative}`.trim()
    : reason;

  return {
    ...data,
    riskyIngredients: riskyWithScores,
    riskNarrative,
    skincareContextAssessment: {
      enabled: true,
      scoredCount: validScores.length,
      averageScore: Number(averageScore.toFixed(2)),
      maxScore: Number(maxScore.toFixed(2)),
      thresholdAverage: avgThreshold,
      thresholdHighItem: highThreshold,
      isSafe,
      reason,
      items: scoredItems.map((item) => ({
        ingredient: String(item?.ingredient || '').trim(),
        score: Number(item?.score || 0),
        reason: String(item?.reason || '').trim(),
        confidence: Number(item?.confidence || 0),
      })),
      checkedAt: new Date().toISOString(),
    },
    overallRecommendation: {
      safe: isSafe,
      reason,
    },
  };
}

function attachIngredientClassifications(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const riskyIngredientsInput = Array.isArray(data.riskyIngredients) ? data.riskyIngredients : [];
  const safeIngredients = Array.isArray(data.safeIngredients) ? data.safeIngredients : [];
  const classificationMap = new Map();
  const classificationOrder = [];

  function addClassification(name, classified, fallbackClassification) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      return;
    }

    const key = normalizeRefinementKey(normalizedName) || normalizeIngredientKey(normalizedName);
    if (!key) {
      return;
    }

    const next = {
      name: normalizedName,
      classification: normalizeClassificationValue(
        classified?.classification,
        fallbackClassification
      ),
      source: String(classified?.source || 'rule'),
      matchType: String(classified?.matchType || ''),
      confidence: Number(classified?.confidence || 0),
      matchedName: String(classified?.matchedName || classified?.canonicalName || normalizedName),
      family: String(classified?.family || ''),
    };

    const current = classificationMap.get(key);
    if (!current) {
      classificationMap.set(key, next);
      classificationOrder.push(key);
      return;
    }

    if (
      next.classification === INGREDIENT_CLASSIFICATIONS.DANGEROUS ||
      next.confidence > current.confidence
    ) {
      classificationMap.set(key, next);
    }
  }

  const riskyIngredients = riskyIngredientsInput.map((item) => {
    const name = String(item?.name || '').trim();
    const classified = classifyIngredientName(name);
    const shouldUseCanonical =
      classified?.matchType === 'exact' || classified?.matchType === 'fuzzy';
    const classification = normalizeClassificationValue(
      item?.classification || classified?.classification,
      INGREDIENT_CLASSIFICATIONS.DANGEROUS
    );
    const normalizedItem = {
      ...item,
      name: String(
        shouldUseCanonical ? classified?.canonicalName || name : name || item?.name || ''
      ).trim(),
      classification,
    };
    addClassification(normalizedItem.name, classified, INGREDIENT_CLASSIFICATIONS.DANGEROUS);
    return normalizedItem;
  });

  for (const safeNameRaw of safeIngredients) {
    const safeName = String(safeNameRaw || '').trim();
    if (!safeName) {
      continue;
    }
    const classified = classifyIngredientName(safeName);
    addClassification(safeName, classified, INGREDIENT_CLASSIFICATIONS.SAFE);
  }

  const ingredientClassifications = classificationOrder
    .map((key) => classificationMap.get(key))
    .filter(Boolean);

  return {
    ...data,
    riskyIngredients,
    ingredientClassifications,
  };
}

function normalizeCandidateText(value) {
  return String(value || '')
    .replace(/[•·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDatasetLookupVariants(value) {
  const raw = normalizeCandidateText(value);
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

function normalizeRefinementKey(value) {
  for (const variant of buildDatasetLookupVariants(value)) {
    const datasetCanonical = getDatasetCanonicalKey(variant);
    if (datasetCanonical) {
      return normalizeIngredientKey(datasetCanonical);
    }
  }
  return normalizeIngredientKey(normalizeCandidateText(value));
}

function isPotentialRefinementCandidate(value) {
  const text = normalizeCandidateText(value);
  if (!text || text.length < 2 || text.length > 90) {
    return false;
  }

  if (isKnownNonIngredient(text)) {
    return false;
  }

  if (!/[a-z]/i.test(text)) {
    return false;
  }

  if (/^[0-9.\-+%\s]+$/.test(text)) {
    return false;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 10) {
    return false;
  }

  return true;
}

function extractRawCandidatesFromText(ingredientText) {
  const source = String(ingredientText || '')
    .replace(/\r/g, '\n')
    .replace(/[•·]/g, ',')
    .replace(/\t/g, ' ')
    .trim();

  if (!source) {
    return [];
  }

  const chunks = source.split(/[\n,;|/]+/);
  const unique = [];
  const seen = new Set();

  for (const chunk of chunks) {
    const value = normalizeCandidateText(
      String(chunk || '')
      .replace(/^[-*•\d.()\s]+/, '')
      .trim()
    );

    if (!isPotentialRefinementCandidate(value)) {
      continue;
    }

    const key = normalizeRefinementKey(value);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
    if (unique.length >= 150) {
      break;
    }
  }

  return unique;
}

function collectRefinementCandidates(parsedData, ingredientText) {
  const aiParsedCandidates = [
    ...(Array.isArray(parsedData?.safeIngredients) ? parsedData.safeIngredients : []),
    ...((Array.isArray(parsedData?.riskyIngredients) ? parsedData.riskyIngredients : []).map(
      (item) => item?.name
    )),
    ...((Array.isArray(parsedData?.riskyIngredients) ? parsedData.riskyIngredients : []).flatMap((item) =>
      Array.isArray(item?.aliases) ? item.aliases : []
    )),
  ];
  const rawTextCandidates = extractRawCandidatesFromText(ingredientText);
  const merged = [...aiParsedCandidates, ...rawTextCandidates];
  const unique = [];
  const seen = new Set();

  for (const candidate of merged) {
    const value = normalizeCandidateText(candidate);
    if (!isPotentialRefinementCandidate(value)) {
      continue;
    }

    const key = normalizeRefinementKey(value);
    if (!value || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
    if (unique.length >= 120) {
      break;
    }
  }

  return unique;
}

function buildFinalDetectedKeySet(result) {
  const keys = new Set();
  const safe = Array.isArray(result?.safeIngredients) ? result.safeIngredients : [];
  const risky = Array.isArray(result?.riskyIngredients) ? result.riskyIngredients : [];

  for (const name of safe) {
    const key = normalizeRefinementKey(name);
    if (key) {
      keys.add(key);
    }
  }

  for (const item of risky) {
    const nameKey = normalizeRefinementKey(item?.name);
    if (nameKey) {
      keys.add(nameKey);
    }

    const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
    for (const alias of aliases) {
      const aliasKey = normalizeRefinementKey(alias);
      if (aliasKey) {
        keys.add(aliasKey);
      }
    }
  }

  return keys;
}

function learnRejectedCandidates(candidates, finalResult) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return;
  }

  const acceptedKeySet = buildFinalDetectedKeySet(finalResult);
  for (const candidate of candidates) {
    const value = normalizeCandidateText(candidate);
    if (!value) {
      continue;
    }

    const key = normalizeRefinementKey(value);
    if (!key || acceptedKeySet.has(key)) {
      continue;
    }

    if (isDatasetIngredient(value)) {
      continue;
    }

    recordNonIngredient(value, 'pipeline_rejected_candidate');
  }
}

function refineParsedByAIDetected(parsedData, refinedDetected) {
  if (!parsedData || typeof parsedData !== 'object') {
    return parsedData;
  }

  if (!Array.isArray(refinedDetected) || refinedDetected.length === 0) {
    return parsedData;
  }

  const refined = [];
  const refinedKeySet = new Set();
  for (const item of refinedDetected) {
    const value = String(item || '').trim();
    const key = normalizeRefinementKey(value);
    if (!value || !key || refinedKeySet.has(key)) {
      continue;
    }

    refined.push(value);
    refinedKeySet.add(key);
  }

  if (refined.length === 0) {
    return parsedData;
  }

  const originalDetected = [];
  const originalSeen = new Set();
  for (const item of Array.isArray(parsedData.safeIngredients) ? parsedData.safeIngredients : []) {
    const value = String(item || '').trim();
    const key = normalizeRefinementKey(value);
    if (!value || !key || originalSeen.has(key)) {
      continue;
    }
    originalSeen.add(key);
    originalDetected.push(value);
  }
  for (const item of Array.isArray(parsedData.riskyIngredients) ? parsedData.riskyIngredients : []) {
    const value = String(item?.name || '').trim();
    const key = normalizeRefinementKey(value);
    if (!value || !key || originalSeen.has(key)) {
      continue;
    }
    originalSeen.add(key);
    originalDetected.push(value);
  }

  const mergedDetected = [];
  const mergedSeen = new Set();
  for (const value of originalDetected) {
    const key = normalizeRefinementKey(value);
    const keep = refinedKeySet.has(key) || (isDatasetIngredient(value) && !isKnownNonIngredient(value));
    if (!keep || mergedSeen.has(key)) {
      continue;
    }
    mergedSeen.add(key);
    mergedDetected.push(value);
  }
  for (const value of refined) {
    const key = normalizeRefinementKey(value);
    if (!key || mergedSeen.has(key)) {
      continue;
    }
    mergedSeen.add(key);
    mergedDetected.push(value);
  }

  const detectedForOutput = mergedDetected.length > 0 ? mergedDetected : refined;
  const detectedKeySet = new Set(detectedForOutput.map((name) => normalizeRefinementKey(name)));

  const riskyInput = Array.isArray(parsedData.riskyIngredients) ? parsedData.riskyIngredients : [];
  const riskyIngredients = riskyInput.filter((item) => {
    const key = normalizeRefinementKey(item?.name);
    if (key && detectedKeySet.has(key)) {
      return true;
    }

    const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
    for (const alias of aliases) {
      if (detectedKeySet.has(normalizeRefinementKey(alias))) {
        return true;
      }
    }

    return false;
  });

  const riskyKeys = new Set();
  for (const risky of riskyIngredients) {
    riskyKeys.add(normalizeRefinementKey(risky?.name));
    const aliases = Array.isArray(risky?.aliases) ? risky.aliases : [];
    for (const alias of aliases) {
      riskyKeys.add(normalizeRefinementKey(alias));
    }
  }

  const safeIngredients = detectedForOutput.filter(
    (name) => !riskyKeys.has(normalizeRefinementKey(name))
  );
  const totalDetected = riskyIngredients.length + safeIngredients.length;
  const safeCount = safeIngredients.length;
  const summary = `${riskyIngredients.length} of ${totalDetected} detected ingredients are flagged as risky.`;

  const warning = parsedData.warning
    ? String(parsedData.warning)
    : '';
  const refinedWarning = 'Ingredient list was refined by AI token validation.';

  return {
    ...parsedData,
    riskyIngredients,
    safeIngredients,
    safeCount,
    totalDetected,
    summary,
    aiDetectedValidated: true,
    warning: warning.includes(refinedWarning) ? warning : `${warning} ${refinedWarning}`.trim(),
  };
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
    },
  });
}

router.post('/', async (req, res) => {
  try {
    if (!req.is('application/json')) {
      return errorResponse(
        res,
        400,
        'VALIDATION_ERROR',
        'Content-Type must be application/json.'
      );
    }

    const { ingredientText } = req.body || {};

    if (typeof ingredientText !== 'string' || ingredientText.trim() === '') {
      return errorResponse(
        res,
        400,
        'VALIDATION_ERROR',
        'ingredientText is required and must be a non-empty string.'
      );
    }

    if (ingredientText.length > 3000) {
      return errorResponse(
        res,
        400,
        'VALIDATION_ERROR',
        'ingredientText must be 3000 characters or fewer.'
      );
    }

    const sanitizedText = ingredientText.replace(/<[^>]*>/g, '').trim();
    if (!sanitizedText) {
      return errorResponse(
        res,
        400,
        'VALIDATION_ERROR',
        'ingredientText is empty after sanitization.'
      );
    }

    const startedAt = Date.now();
    const cacheKey = normalizeCacheKey(sanitizedText);
    const cachedEntry = getCachedAnalysis(cacheKey);
    if (cachedEntry && cachedEntry.data) {
      const shouldRecheck = shouldScheduleCacheRecheck(cachedEntry);
      if (shouldRecheck) {
        void refreshCachedAnalysisInBackground(cacheKey, cachedEntry.data, sanitizedText);
      }
      const cachedResponseData = sanitizeUserFacingData(cachedEntry.data);
      return res.status(200).json({
        success: true,
        data: cachedResponseData,
        meta: {
          model: HF_MODEL_ID,
          analysisTimeMs: Date.now() - startedAt,
          cacheHit: true,
          cacheRecheckScheduled: shouldRecheck,
        },
      });
    }

    const rawResult = await analyzeIngredients(sanitizedText);
    const parsed = parseAIResponse(rawResult, sanitizedText);
    const candidates = collectRefinementCandidates(parsed, sanitizedText);
    const refinedDetected = candidates.length > 0
      ? await refineDetectedIngredientsWithAI(sanitizedText, candidates)
      : [];
    const refinedParsed = refineParsedByAIDetected(parsed, refinedDetected);
    const verified = await verifyParsedIngredientsOnline(refinedParsed);
    const stabilized = await stabilizeWithIngredientMemory(verified, {
      forceInternetRecheck: true,
    });
    const classified = attachIngredientClassifications(stabilized);
    const withNarrative = attachNarrativeSummaries(classified);
    const withSkincareAssessment = await applySkincareContextAIGating(withNarrative, sanitizedText);
    const finalizedData = sanitizeUserFacingData(withSkincareAssessment);
    learnRejectedCandidates(candidates, stabilized);
    if (Number(finalizedData?.totalDetected || 0) > 0) {
      setCachedAnalysis(cacheKey, finalizedData, { lastRecheckedAt: Date.now() });
    }

    return res.status(200).json({
      success: true,
      data: finalizedData,
      meta: {
        model: HF_MODEL_ID,
        analysisTimeMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    if (error?.code === 'AI_TIMEOUT') {
      return errorResponse(res, 504, 'AI_TIMEOUT', 'Analysis request timed out. Please try again.');
    }

    if (error?.code === 'AI_UNAVAILABLE') {
      return errorResponse(res, 502, 'AI_UNAVAILABLE', 'AI service is currently unavailable.');
    }

    if (error?.code === 'INTERNAL_ERROR') {
      return errorResponse(res, 500, 'INTERNAL_ERROR', error.message || 'Internal server error.');
    }

    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Internal server error.');
  }
});

module.exports = router;
