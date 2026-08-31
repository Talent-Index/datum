import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";

/**
 * Stage classification behind one swappable interface.
 *
 * Production options, in order of effort:
 *   - Vision-language model with a constrained JSON response. Two are
 *     implemented: NVIDIA-hosted open models (the default) and Anthropic.
 *   - Fine-tuned classifier exported to ONNX once you have labelled sites.
 *     The seam is this interface: implement classify() against
 *     onnxruntime-web or a dedicated inference service and swap it in where
 *     the verifier is constructed. onnxruntime-node is deliberately not a
 *     dependency — it does not fit in a Vercel function.
 *
 * The sidecar backend reads a `<image>.stage` label file so the whole
 * pipeline can be exercised deterministically and offline, exactly like the
 * reference implementation's stub.
 */

export const STAGES = [
  "site_clearing",
  "foundation",
  "ground_slab",
  "superstructure",
  "roofing",
  "finishing",
] as const;

export interface StageClassification {
  stage: string;
  confidence: number;
}

export interface StageClassifier {
  classify(imagePath: string): Promise<StageClassification>;
}

const vlmResponseSchema = z.object({
  stage: z.enum([...STAGES, "unknown"]),
  confidence: z.number().min(0).max(1),
});

const UNKNOWN: StageClassification = { stage: "unknown", confidence: 0 };

/**
 * One prompt for every model backend, so a change of provider cannot quietly
 * change what the classifier was asked.
 */
const STAGE_PROMPT =
  "This is a photograph of a building construction site in Kenya. " +
  "Classify the visible construction stage as exactly one of: " +
  `${STAGES.join(", ")}. ` +
  "The stages occur in that order on site. If no construction is visible or " +
  'the stage cannot be determined, use "unknown". ' +
  'Respond with only a JSON object: {"stage": "<one of the listed values>", ' +
  '"confidence": <number between 0 and 1>}';

/** Read the model's JSON reply, tolerating prose or code fences around it. */
function readStage(text: string): StageClassification {
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return UNKNOWN;
  let value: unknown;
  try {
    value = JSON.parse(json[0]);
  } catch {
    return UNKNOWN;
  }
  const parsed = vlmResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : UNKNOWN;
}

export class SidecarClassifier implements StageClassifier {
  async classify(imagePath: string): Promise<StageClassification> {
    let text: string;
    try {
      text = await readFile(imagePath + ".stage", "utf8");
    } catch {
      return UNKNOWN;
    }
    const parts = text.trim().split(/\s+/);
    const stage = parts[0];
    if (!stage) return UNKNOWN;
    const confidence = parts[1] !== undefined ? Number.parseFloat(parts[1]) : 0.9;
    return { stage, confidence: Number.isFinite(confidence) ? confidence : 0.9 };
  }
}

const messageResponseSchema = z.object({
  stop_reason: z.string().nullish(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
});

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

export class VlmClassifier implements StageClassifier {
  constructor(
    private readonly apiKey: string = process.env.ANTHROPIC_API_KEY ?? "",
    private readonly model: string = process.env.STAGE_MODEL ?? "claude-opus-5",
  ) {}

  async classify(imagePath: string): Promise<StageClassification> {
    if (!this.apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set; set it, or construct the verifier with SidecarClassifier for offline use",
      );
    }
    const image = await readFile(imagePath);

    const response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        // Safety classifiers can decline a request; the default fallback
        // reruns it server-side on a substitute model instead of failing.
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        fallbacks: "default",
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                stage: { type: "string", enum: [...STAGES, "unknown"] },
                confidence: { type: "number" },
              },
              required: ["stage", "confidence"],
              additionalProperties: false,
            },
          },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: image.toString("base64"),
                },
              },
              { type: "text", text: STAGE_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Stage classification request failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const message = messageResponseSchema.parse(await response.json());
    if (message.stop_reason === "refusal") return UNKNOWN;

    const text = message.content.find(
      (block: { type: string; text?: string }) => block.type === "text",
    )?.text;
    return text ? readStage(text) : UNKNOWN;
  }
}

const NVIDIA_API = "https://integrate.api.nvidia.com/v1/chat/completions";

// NVIDIA rejects inline images much above 180KB, so frames are downscaled
// before they are sent. Site photographs off a phone are routinely 3-8MB.
const MAX_INLINE_BYTES = 140_000;

// Attempts per frame before giving up and reporting it unclassifiable.
const ATTEMPTS = 3;

const nvidiaResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).nullish() }))
    .default([]),
});

/**
 * NVIDIA-hosted vision model over their OpenAI-compatible endpoint.
 *
 * The 11B Llama vision model is the default because the hosted endpoint's
 * latency is wildly variable — measured between 2 and 157 seconds for the
 * same work — and a serverless function has tens of seconds to live. 11B
 * answers in about two seconds and is decisive on a clear photograph of one
 * stage; it returns "unknown" on cluttered or ambiguous frames rather than
 * guessing. The 90B model commits on those harder frames and is worth
 * setting NVIDIA_MODEL to when latency is not the constraint.
 */
export class NvidiaClassifier implements StageClassifier {
  constructor(
    private readonly apiKey: string = process.env.NVIDIA_API_KEY ?? process.env.NVIDIA_KEY ?? "",
    private readonly model: string = process.env.NVIDIA_MODEL ??
      "meta/llama-3.2-11b-vision-instruct",
    private readonly timeoutMs: number = Number(process.env.STAGE_TIMEOUT_MS ?? 40_000),
  ) {}

  private async encode(imagePath: string): Promise<string> {
    let quality = 80;
    let buffer = await sharp(imagePath)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    while (buffer.length > MAX_INLINE_BYTES && quality > 30) {
      quality -= 15;
      buffer = await sharp(imagePath)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    }
    return buffer.toString("base64");
  }

  async classify(imagePath: string): Promise<StageClassification> {
    if (!this.apiKey) {
      throw new Error(
        "NVIDIA_API_KEY is not set; set it, or set STAGE_CLASSIFIER=sidecar for offline use",
      );
    }
    const image = await this.encode(imagePath);

    // The hosted endpoint is unreliable in two distinct ways: it stalls for
    // minutes at a time, and it fails intermittently on a frame that
    // succeeds moments later. Each attempt is capped, and a transient
    // failure is retried rather than being read as an unclassifiable
    // photograph — an honest developer's evidence should not be rejected
    // because a GPU queue hiccuped.
    const body = JSON.stringify({
        model: this.model,
        max_tokens: 128,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: STAGE_PROMPT },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
            ],
          },
        ],
    });

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750 * attempt));
      let response: Response;
      try {
        response = await fetch(NVIDIA_API, {
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body,
        });
      } catch {
        continue; // timed out or the connection dropped; try again
      }

      // A rejected key is a configuration fault, not a bad photograph, and
      // silently reporting every frame as unclassifiable would hide it.
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `NVIDIA rejected the API key (HTTP ${response.status}); check NVIDIA_API_KEY`,
        );
      }
      if (!response.ok) continue;

      const parsed = nvidiaResponseSchema.safeParse(await response.json().catch(() => null));
      const text = parsed.success ? parsed.data.choices[0]?.message?.content : null;
      if (text) return readStage(text);
    }
    return UNKNOWN;
  }
}

/** Pick the backend named by STAGE_CLASSIFIER. */
export function stageClassifier(): StageClassifier {
  switch (process.env.STAGE_CLASSIFIER) {
    case "sidecar":
      return new SidecarClassifier();
    case "anthropic":
      return new VlmClassifier();
    default:
      return new NvidiaClassifier();
  }
}
