const HF_API_TOKEN = process.env.HF_API_TOKEN;
const HF_MODEL_ID = process.env.HF_MODEL_ID || "Qwen/Qwen2.5-7B-Instruct";
const HF_CHAT_ENDPOINT = "https://router.huggingface.co/v1/chat/completions";
function buildPrompt(ingredientText) {
  return [
    "You are a cosmetic safety analyzer.",
    "Given product label ingredient text, identify only potentially risky/dangerous ingredients.",
    "Return ONLY valid JSON with this exact structure:",
    '{"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low"}],"totalDetected":number}',
    "Rules:",
    "- riskyIngredients can be empty array.",
    "- totalDetected is total number of ingredients detected in input text.",
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
              'You are a cosmetic safety analyzer. Return ONLY valid JSON with structure {"riskyIngredients":[{"name":"string","aliases":["string"],"risk":"string","severity":"high|medium|low"}],"totalDetected":number}.',
          },
          {
            role: "user",
            content: buildPrompt(text),
          },
        ],
        temperature: 0.1,
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
