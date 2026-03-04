const API_URL = process.env.ANALYZE_URL || 'http://127.0.0.1:3000/api/analyze-ingredients';
const RUNS = Number(process.env.EVAL_RUNS || 5);
const RETRY_WAIT_MS = Number(process.env.EVAL_RETRY_WAIT_MS || 65000);

const TEST_CASES = [
  {
    id: 'dangerous_with_noise',
    text: `Glycerin\nNiacinamide\nSodium Hyaluronate\nPanthenol\nTocopherol (Vitamin E)\nZinc Oxide\nTitanium Dioxide\nAllantoin\nDimethicone\nButylene Glycol\nMercury (Merkuri)\nHydroquinone\nGayung\nGelas\nSendok\nSikat gigi\nEmber\nPiring\nBotol plastik\nHanduk`,
    forbidden: ['gayung', 'gelas', 'sendok', 'sikat gigi', 'ember', 'piring', 'botol plastik', 'handuk'],
  },
  {
    id: 'mixed_ingredients_and_noise',
    text: `Water, Aqua, Glycerin, Niacinamide, Sodium Benzoate, Fragrance, Cetearyl Alcohol, Phenoxyethanol, Caprylyl Glycol, Sodium Lactate, Tocopherol, Aloe Vera Extract, canview, super, override, NET 150 ML, Manufactured by PT ABC, gula, sugar, acucar`,
    forbidden: ['canview', 'super', 'override', 'net 150 ml', 'manufactured by pt abc'],
  },
];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSet(items) {
  const values = Array.isArray(items) ? items : [];
  return values
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .sort();
}

function signatureFromData(data) {
  const safe = normalizeSet(data?.safeIngredients || []);
  const risky = normalizeSet((data?.riskyIngredients || []).map((item) => item?.name));
  const recommendation = (data?.riskyIngredients || [])
    .map((item) => `${normalizeText(item?.name)}:${Boolean(item?.recommendation?.safe)}`)
    .sort();

  return JSON.stringify({
    totalDetected: Number(data?.totalDetected || 0),
    safe,
    risky,
    recommendation,
  });
}

function hasForbiddenOutput(data, forbiddenList) {
  const safe = Array.isArray(data?.safeIngredients) ? data.safeIngredients : [];
  const risky = Array.isArray(data?.riskyIngredients) ? data.riskyIngredients.map((item) => item?.name) : [];
  const output = [...safe, ...risky].map((value) => normalizeText(value));

  const hits = [];
  for (const forbidden of forbiddenList) {
    const f = normalizeText(forbidden);
    if (!f) {
      continue;
    }

    if (output.includes(f)) {
      hits.push(forbidden);
    }
  }

  return hits;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postAnalyze(text, attempt = 1) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ingredientText: text }),
  });

  if (response.status === 429 && attempt <= 2) {
    await sleep(RETRY_WAIT_MS);
    return postAnalyze(text, attempt + 1);
  }

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  return {
    status: response.status,
    body,
  };
}

async function runCase(testCase) {
  const signatures = new Set();
  const failures = [];
  const forbiddenHits = [];

  for (let run = 1; run <= RUNS; run += 1) {
    const result = await postAnalyze(testCase.text);
    if (result.status !== 200 || !result.body?.success) {
      failures.push({ run, status: result.status, error: result.body?.error || null });
      continue;
    }

    const data = result.body.data || {};
    signatures.add(signatureFromData(data));

    const hits = hasForbiddenOutput(data, testCase.forbidden || []);
    if (hits.length > 0) {
      forbiddenHits.push({ run, hits });
    }
  }

  return {
    id: testCase.id,
    runs: RUNS,
    signatureCount: signatures.size,
    stable: signatures.size === 1 && failures.length === 0,
    failures,
    forbiddenHits,
  };
}

(async () => {
  const results = [];
  for (const testCase of TEST_CASES) {
    const result = await runCase(testCase);
    results.push(result);
  }

  const hasFailures = results.some((item) => item.failures.length > 0 || item.forbiddenHits.length > 0 || !item.stable);

  console.log(JSON.stringify({
    apiUrl: API_URL,
    runsPerCase: RUNS,
    passed: !hasFailures,
    results,
  }, null, 2));

  if (hasFailures) {
    process.exitCode = 1;
  }
})();
