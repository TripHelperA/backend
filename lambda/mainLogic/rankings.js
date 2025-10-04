// rankings.js
import { distanceBetween } from "./coordinates.js";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ==== CONFIG ====
const REVIEWS_PER_PLACE = 3; // use up to N reviews per place
const CONCURRENCY_LIMIT = 5; // 4–6 is usually safe for Lambda

// ---- 0) Bedrock client (reuse ONE client; enable retries) ----
const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  maxAttempts: 10,
  retryMode: "adaptive",
});

// ---- 1) Strict JSON schema for the tool ----
const EmitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    metrics: {
      type: "object",
      additionalProperties: false,
      properties: {
        romantic:     { type: "integer", minimum: 1, maximum: 10 },
        adventurous:  { type: "integer", minimum: 1, maximum: 10 },
        relaxation:   { type: "integer", minimum: 1, maximum: 10 },
        cultural:     { type: "integer", minimum: 1, maximum: 10 },
        gastronomic:  { type: "integer", minimum: 1, maximum: 10 },
        nature:       { type: "integer", minimum: 1, maximum: 10 },
        entertaining: { type: "integer", minimum: 1, maximum: 10 },
        modern:       { type: "integer", minimum: 1, maximum: 10 },
      },
      required: [
        "romantic","adventurous","relaxation","cultural",
        "gastronomic","nature","entertaining","modern",
      ],
    },
  },
  required: ["metrics"],
};

const toolConfig = {
  tools: [
    {
      toolSpec: {
        name: "emit_json",
        description: "Return ONLY JSON that matches the schema.",
        inputSchema: { json: EmitSchema },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_json" } },
};

// ---- Retry helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isRetryable(err) {
  const code = err?.$metadata?.httpStatusCode;
  const name = err?.name || err?.Code || "";
  return (
    code === 429 ||
    name.includes("Throttling") ||
    name.includes("ThrottlingException") ||
    name.includes("Timeout") ||
    name.includes("Transient") ||
    name.includes("ServiceUnavailable")
  );
}
async function withBackoff(fn, { max = 6, base = 250, cap = 6000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= max) throw err;
      const exp = Math.min(cap, base * 2 ** attempt);
      const delay = Math.floor(Math.random() * (exp + 1));
      await sleep(delay);
      attempt++;
    }
  }
}

// ---- Converse call ----
async function invokeClaudeConverse(prompt) {
  const cmd = new ConverseCommand({
    modelId:
      process.env.BEDROCK_MODEL_ID ||
      "amazon.nova-micro-v1:0",
    system: [
      {
        text: `
You output ONLY JSON via the tool.
Scoring rules (strict):
- Each metric is an INTEGER 1–10.
- Use 5 as neutral when truly unknown.
- Deviate from always scoring 5 for neutral values and try guessing more randomly by small tweaks.
- Scores should look UNIFORM. Same score shall NOT be repated many times overall.
- DO NOT score all of them above 5 or below 5. Approximately half of them should be above 5 and below 5.
- Evidence mapping:
  • strong positive -> 8–9; extreme -> 10
  • weak positive -> 6–7
  • weak negative -> 4–3; strong -> 2; extreme -> 1
- Use 1 or 10 ONLY with explicit and powerful wording.
- Phrase lexicon (examples):
  • cultural: history, heritage, museum, historic, old town, architecture
  • relaxation: quiet, peaceful, calm, tranquil, chill, crowded(-) noisy(-)
  • gastronomic: food, dining, dinner, cuisine, restaurant, delicious
  • nature: park, green, forest, sea, beach, mountain, outdoors
  • modern: modern, contemporary, trendy, sleek
  • entertaining: lively, fun, entertaining, nightlife, music
  • romantic: romantic, intimate, cozy, date
  • adventurous: hike, trail, adrenaline, adventure, climb
        `.trim(),
      },
    ],
    messages: [{ role: "user", content: [{ text: prompt }] }],
    toolConfig,
    inferenceConfig: { maxTokens: 512, temperature: 0 },
  });

  const res = await withBackoff(() => client.send(cmd), {
    max: 6,
    base: 300,
    cap: 8000,
  });

  const blocks = res.output?.message?.content ?? [];
  const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
  if (!toolUse) throw new Error("No toolUse block found (check toolChoice/model).");
  return toolUse.input; // strict JSON: { metrics: {...} }
}

