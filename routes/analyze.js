const express = require('express');
const {
  analyzeIngredients,
  refineDetectedIngredientsWithAI,
  HF_MODEL_ID,
} = require('../services/huggingface');
const { parseAIResponse } = require('../utils/parseAIResponse');
const { verifyParsedIngredientsOnline } = require('../utils/verifyIngredientOnline');
const { stabilizeWithIngredientMemory } = require('../utils/ingredientDecisionMemory');

const router = express.Router();
const ANALYSIS_CACHE_TTL_MS = Number(process.env.ANALYSIS_CACHE_TTL_MS || 30 * 60 * 1000);
const MAX_ANALYSIS_CACHE_SIZE = 500;
const analysisCache = new Map();

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

  return cached.data;
}

function setCachedAnalysis(key, data) {
  if (analysisCache.size >= MAX_ANALYSIS_CACHE_SIZE) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey) {
      analysisCache.delete(oldestKey);
    }
  }

  analysisCache.set(key, { data, ts: Date.now() });
}

function normalizeIngredientKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyIngredientName(name) {
  const text = String(name || '').trim();
  if (!text) {
    return false;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return true;
  }

  if (/[a-z]/i.test(text) && /\d/.test(text)) {
    return true;
  }

  return /(acid|ate|ite|ide|ine|ene|one|ol|ose|ium|yl|oxy|glycol|extract|oil|wax|oxide|chloride|sulfate|phosphate|amide|amine|ester|cone)$/i.test(
    text
  );
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
    const key = normalizeIngredientKey(value);
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
    const key = normalizeIngredientKey(value);
    if (!value || !key || originalSeen.has(key)) {
      continue;
    }
    originalSeen.add(key);
    originalDetected.push(value);
  }
  for (const item of Array.isArray(parsedData.riskyIngredients) ? parsedData.riskyIngredients : []) {
    const value = String(item?.name || '').trim();
    const key = normalizeIngredientKey(value);
    if (!value || !key || originalSeen.has(key)) {
      continue;
    }
    originalSeen.add(key);
    originalDetected.push(value);
  }

  const mergedDetected = [];
  const mergedSeen = new Set();
  for (const value of originalDetected) {
    const key = normalizeIngredientKey(value);
    const keep = refinedKeySet.has(key) || isLikelyIngredientName(value);
    if (!keep || mergedSeen.has(key)) {
      continue;
    }
    mergedSeen.add(key);
    mergedDetected.push(value);
  }
  for (const value of refined) {
    const key = normalizeIngredientKey(value);
    if (!key || mergedSeen.has(key)) {
      continue;
    }
    mergedSeen.add(key);
    mergedDetected.push(value);
  }

  const detectedForOutput = mergedDetected.length > 0 ? mergedDetected : refined;
  const detectedKeySet = new Set(detectedForOutput.map((name) => normalizeIngredientKey(name)));

  const riskyInput = Array.isArray(parsedData.riskyIngredients) ? parsedData.riskyIngredients : [];
  const riskyIngredients = riskyInput.filter((item) => {
    const key = normalizeIngredientKey(item?.name);
    if (key && detectedKeySet.has(key)) {
      return true;
    }

    const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
    for (const alias of aliases) {
      if (detectedKeySet.has(normalizeIngredientKey(alias))) {
        return true;
      }
    }

    return false;
  });

  const riskyKeys = new Set();
  for (const risky of riskyIngredients) {
    riskyKeys.add(normalizeIngredientKey(risky?.name));
    const aliases = Array.isArray(risky?.aliases) ? risky.aliases : [];
    for (const alias of aliases) {
      riskyKeys.add(normalizeIngredientKey(alias));
    }
  }

  const safeIngredients = detectedForOutput.filter(
    (name) => !riskyKeys.has(normalizeIngredientKey(name))
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
    const cachedData = getCachedAnalysis(cacheKey);
    if (cachedData) {
      const refreshedCached = await stabilizeWithIngredientMemory(cachedData, {
        forceInternetRecheck: true,
      });
      if (Number(refreshedCached?.totalDetected || 0) > 0) {
        setCachedAnalysis(cacheKey, refreshedCached);
      }
      return res.status(200).json({
        success: true,
        data: refreshedCached,
        meta: {
          model: HF_MODEL_ID,
          analysisTimeMs: Date.now() - startedAt,
          cacheHit: true,
        },
      });
    }

    const rawResult = await analyzeIngredients(sanitizedText);
    const parsed = parseAIResponse(rawResult, sanitizedText);
    const candidates = [
      ...(Array.isArray(parsed?.safeIngredients) ? parsed.safeIngredients : []),
      ...((Array.isArray(parsed?.riskyIngredients) ? parsed.riskyIngredients : []).map(
        (item) => item?.name
      )),
      ...((Array.isArray(parsed?.riskyIngredients) ? parsed.riskyIngredients : []).flatMap((item) =>
        Array.isArray(item?.aliases) ? item.aliases : []
      )),
    ];
    const refinedDetected = await refineDetectedIngredientsWithAI(sanitizedText, candidates);
    const refinedParsed = refineParsedByAIDetected(parsed, refinedDetected);
    const verified = await verifyParsedIngredientsOnline(refinedParsed);
    const stabilized = await stabilizeWithIngredientMemory(verified, {
      forceInternetRecheck: true,
    });
    if (Number(stabilized?.totalDetected || 0) > 0) {
      setCachedAnalysis(cacheKey, stabilized);
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
