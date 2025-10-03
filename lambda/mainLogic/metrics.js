// strict-json-converse-retry.mjs
// Run: node strict-json-converse-retry.mjs

import { fileURLToPath } from "url";
import { readFile, writeFile } from "fs/promises"; // JSON IO
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

// ==== CONFIG: pick the places and how many reviews to use per place ====
const IN_PLACES_PATH = "./places.json";   // input keyed by "1","2",...
const OUT_SCORES_PATH = "./scores.json";  // output object keyed by id
const ID_START = 1;                       // inclusive
const ID_END = 5;                         // inclusive
const REVIEWS_PER_PLACE = 3;              // use up to N reviews per place

// Collect results keyed by id => { [id]: { name, google_place_id, metrics } }
const results = {};

// ---- 0) Client: reuse ONE client, enable more attempts (SDK retries) ----
export const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  maxAttempts: 10,
  // retryMode: "adaptive", // if desired and supported
});

// -------------------------------------
// A) STRICT METRICS (your existing tool)
// -------------------------------------
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
        modern:       { type: "integer", minimum: 1, maximum: 10 }
      },
      required: [
        "romantic","adventurous","relaxation","cultural",
        "gastronomic","nature","entertaining","modern"
      ]
    }
  },
  required: ["metrics"]
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
export async function withBackoff(fn, { max = 6, base = 250, cap = 6000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= max) throw err;
      const exp = Math.min(cap, base * (2 ** attempt));
      const delay = Math.floor(Math.random() * (exp + 1));
      await sleep(delay);
      attempt++;
    }
  }
}

// ---- 4) Converse call (existing metrics scorer) ----
export async function invokeClaudeConverse(prompt) {
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
        `.trim()
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

// ---- Helpers to read places.json and build the prompt from its reviews ----
export async function loadPlacesMap(path) {
  const txt = await readFile(path, "utf8");
  const obj = JSON.parse(txt);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`Expected top-level object in ${path}`);
  }
  return obj; // keyed by "1","2",...
}

export function buildPromptFromReviews(reviewTexts) {
  const lines = reviewTexts
    .map((t, i) => `-- Review-${i + 1}: ${t?.toString()?.trim() ?? ""}`)
    .join("\n");

  return (
    "Score these 8 metrics (romantic, adventurous, relaxation, cultural, gastronomic, nature, entertaining, modern) " +
    "each as an INTEGER from 1 to 10 based ONLY on the reviews below. " +
    "If a metric is not mentioned, infer fairly using the neutral default (5). " +
    "Return scores via the tool only; do not include explanations.\n" +
    lines
  );
}

// -------------------------------------------------
// B) NEW: findWeights(bedrockPrompt) via tools flow
//     accepts ANY float in [0.1, 0.9], clamps/repairs
// -------------------------------------------------

// Fixed output order for the ARRAY you want:
const WEIGHT_ORDER = [
  "cultural",
  "relaxation",
  "gastronomic",
  "nature",
  "modern",
  "entertaining",
  "romantic",
  "adventurous",
];

// Fallback: EXACTLY 8 numbers (one per metric)
const DEFAULT_WEIGHTS = Array(8).fill(0.5);

// Clamp/normalize to [0.1, 0.9]; tolerate strings, %, 1–10, 0–100
function clamp01to09(x) {
  if (x === undefined || x === null) return 0.5;

  if (typeof x === "string") {
    const t = x.trim();
    if (t.endsWith("%")) {
      const n = Number(t.slice(0, -1));
      if (Number.isFinite(n)) return Math.min(0.9, Math.max(0.1, +(n / 100).toFixed(3)));
      return 0.5;
    }
    const n = Number(t);
    x = Number.isFinite(n) ? n : 0.5;
  }

  let n = Number(x);
  if (!Number.isFinite(n)) n = 0.5;

  // map common alternate scales
  if (n >= 1 && n <= 10 && Number.isInteger(n)) n = n / 10; // 1..10 -> 0.1..1.0
  else if (n > 1) n = n / 100;                               // 0..100 -> 0..1

  // clamp to [0.1, 0.9]
  if (n < 0.1) n = 0.1;
  if (n > 0.9) n = 0.9;

  return +n.toFixed(3);
}

// Schema: accept any number (we'll clamp), require all 8 fields present
const EmitWeightsSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    WEIGHT_ORDER.map((k) => [k, { type: "number", minimum: 0.1, maximum: 0.9 }])
  ),
  required: WEIGHT_ORDER,
};

// Weights tool config
const toolConfigWeights = {
  tools: [
    {
      toolSpec: {
        name: "emit_weights",
        description:
          "Return ONLY JSON with 8 fields (cultural, relaxation, gastronomic, nature, modern, entertaining, romantic, adventurous), each a number in [0.1, 0.9].",
        inputSchema: { json: EmitWeightsSchema },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_weights" } },
};

/**
 * findWeights(bedrockPrompt): lets the LLM decide each metric’s weight (float in [0.1..0.9]),
 * clamps/repairs values, and returns a dense Array<number> of length 8 in WEIGHT_ORDER.
 */
export async function findWeights(bedrockPrompt, { debug = false } = {}) {
  const cmd = new ConverseCommand({
    modelId:
      process.env.BEDROCK_MODEL_ID ||
      "amazon.nova-micro-v1:0",
    system: [
      {
        text: `
Output ONLY JSON via the tool.

Task:
Given the user's prompt describing preferences, assign EACH metric a numeric score in the closed interval [0.1, 0.9].
Return exactly these 8 fields (no extras, none missing):
${WEIGHT_ORDER.join(", ")}

Guidelines:
- Base scores on the user's text (best guess).
- Use 0.5 when unclear.
- No commentary outside the tool output.
        `.trim(),
      },
    ],
    messages: [{ role: "user", content: [{ text: bedrockPrompt ?? "" }] }],
    toolConfig: toolConfigWeights,
    inferenceConfig: { maxTokens: 128, temperature: 0.3, topP: 0.9 },
  });

  try {
    const res = await withBackoff(() => client.send(cmd), {
      max: 6,
      base: 300,
      cap: 8000,
    });

    const blocks = res.output?.message?.content ?? [];
    const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
    const obj = toolUse?.input;

    if (!obj || typeof obj !== "object") {
      if (debug) console.warn("[findWeights] No toolUse input; using DEFAULT_WEIGHTS.");
      return DEFAULT_WEIGHTS;
    }
    if (debug) console.log("[findWeights] toolUse.input =", obj);

    // Convert to array in fixed order; clamp values; fill missing with 0.5 (clamp handles undefined)
    const weights = WEIGHT_ORDER.map((k) => clamp01to09(obj[k]));

    if (debug) console.log("[findWeights] weights =", weights);

    // Final sanity check (should always pass with clamp)
    const ok = weights.length === 8 && weights.every((v) => Number.isFinite(v) && v >= 0.1 && v <= 0.9);
    return ok ? weights : DEFAULT_WEIGHTS;
  } catch (err) {
    if (debug) console.error("[findWeights] Error:", err);
    return DEFAULT_WEIGHTS;
  }
}

/*FIXME:*/
export function updateMetrics(dis_weight, ai_weight, lean_ai){
    if(!lean_ai)
        return [(8*dis_weight)/5 , (4*ai_weight)/5]
}

/*FIXME: */
export function decrement_i(placeCoor, endPlace, averageRadius){
    return 1
}