function buildPromptFromReviews(reviewTexts) {
  const lines = (reviewTexts ?? [])
    .slice(0, REVIEWS_PER_PLACE)
    .map((t, i) => `-- Review-${i + 1}: ${String(t ?? "").trim()}`)
    .join("\n");

  return (
    "Score these 8 metrics (romantic, adventurous, relaxation, cultural, gastronomic, nature, entertaining, modern) " +
    "each as an INTEGER from 1 to 10 based ONLY on the reviews below. " +
    "If a metric is not mentioned, infer fairly using the neutral default (5). " +
    "Return scores via the tool only; do not include explanations.\n" +
    lines
  );
}

// ======= NEW CONCURRENT rankPlaces() =======
export async function rankPlaces(suggestedPlacesPool, newBedrockPrompt) {
  const ids = Object.keys(suggestedPlacesPool || {}).sort((a, b) => Number(a) - Number(b));
  const suggestedPlacesMetrics = {};

  if (ids.length === 0) {
    console.warn("rankPlaces: no ids in suggestedPlacesPool.");
    return suggestedPlacesMetrics;
  }

  console.log(`RankPlaces: ${ids.length} places, concurrency=${CONCURRENCY_LIMIT}`);

  // Small async pool implementation (no external deps)
  const active = new Set();
  async function runTask(id) {
    try {
      const place = suggestedPlacesPool[id];
      const name = place.name ?? "(no name)";
      const reviews = (place.reviews ?? []).slice(0, REVIEWS_PER_PLACE).filter(Boolean);

      if (reviews.length === 0) {
        console.warn(`rankPlaces: no reviews for id=${id} (${name}); skipping.`);
        return;
      }

      const userPrompt =
        (newBedrockPrompt ? `${newBedrockPrompt.trim()}\n` : "") +
        buildPromptFromReviews(reviews);

      console.time(`Bedrock-${id}`);
      const { metrics } = await invokeClaudeConverse(userPrompt);
      console.timeEnd(`Bedrock-${id}`);

      suggestedPlacesMetrics[id] = [
        place.lat ?? place.latitude ?? null,
        place.long ?? place.longitude ?? null,
        metrics,
        false,
        place.google_place_id ?? null,
      ];

      console.log(`rankPlaces: scored id=${id} (${name})`);
    } catch (err) {
      console.error(`rankPlaces: scoring failed for id=${id}:`, err?.message || err);
    }
  }

  // Feed tasks with limited concurrency
  for (const id of ids) {
    const task = runTask(id).finally(() => active.delete(task));
    active.add(task);
    if (active.size >= CONCURRENCY_LIMIT) {
      await Promise.race(active);
    }
  }

  // Wait for remaining
  await Promise.allSettled(active);

  console.log("rankPlaces: completed all Bedrock calls.");
  return suggestedPlacesMetrics;
}

/**
 * getBestPlace remains unchanged below.
 */
export function getBestPlace(
  powConstant,
  dis_weight,
  ai_weight,
  endPlace,
  initialDistance,
  suggestedPlacesMetrics,
  metricsWeights,
  userHistory
) {
  const resultingWeightMap = {};
  const poweredWeightsArr = metricsWeights.map((x) => x ** powConstant);

  for (const key in suggestedPlacesMetrics) {
    const tuple = suggestedPlacesMetrics[key] || [];
    const metrics = tuple[2] || {}; // { romantic, adventurous, ... modern }

    const metricKeys = Object.keys(metrics);
    const resultMap = {};

    metricKeys.forEach((mk, i) => {
      resultMap[mk] = metrics[mk] * (poweredWeightsArr[i] + 0.5 * (userHistory?.[i] ?? 0));
    });

    let totalScore = 0;
    for (const mk in resultMap) totalScore += resultMap[mk];
    resultingWeightMap[key] = totalScore;
  }

  let placeIdWithHighestRating = null;
  let highestRating = -Infinity;

  for (const key in resultingWeightMap) {
    const [lat, long] = suggestedPlacesMetrics[key];
    const distanceToEnd = distanceBetween(lat, long, endPlace.lat, endPlace.long);

    const rating =
      dis_weight * (1 - distanceToEnd / initialDistance) +
      ai_weight * resultingWeightMap[key];
    if (rating > highestRating) {
      placeIdWithHighestRating = key;
      highestRating = rating;
    }
  }

  return [
    placeIdWithHighestRating,
    {
      lat: suggestedPlacesMetrics[placeIdWithHighestRating][0],
      long: suggestedPlacesMetrics[placeIdWithHighestRating][1],
    },
  ];
}
