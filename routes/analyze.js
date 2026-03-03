const express = require('express');
const { analyzeIngredients, HF_MODEL_ID } = require('../services/huggingface');
const { parseAIResponse } = require('../utils/parseAIResponse');

const router = express.Router();

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
    const rawResult = await analyzeIngredients(sanitizedText);
    const parsed = parseAIResponse(rawResult, sanitizedText);

    return res.status(200).json({
      success: true,
      data: parsed,
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
