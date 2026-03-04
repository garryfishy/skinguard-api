const HF_API_TOKEN = process.env.HF_API_TOKEN;
const HF_MODEL_ID = process.env.HF_MODEL_ID || "Qwen/Qwen2.5-7B-Instruct";
const HF_CHAT_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
const SKINCARE_RISK_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const skincareRiskCache = new Map();

function buildPrompt(ingredientText) {
  return [
    "You are a cosmetic safety analyzer.",
    "Use Bahasa Indonesia for all descriptive text fields.",
    "Given product label ingredient text, first extract valid ingredients, then identify potentially risky/dangerous ingredients.",
    "Return ONLY valid JSON with this exact structure:",
    '{"detectedIngredients":["string"],"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low","severityReason":"string","pregnancy":{"safe":true|false,"reason":"string"},"recommendation":{"safe":true|false,"reason":"string"}}],"totalDetected":number}',
    "Rules:",
    "- detectedIngredients must contain ONLY real ingredient names explicitly present in input text.",
    "- detectedIngredients must NOT include random words, labels, marketing text, product claims, or non-ingredient tokens.",
    "- If a token is unclear or not confidently a real ingredient, EXCLUDE it.",
    "- If one ingredient appears in multiple languages/spellings, keep only one representative name.",
    "- Language priority for representative name: Bahasa Indonesia first, then English.",
    "- riskyIngredients must be subset of detectedIngredients.",
    "- riskyIngredients can be empty array.",
    "- totalDetected must equal detectedIngredients.length.",
    "- Only return ingredients that are explicitly present in the provided ingredient text.",
    "- Never include company name, brand name, address, BPOM number, batch code, or legal/marketing text as ingredients.",
    "- If uncertain whether a token is an ingredient, exclude it from detectedIngredients and riskyIngredients.",
    "- risk must be a detailed but concise explanation (1-3 sentences) of why the ingredient is harmful, in Bahasa Indonesia.",
    "- severityReason must explain why severity is high/medium/low based on toxicity, regulation, and exposure risk, in Bahasa Indonesia.",
    "- pregnancy.safe must be boolean and pregnancy.reason must explain if this ingredient is safe for pregnant users, in Bahasa Indonesia.",
    "- recommendation.safe must be boolean and recommendation.reason must explain whether the product is advisable to buy considering this ingredient, in Bahasa Indonesia.",
    "- recommendation.safe should be false only when the ingredient is clearly dangerous/commonly prohibited OR high-risk at likely high concentration.",
    "- For conditional ingredients (for example preservatives, fragrance, alcohol), recommendation.safe can be true with caution when risk depends on concentration/usage.",
    "- Do not include markdown or explanations.",
    "",
    `Ingredient text: ${ingredientText}`,
  ].join("\n");
}

function normalizeTokenKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCachedSkincareRisk(key) {
  const cached = skincareRiskCache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.ts > SKINCARE_RISK_CACHE_TTL_MS) {
    skincareRiskCache.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedSkincareRisk(key, value) {
  skincareRiskCache.set(key, {
    value,
    ts: Date.now(),
  });
}

function extractJsonArrayChunk(rawText) {
  const text = String(rawText || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
}

function extractJsonObjectChunk(rawText) {
  const text = String(rawText || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
}

function extractFencedJsonChunk(rawText) {
  const text = String(rawText || "");
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match || !match[1]) {
    return "";
  }
  return String(match[1]).trim();
}

function extractQuotedStringArrays(rawText) {
  const text = String(rawText || "");
  const matches = text.match(/\[[^\[\]]+\]/g) || [];
  const arrays = [];

  for (const chunk of matches) {
    const normalized = chunk.replace(/'/g, '"');
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        arrays.push(parsed);
      }
    } catch (error) {
      // ignore non-JSON arrays
    }
  }

  return arrays;
}

function parseJsonObjectFromContent(content) {
  const text = String(content || "").trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // fallback below
  }

  const fenced = extractFencedJsonChunk(text);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      // fallback below
    }
  }

  const objectChunk = extractJsonObjectChunk(text);
  if (objectChunk) {
    try {
      const parsed = JSON.parse(objectChunk);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      return null;
    }
  }

  return null;
}

