import { distanceBetween } from "./coordinates.js";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ==== CONFIG ====
const REVIEWS_PER_PLACE = 3; // use up to N reviews per place

// ---- 0) Bedrock client (reuse ONE client; enable retries) ----
const client = new BedrockRuntimeClient({
  region: "us-east-1",
  maxAttempts: 10,
  // retryMode: "adaptive", // optional if your SDK supports it
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

// ---- 2) Tool config that forces the JSON shape ----
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

// ---- 3) Retry helpers ----
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

// ---- 4) Converse call ----
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

//////////////////////////////////////////////////////////////
// PUBLIC API
//////////////////////////////////////////////////////////////

/**
 * Rank ONLY the ids present in suggestedPlacesPool.
 *
 * @param {Object} suggestedPlacesPool
 *   {
 *     "1": {
 *       lat: number,
 *       long: number,
 *       reviews: string[],      // up to 3 review strings
 *       name: string,
 *       google_place_id: string
 *     },
 *     ...
 *   }
 * @param {string} [newBedrockPrompt="Restaurants"] Optional prefix in the prompt.
 *
 * @returns {Object} suggestedPlacesMetrics
 *   {
 *     "1": [lat, long, {metrics}, false, "google_place_id"],
 *     ...
 *   }
 */
export async function rankPlaces(suggestedPlacesPool, newBedrockPrompt) {
  const ids = Object.keys(suggestedPlacesPool || {}).sort((a, b) => Number(a) - Number(b));
  const suggestedPlacesMetrics = {};

  if (ids.length === 0) {
    console.warn("rankPlaces: no ids in suggestedPlacesPool.");
    return suggestedPlacesMetrics;
  }

  for (const id of ids) {
    const place = suggestedPlacesPool[id] || {};
    const name = place.name ?? "(no name)";
    const google_place_id = place.google_place_id ?? null;

    // Up to REVIEWS_PER_PLACE review strings
    const reviewStrings = (place.reviews ?? [])
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .slice(0, REVIEWS_PER_PLACE);

    if (reviewStrings.length === 0) {
      console.warn(`rankPlaces: no reviews for id=${id} (${name}); skipping.`);
      continue;
    }

    const userPrompt =
      (newBedrockPrompt ? `${newBedrockPrompt.trim()}\n` : "") +
      buildPromptFromReviews(reviewStrings);

    try {
      const { metrics } = await invokeClaudeConverse(userPrompt);

      const lat = place.lat ?? place.latitude ?? null;
      const long = place.long ?? place.longitude ?? null;

      // Return shape requested: [lat, long, {metrics}, false, "google_place_id"]
      suggestedPlacesMetrics[id] = [lat, long, metrics, false, google_place_id];

      console.log(`rankPlaces: scored id=${id} (${name})`);
    } catch (err) {
      console.error(`rankPlaces: scoring failed for id=${id} (${name}):`, err?.message || err);
    }

    // jitter to avoid bursts
    await sleep(150 + Math.random() * 300);
  }

  return suggestedPlacesMetrics;
}

/**
 * Choose best place using distance + AI score.
 * NOTE: Works unchanged with the new tuple: [lat, long, metrics, _flag, _gpid]
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
      // Weighted by powered weights + a small history term
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

    const rating = dis_weight * (1 - distanceToEnd / initialDistance) +
                   ai_weight * resultingWeightMap[key];
    console.log("Rating for " + key + ": " + rating)

    if (rating > highestRating) {
      placeIdWithHighestRating = key;
      highestRating = rating;
    }
  }

  // Return winning id and its lat/long (indices 0,1)
  return [
    placeIdWithHighestRating,
    { lat: suggestedPlacesMetrics[placeIdWithHighestRating][0],
      long: suggestedPlacesMetrics[placeIdWithHighestRating][1] },
  ];
}