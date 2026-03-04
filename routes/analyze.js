const express = require('express');
const {
  analyzeIngredients,
  refineDetectedIngredientsWithAI,
  HF_MODEL_ID,
} = require('../services/huggingface');
const { parseAIResponse } = require('../utils/parseAIResponse');
const { verifyParsedIngredientsOnline } = require('../utils/verifyIngredientOnline');
const { stabilizeWithIngredientMemory } = require('../utils/ingredientDecisionMemory');
const { isDatasetIngredient, getDatasetCanonicalKey } = require('../utils/ingredientDataset');
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

async function refreshCachedAnalysisInBackground(cacheKey, cachedData) {
  if (!cacheKey || !cachedData || cacheRecheckInFlight.has(cacheKey)) {
    return;
  }

  cacheRecheckInFlight.add(cacheKey);
  try {
    const refreshed = await stabilizeWithIngredientMemory(cachedData, {
      forceInternetRecheck: true,
    });
    if (Number(refreshed?.totalDetected || 0) > 0) {
      setCachedAnalysis(cacheKey, refreshed, { lastRecheckedAt: Date.now() });
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
        void refreshCachedAnalysisInBackground(cacheKey, cachedEntry.data);
      }
      return res.status(200).json({
        success: true,
        data: cachedEntry.data,
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
    learnRejectedCandidates(candidates, stabilized);
    if (Number(stabilized?.totalDetected || 0) > 0) {
      setCachedAnalysis(cacheKey, stabilized, { lastRecheckedAt: Date.now() });
    }

    return res.status(200).json({
      success: true,
      data: stabilized,
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