function clampScoreToRange(value, min = 1, max = 10) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return min;
  }

  if (num < min) {
    return min;
  }

  if (num > max) {
    return max;
  }

  return Number(num.toFixed(2));
}

function parseTokenListFromModelContent(content, candidateKeyMap) {
  let parsed = null;
  const trimmedContent = String(content || "").trim();
  if (!trimmedContent) {
    return [];
  }

  try {
    parsed = JSON.parse(trimmedContent);
  } catch (error) {
    parsed = null;
  }

  if (!parsed) {
    const fenced = extractFencedJsonChunk(trimmedContent);
    if (fenced) {
      try {
        parsed = JSON.parse(fenced);
      } catch (error) {
        parsed = null;
      }
    }
  }

  if (!parsed) {
    const arrayChunk = extractJsonArrayChunk(trimmedContent);
    if (arrayChunk) {
      try {
        parsed = JSON.parse(arrayChunk);
      } catch (error) {
        parsed = null;
      }
    }
  }

  if (!parsed) {
    const objectChunk = extractJsonObjectChunk(trimmedContent);
    if (objectChunk) {
      try {
        parsed = JSON.parse(objectChunk);
      } catch (error) {
        parsed = null;
      }
    }
  }

  let list = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object") {
    const candidatesFromObject =
      parsed.detectedIngredients ||
      parsed.ingredients ||
      parsed.validIngredients ||
      parsed.result ||
      parsed.data;
    if (Array.isArray(candidatesFromObject)) {
      list = candidatesFromObject;
    }
  }

  if (!Array.isArray(list) || list.length === 0) {
    const fallbackArrays = extractQuotedStringArrays(trimmedContent);
    if (fallbackArrays.length > 0) {
      list = fallbackArrays[fallbackArrays.length - 1];
    }
  }

  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }

  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const value = String(item || "").trim();
    const key = normalizeTokenKey(value);
    if (!key || seen.has(key) || !candidateKeyMap.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidateKeyMap.get(key));
  }

  return unique;
}

