function clampSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function extractDetectedIngredients(ingredientText) {
  if (typeof ingredientText !== 'string') {
    return [];
  }

  const cleaned = ingredientText
    .replace(/ingredients?\s*:/gi, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return [];
  }

  const items = cleaned
    .split(/[,;\n|/]+/)
    .map((part) => part.trim())
    .map((part) => part.replace(/^[\-\d.\s]+/, '').trim())
    .map((part) => part.replace(/\s{2,}/g, ' '))
    .filter((part) => part.length >= 2);

  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique;
}

function sanitizeAliases(aliases) {
  if (!Array.isArray(aliases)) {
    return [];
  }

  return aliases
    .map((alias) => String(alias || '').trim())
    .filter(Boolean)
    .slice(0, 10);
}

function normalizeIngredient(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const name = String(item.name || '').trim();
  if (!name) {
    return null;
  }

  return {
    name,
    aliases: sanitizeAliases(item.aliases),
    risk: String(item.risk || 'No description available').trim() || 'No description available',
    severity: clampSeverity(item.severity),
  };
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

function parseAIResponse(rawText, ingredientText = '') {
  const fallback = {
    riskyIngredients: [],
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
  let totalDetected = 0;

  if (Array.isArray(parsed)) {
    rawIngredients = parsed;
    totalDetected = parsed.length;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.riskyIngredients)) {
      rawIngredients = parsed.riskyIngredients;
    }

    if (typeof parsed.totalDetected === 'number' && Number.isFinite(parsed.totalDetected)) {
      totalDetected = Math.max(0, Math.floor(parsed.totalDetected));
    }
  }

  const riskyIngredients = rawIngredients.map(normalizeIngredient).filter(Boolean);

  if (totalDetected === 0) {
    totalDetected = detectedIngredients.length || riskyIngredients.length;
  }

  if (detectedIngredients.length > totalDetected) {
    totalDetected = detectedIngredients.length;
  }

  if (totalDetected < riskyIngredients.length) {
    totalDetected = riskyIngredients.length;
  }

  const safeCount = Math.max(0, totalDetected - riskyIngredients.length);
  const summary = `${riskyIngredients.length} of ${totalDetected} detected ingredients are flagged as risky.`;

  return {
    riskyIngredients,
    safeCount,
    totalDetected,
    summary,
  };
}

module.exports = {
  parseAIResponse,
};
