import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Stage classification behind one swappable interface.
 *
 * Production options, in order of effort:
 *   - Vision-language model with a constrained JSON response (implemented,
 *     the default)
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

const UNKNOWN: StageClassification = { stage: "unknown", confidence: 0 };

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

const vlmResponseSchema = z.object({
  stage: z.enum([...STAGES, "unknown"]),
  confidence: z.number().min(0).max(1),
});

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
              {
                type: "text",
                text:
                  "This is a photograph of a building construction site in Kenya. " +
                  "Classify the visible construction stage as exactly one of: " +
                  `${STAGES.join(", ")}. ` +
                  "The stages occur in that order on site. If no construction is " +
                  'visible or the stage cannot be determined, use "unknown". ' +
                  "Give your confidence between 0 and 1.",
              },
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
    if (!text) return UNKNOWN;

    const parsed = vlmResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return UNKNOWN;
    return parsed.data;
  }
}