async function refineDetectedIngredientsWithAI(ingredientText, candidates = []) {
  if (!HF_API_TOKEN) {
    return [];
  }

  const cleanedCandidates = Array.from(
    new Set(
      (Array.isArray(candidates) ? candidates : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 80);

  if (cleanedCandidates.length === 0) {
    return [];
  }

  const prompt = [
    "You validate cosmetic ingredient tokens.",
    "From candidate tokens, keep ONLY tokens that are actual cosmetic ingredients.",
    "Exclude random words, commands, labels, company names, addresses, marketing/legal text, and non-ingredient tokens.",
    "If uncertain whether a token is a real ingredient, exclude it.",
    "If equivalent ingredients appear in multiple languages/spellings, keep only one name with language priority: Bahasa Indonesia first, then English.",
    "Return ONLY valid JSON array of strings.",
    "",
    `Ingredient text: ${ingredientText}`,
    `Candidate tokens: ${JSON.stringify(cleanedCandidates)}`,
  ].join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(HF_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HF_MODEL_ID,
        messages: [
          {
            role: "system",
            content:
              'You validate cosmetic ingredient tokens. Return ONLY a JSON array of strings. Keep only real cosmetic ingredients from candidate tokens. Exclude random/non-ingredient text, and if uncertain exclude. If same ingredient appears in multiple languages/spellings, return one representative using language priority: Bahasa Indonesia first, then English.',
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 450,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return [];
    }

    const candidateKeyMap = new Map();
    for (const candidate of cleanedCandidates) {
      const key = normalizeTokenKey(candidate);
      if (key && !candidateKeyMap.has(key)) {
        candidateKeyMap.set(key, candidate);
      }
    }

    const baseList = parseTokenListFromModelContent(content, candidateKeyMap);
    if (baseList.length === 0) {
      return [];
    }

    const collapsePrompt = [
      "You normalize ingredient names from multiple languages/spellings.",
      "Merge equivalent ingredients and keep one representative name only.",
      "Representative name priority: Bahasa Indonesia first, then English.",
      "Return ONLY valid JSON array of strings.",
      "",
      `Ingredient text: ${ingredientText}`,
      `Validated ingredients: ${JSON.stringify(baseList)}`,
    ].join("\n");

    const collapseResponse = await fetch(HF_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HF_MODEL_ID,
        messages: [
          {
            role: "system",
            content:
              "Normalize equivalent ingredient names across languages/spellings and keep one representative with language priority: Bahasa Indonesia first, then English. Return ONLY JSON array.",
          },
          {
            role: "user",
            content: collapsePrompt,
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 260,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!collapseResponse.ok) {
      return baseList;
    }

    let collapsePayload = null;
    try {
      collapsePayload = await collapseResponse.json();
    } catch (error) {
      collapsePayload = null;
    }

    const collapsedContent = collapsePayload?.choices?.[0]?.message?.content;
    if (typeof collapsedContent !== "string") {
      return baseList;
    }

    const collapseKeyMap = new Map();
    for (const item of baseList) {
      const key = normalizeTokenKey(item);
      if (key && !collapseKeyMap.has(key)) {
        collapseKeyMap.set(key, item);
      }
    }

    const collapsedList = parseTokenListFromModelContent(collapsedContent, collapseKeyMap);
    if (collapsedList.length === 0) {
      return baseList;
    }

    return collapsedList;
  } catch (error) {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function analyzeIngredients(text) {
  if (!HF_API_TOKEN) {
    const err = new Error("Hugging Face API token is not configured.");
    err.status = 500;
    err.code = "INTERNAL_ERROR";
    throw err;
  }

  const controller = new AbortController();
  const timeoutMs = 30000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(HF_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HF_MODEL_ID,
        messages: [
          {
            role: "system",
            content:
              'You are a cosmetic safety analyzer. Return ONLY valid JSON with structure {"detectedIngredients":["string"],"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low","severityReason":"string","pregnancy":{"safe":true|false,"reason":"string"},"recommendation":{"safe":true|false,"reason":"string"}}],"totalDetected":number}. Use Bahasa Indonesia for all descriptive text fields. detectedIngredients must contain only valid ingredient names explicitly present in input text; exclude random words/non-ingredient tokens if uncertain. If the same ingredient appears in multiple languages/spellings, keep one representative name with priority Bahasa Indonesia then English. riskyIngredients must be a subset of detectedIngredients and use the same representative naming. Never include company/brand/address/BPOM/batch/legal text as ingredients. "risk" must be 1-3 concise sentences, "severityReason" must justify the selected severity, "pregnancy.reason" must explain pregnancy safety, and "recommendation.reason" must explain buy recommendation. recommendation.safe is false only for clearly dangerous/prohibited ingredients or likely high-concentration high risk; otherwise it may be true with caution.',
          },
          {
            role: "user",
            content: buildPrompt(text),
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 900,
        stream: false,
      }),
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (parseError) {
      payload = null;
    }

    if (!response.ok) {
      const message = String(
        payload?.error ||
          `Hugging Face request failed with status ${response.status}`,
      );
      if (response.status === 408 || response.status === 504) {
        const err = new Error(message);
        err.code = "AI_TIMEOUT";
        err.status = 504;
        throw err;
      }

      const err = new Error(message);
      err.code = "AI_UNAVAILABLE";
      err.status = 502;
      throw err;
    }

    if (
      payload &&
      Array.isArray(payload.choices) &&
      payload.choices[0] &&
      payload.choices[0].message &&
      typeof payload.choices[0].message.content === "string"
    ) {
      return payload.choices[0].message.content;
    }

    return "";
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();

    if (
      error?.name === "AbortError" ||
      error?.status === 408 ||
      message.includes("abort") ||
      message.includes("timeout")
    ) {
      const err = new Error("Hugging Face request timed out.");
      err.status = 504;
      err.code = "AI_TIMEOUT";
      throw err;
    }

    if (
      error?.code === "ECONNRESET" ||
      error?.code === "ENOTFOUND" ||
      error?.code === "ECONNREFUSED"
    ) {
      const err = new Error("Hugging Face service is unavailable.");
      err.status = 502;
      err.code = "AI_UNAVAILABLE";
      throw err;
    }

    if (error?.code === "AI_UNAVAILABLE" || error?.status === 502) {
      const err = new Error("Hugging Face service is unavailable.");
      err.status = 502;
      err.code = "AI_UNAVAILABLE";
      throw err;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function scoreSingleIngredientRiskForSkincare(
  ingredientName,
  { ingredientText = "" } = {}
) {
  const name = String(ingredientName || "").trim();
  if (!name || !HF_API_TOKEN) {
    return null;
  }

  const cacheKey = normalizeTokenKey(name);
  const cached = getCachedSkincareRisk(cacheKey);
  if (cached) {
    return cached;
  }

  const prompt = [
    "Kamu adalah analis keamanan bahan kosmetik.",
    "Tugas: beri skor risiko bahan dalam konteks produk skincare/cosmetic jadi (bukan konteks industri bahan mentah murni).",
    "Gunakan asumsi kadar kosmetik umum yang legal, kecuali bahan jelas berbahaya/terlarang.",
    "Balas HANYA JSON object valid dengan format:",
    '{"ingredient":"string","score":1-10,"reason":"string","confidence":0-1}',
    "Aturan skor:",
    "- 1 = sangat aman pada pemakaian kosmetik normal",
    "- 5 = perlu kehati-hatian sedang",
    "- 10 = sangat berbahaya/umumnya tidak disarankan",
    "- Jika bahan umumnya aman di kadar kosmetik, skor cenderung rendah (mis. 2-5).",
    "- score harus angka 1-10, confidence 0-1.",
    "- reason maksimal 1-2 kalimat Bahasa Indonesia, fokus konteks skincare.",
    "",
    `Ingredient: ${name}`,
    ingredientText ? `Ingredient text source: ${ingredientText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(HF_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HF_MODEL_ID,
        messages: [
          {
            role: "system",
            content:
              'Kamu menilai skor risiko bahan skincare. Beri output JSON object saja: {"ingredient":"string","score":1-10,"reason":"string","confidence":0-1}. Fokus konteks kosmetik jadi, bukan bahaya bahan mentah industri.',
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 220,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return null;
    }

    const parsed = parseJsonObjectFromContent(content);
    if (!parsed) {
      return null;
    }

    const result = {
      ingredient: String(parsed.ingredient || name).trim() || name,
      score: clampScoreToRange(parsed.score, 1, 10),
      reason: String(parsed.reason || "").trim(),
      confidence: clampScoreToRange(parsed.confidence, 0, 1),
      source: "ai",
    };

    if (!result.reason) {
      result.reason =
        "Risiko dinilai berdasarkan konteks skincare; gunakan sesuai aturan pakai dan pantau reaksi kulit.";
    }

    setCachedSkincareRisk(cacheKey, result);
    return result;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function scoreRiskyIngredientsForSkincare(
  riskyIngredients = [],
  { ingredientText = "" } = {}
) {
  const maxItems = Math.max(
    1,
    Math.min(20, Number(process.env.SKINCARE_AI_SCORE_MAX_ITEMS || 10))
  );
  const uniqueNames = Array.from(
    new Set(
      (Array.isArray(riskyIngredients) ? riskyIngredients : [])
        .map((item) => String(item?.name || item || "").trim())
        .filter(Boolean)
    )
  ).slice(0, maxItems);

  if (uniqueNames.length === 0) {
    return [];
  }

  const output = [];
  for (const name of uniqueNames) {
    const scored = await scoreSingleIngredientRiskForSkincare(name, { ingredientText });
    if (scored) {
      output.push(scored);
    }
  }

  return output;
}

module.exports = {
  analyzeIngredients,
  refineDetectedIngredientsWithAI,
  scoreRiskyIngredientsForSkincare,
  HF_MODEL_ID,
};
