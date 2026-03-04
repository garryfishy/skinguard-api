const HF_API_TOKEN = process.env.HF_API_TOKEN;
const HF_MODEL_ID = process.env.HF_MODEL_ID || "Qwen/Qwen2.5-7B-Instruct";
const HF_CHAT_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";

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

function extractJsonArrayChunk(rawText) {
  const text = String(rawText || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
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
              'You validate cosmetic ingredient tokens. Return ONLY a JSON array of strings. Keep only real cosmetic ingredients from candidate tokens. Exclude random/non-ingredient text, and if uncertain exclude.',
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

    const arrayChunk = extractJsonArrayChunk(content);
    if (!arrayChunk) {
      return [];
    }

    let parsed = [];
    try {
      parsed = JSON.parse(arrayChunk);
    } catch (error) {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const candidateKeyMap = new Map();
    for (const candidate of cleanedCandidates) {
      const key = normalizeTokenKey(candidate);
      if (key && !candidateKeyMap.has(key)) {
        candidateKeyMap.set(key, candidate);
      }
    }

    const unique = [];
    const seen = new Set();
    for (const item of parsed) {
      const value = String(item || "").trim();
      const key = normalizeTokenKey(value);
      if (!key || seen.has(key) || !candidateKeyMap.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(candidateKeyMap.get(key));
    }

    return unique;
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
              'You are a cosmetic safety analyzer. Return ONLY valid JSON with structure {"detectedIngredients":["string"],"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low","severityReason":"string","pregnancy":{"safe":true|false,"reason":"string"},"recommendation":{"safe":true|false,"reason":"string"}}],"totalDetected":number}. Use Bahasa Indonesia for all descriptive text fields. detectedIngredients must contain only valid ingredient names explicitly present in input text; exclude random words/non-ingredient tokens if uncertain. riskyIngredients must be a subset of detectedIngredients. Never include company/brand/address/BPOM/batch/legal text as ingredients. "risk" must be 1-3 concise sentences, "severityReason" must justify the selected severity, "pregnancy.reason" must explain pregnancy safety, and "recommendation.reason" must explain buy recommendation. recommendation.safe is false only for clearly dangerous/prohibited ingredients or likely high-concentration high risk; otherwise it may be true with caution.',
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

module.exports = {
  analyzeIngredients,
  refineDetectedIngredientsWithAI,
  HF_MODEL_ID,
};
