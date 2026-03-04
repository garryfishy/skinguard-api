const HF_API_TOKEN = process.env.HF_API_TOKEN;
const HF_MODEL_ID = process.env.HF_MODEL_ID || "Qwen/Qwen2.5-7B-Instruct";
const HF_CHAT_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
function buildPrompt(ingredientText) {
  return [
    "You are a cosmetic safety analyzer.",
    "Use Bahasa Indonesia for all descriptive text fields.",
    "Given product label ingredient text, identify only potentially risky/dangerous ingredients.",
    "Return ONLY valid JSON with this exact structure:",
    '{"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low","severityReason":"string","pregnancy":{"safe":true|false,"reason":"string"},"recommendation":{"safe":true|false,"reason":"string"}}],"totalDetected":number}',
    "Rules:",
    "- riskyIngredients can be empty array.",
    "- totalDetected is total number of ingredients detected in input text.",
    "- Only return ingredients that are explicitly present in the provided ingredient text.",
    "- Never include company name, brand name, address, BPOM number, batch code, or legal/marketing text as ingredients.",
    "- If uncertain whether a token is an ingredient, exclude it from riskyIngredients.",
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
              'You are a cosmetic safety analyzer. Return ONLY valid JSON with structure {"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low","severityReason":"string","pregnancy":{"safe":true|false,"reason":"string"},"recommendation":{"safe":true|false,"reason":"string"}}],"totalDetected":number}. Use Bahasa Indonesia for all descriptive text fields. Only include ingredients explicitly present in the given ingredient text. Never include company/brand/address/BPOM/batch/legal text as ingredients. If uncertain whether a token is an ingredient, exclude it. "risk" must be 1-3 concise sentences, "severityReason" must justify the selected severity, "pregnancy.reason" must explain pregnancy safety, and "recommendation.reason" must explain buy recommendation. recommendation.safe is false only for clearly dangerous/prohibited ingredients or likely high-concentration high risk; otherwise it may be true with caution.',
          },
          {
            role: "user",
            content: buildPrompt(text),
          },
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 500,
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
  HF_MODEL_ID,
};
