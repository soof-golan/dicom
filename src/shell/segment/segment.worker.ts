/**
 * The worker that owns the segmentation models and the GPU.
 *
 * Two reasons force a worker of our own. The vision encoder takes seconds, and
 * on the main thread it would freeze the viewer. And the ONNX Runtime docs
 * state that its own proxy worker cannot carry the WebGPU backend, because a
 * GPU buffer does not transfer between threads. So `env.wasm.proxy` stays off
 * and this file is the worker instead.
 *
 * `@huggingface/transformers` is imported here, and only behind `await
 * import()`. Nothing about segmentation may reach the first page load.
 */
import { maskBounds, thresholdHeatmap } from "../../core/segment/mask.ts";
import type { DetectedBox, FromWorker, ToWorker } from "./protocol.ts";
import type { ModelPlan, TextPlan } from "../../core/segment/plan.ts";
import type { BoxPrompt, PointPrompt } from "../../core/segment/types.ts";

type Transformers = typeof import("@huggingface/transformers");
type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

interface SamHandle {
  readonly model: Awaited<ReturnType<Transformers["AutoModel"]["from_pretrained"]>>;
  readonly processor: Awaited<ReturnType<Transformers["AutoProcessor"]["from_pretrained"]>>;
  /** True for SAM 1, which needs a point even when the user drew a box. */
  readonly needsPoint: boolean;
}

interface Encoded {
  readonly inputs: Record<string, unknown>;
  readonly embeddings: Record<string, unknown>;
  readonly image: InstanceType<Transformers["RawImage"]>;
  readonly width: number;
  readonly height: number;
}

interface ClipsegHandle {
  readonly model: Awaited<
    ReturnType<Transformers["CLIPSegForImageSegmentation"]["from_pretrained"]>
  >;
  readonly processor: Awaited<ReturnType<Transformers["AutoProcessor"]["from_pretrained"]>>;
  readonly tokenizer: Awaited<ReturnType<Transformers["AutoTokenizer"]["from_pretrained"]>>;
}

let runtime: Runtime | undefined;
let sam: SamHandle | undefined;
let clipseg: ClipsegHandle | undefined;
let encoded: Encoded | undefined;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

async function loadRuntime(): Promise<Transformers> {
  const module = await import("@huggingface/transformers");
  // The Cache API survives a reload and streams, which matters for a download
  // this size. It is the default; this only makes the choice explicit.
  module.env.useBrowserCache = true;

  // Take the WebAssembly runtime from our own origin, not from a public CDN.
  // The Content-Security-Policy allows no third-party script, and a viewer that
  // reads medical images must not hand a CDN the right to run code. The build
  // copies the binaries into /ort/. See scripts/ort-assets-plugin.ts.
  const wasmBackend = module.env.backends.onnx.wasm;
  if (wasmBackend) {
    wasmBackend.wasmPaths = new URL("/ort/", self.location.origin).href;
  }

  return module;
}

/** Turn the raw byte counts that transformers.js reports into one progress line. */
function reportProgress(files: Map<string, { loaded: number; total: number }>) {
  return (event: { status?: string; file?: string; loaded?: number; total?: number }): void => {
    if (event.status !== "progress" || event.file === undefined) return;
    files.set(event.file, { loaded: event.loaded ?? 0, total: event.total ?? 0 });
    let loaded = 0;
    let total = 0;
    let known = true;
    for (const file of files.values()) {
      loaded += file.loaded;
      if (file.total > 0) total += file.total;
      else known = false;
    }
    post({
      kind: "progress",
      phase: "downloading",
      loaded,
      total,
      fraction: known && total > 0 ? Math.min(loaded / total, 1) : undefined,
      file: event.file,
    });
  };
}

async function load(
  plan: ModelPlan,
  text: TextPlan | undefined,
): Promise<{ textReady: boolean; textError: string | undefined }> {
  runtime ??= await loadRuntime();
  const { AutoModel, AutoProcessor, AutoTokenizer, CLIPSegForImageSegmentation } = runtime;
  const progress_callback = reportProgress(new Map());

  const model = await AutoModel.from_pretrained(plan.repo, {
    dtype: { vision_encoder: plan.encoderDtype, prompt_encoder_mask_decoder: plan.decoderDtype },
    device: plan.backend,
    progress_callback,
  });
  const processor = await AutoProcessor.from_pretrained(plan.repo, { progress_callback });
  sam = { model, processor, needsPoint: plan.id === "slimsam-77" };

  if (!text) return { textReady: false, textError: undefined };
  // The text model is a separate download. A failure here must not take the
  // click and box path down with it, but the reason must reach the panel.
  try {
    const [model, processor, tokenizer] = await Promise.all([
      CLIPSegForImageSegmentation.from_pretrained(text.repo, {
        dtype: text.dtype,
        device: text.backend,
        progress_callback,
      }),
      AutoProcessor.from_pretrained(text.repo, { progress_callback }),
      AutoTokenizer.from_pretrained(text.repo, { progress_callback }),
    ]);
    clipseg = { model, processor, tokenizer };
    return { textReady: true, textError: undefined };
  } catch (error) {
    clipseg = undefined;
    return { textReady: false, textError: messageOf(error) };
  }
}

/**
 * Build the three-channel image the encoder expects.
 *
 * The model learned on photographs, so a cut goes in as the picture a reader
 * sees after the window transform, copied across red, green and blue.
 */
function toImage(
  gray: Uint8Array,
  width: number,
  height: number,
): InstanceType<Transformers["RawImage"]> {
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < gray.length; i += 1) {
    const value = gray[i]!;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value;
    rgb[i * 3 + 2] = value;
  }
  return new runtime!.RawImage(rgb, width, height, 3);
}

/**
 * Free the GPU buffers of a set of tensors.
 *
 * Growing an object encodes one picture per slice. Without this, every
 * embedding of every slice stays on the GPU: a walk of 25 slices took 720 ms
 * for the first slice and 5.8 s for the last one. Measured 2026-08-02.
 */
function release(tensors: Record<string, unknown> | undefined): void {
  if (!tensors) return;
  for (const value of Object.values(tensors)) {
    (value as { dispose?: () => void })?.dispose?.();
  }
}

async function encode(gray: Uint8Array, width: number, height: number): Promise<void> {
  if (!sam || !runtime) throw new Error("the model is not loaded");
  const image = toImage(gray, width, height);
  const inputs = (await sam.processor(image)) as Record<string, unknown>;
  const embeddings = (await (
    sam.model as unknown as {
      get_image_embeddings: (input: unknown) => Promise<Record<string, unknown>>;
    }
  ).get_image_embeddings(inputs)) as Record<string, unknown>;
  release(encoded?.embeddings);
  release(encoded?.inputs);
  encoded = { inputs, embeddings, image, width, height };
}

function centreOf(box: BoxPrompt): PointPrompt {
  return {
    kind: "point",
    x: (box.x0 + box.x1) / 2,
    y: (box.y0 + box.y1) / 2,
    positive: true,
  };
}

async function decode(
  points: readonly PointPrompt[],
  box: BoxPrompt | undefined,
): Promise<{ width: number; height: number; data: Uint8Array; score: number }> {
  if (!sam || !runtime || !encoded) throw new Error("no cut is encoded");
  const { processor, model } = sam;

  const usePoints = points.length > 0 || (sam.needsPoint && box !== undefined);
  const filled = points.length > 0 ? points : box ? [centreOf(box)] : [];

  const options: Record<string, unknown> = {};
  if (usePoints) {
    options["input_points"] = [[filled.map((point) => [point.x, point.y])]];
    options["input_labels"] = [[filled.map((point) => (point.positive ? 1 : 0))]];
  }
  if (box) options["input_boxes"] = [[[box.x0, box.y0, box.x1, box.y1]]];

  const prompt = (await processor(encoded.image, options)) as Record<string, unknown>;
  const output = (await (model as unknown as (input: unknown) => Promise<Record<string, unknown>>)({
    ...encoded.inputs,
    ...encoded.embeddings,
    ...prompt,
  })) as {
    pred_masks: unknown;
    iou_scores: { data: Float32Array };
    object_score_logits?: unknown;
  };

  const masks = (await (
    processor as unknown as {
      post_process_masks: (
        masks: unknown,
        original: unknown,
        reshaped: unknown,
      ) => Promise<{ dims: number[]; data: Uint8Array }[]>;
    }
  ).post_process_masks(
    output.pred_masks,
    prompt["original_sizes"],
    prompt["reshaped_input_sizes"],
  )) as { dims: number[]; data: Uint8Array }[];

  // The decoder returns three candidates per prompt. Keep the one it rates
  // highest; the other two are usually a part and a whole of the same thing.
  const scores = output.iou_scores.data;
  let best = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i]! > scores[best]!) best = i;
  }

  const mask = masks[0]!;
  const height = mask.dims[mask.dims.length - 2]!;
  const width = mask.dims[mask.dims.length - 1]!;
  const data = new Uint8Array(width * height);
  const offset = best * width * height;
  for (let i = 0; i < data.length; i += 1) data[i] = mask.data[offset + i] ? 1 : 0;

  release(prompt);
  release(output as unknown as Record<string, unknown>);
  return { width, height, data, score: scores[best] ?? 0 };
}

/** Keep the pixels of the heat map at 60% of its own peak, or more. */
const HOT_SHARE = 0.6;

/**
 * Find a box for a phrase.
 *
 * CLIPSeg resizes the picture to a square 352 by 352 and returns one score per
 * pixel of that square. Padding the cut to a square first makes the way back a
 * single scale factor, with no aspect correction to get wrong.
 *
 * Exactly one phrase goes in per run. The export ties the text batch to the
 * image batch, and two phrases against one picture stop with a shape mismatch.
 */
async function detectBoxes(text: string): Promise<readonly DetectedBox[]> {
  if (!clipseg || !runtime || !encoded) throw new Error("the text model is not loaded");
  const side = Math.max(encoded.width, encoded.height);
  const square = new Uint8ClampedArray(side * side * 3);
  const source = encoded.image.data;
  for (let y = 0; y < encoded.height; y += 1) {
    const from = y * encoded.width * 3;
    square.set(source.subarray(from, from + encoded.width * 3), y * side * 3);
  }
  const padded = new runtime.RawImage(square, side, side, 3);

  const { model, processor, tokenizer } = clipseg;
  const textInputs = tokenizer([text], { padding: true, truncation: true });
  const imageInputs = await processor(padded);
  const output = (await (model as unknown as (input: unknown) => Promise<Record<string, unknown>>)({
    ...textInputs,
    ...imageInputs,
  })) as { logits: { dims: number[]; data: Float32Array } };

  const heat = output.logits;
  const heatWidth = heat.dims[heat.dims.length - 1]!;
  const heatHeight = heat.dims[heat.dims.length - 2]!;
  const scores = new Float32Array(heatWidth * heatHeight);
  let peak = 0;
  for (let i = 0; i < scores.length; i += 1) {
    // The head returns logits. A sigmoid turns them into 0 to 1.
    const value = 1 / (1 + Math.exp(-heat.data[i]!));
    scores[i] = value;
    if (value > peak) peak = value;
  }

  const bounds = maskBounds(thresholdHeatmap(scores, heatWidth, heatHeight, HOT_SHARE));
  if (!bounds) return [];

  const scale = side / heatWidth;
  const box = {
    x0: Math.max(0, Math.min(bounds.x0 * scale, encoded.width)),
    y0: Math.max(0, Math.min(bounds.y0 * scale, encoded.height)),
    x1: Math.max(0, Math.min(bounds.x1 * scale, encoded.width)),
    y1: Math.max(0, Math.min(bounds.y1 * scale, encoded.height)),
    score: peak,
  };
  return box.x1 - box.x0 >= 2 && box.y1 - box.y0 >= 2 ? [box] : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.kind) {
        case "load": {
          post({
            kind: "progress",
            phase: "downloading",
            loaded: 0,
            total: 0,
            fraction: 0,
            file: undefined,
          });
          const text = await load(request.plan, request.text);
          post({ kind: "loaded", id: request.id, ...text });
          return;
        }
        case "encode": {
          post({
            kind: "progress",
            phase: "encoding",
            loaded: 0,
            total: 0,
            fraction: undefined,
            file: undefined,
          });
          await encode(request.gray, request.width, request.height);
          post({ kind: "encoded", id: request.id });
          return;
        }
        case "decode": {
          const mask = await decode(request.points, request.box);
          post({ kind: "mask", id: request.id, ...mask }, [mask.data.buffer]);
          return;
        }
        case "detect": {
          post({
            kind: "progress",
            phase: "detecting",
            loaded: 0,
            total: 0,
            fraction: undefined,
            file: undefined,
          });
          post({ kind: "boxes", id: request.id, boxes: await detectBoxes(request.text) });
          return;
        }
        case "dispose": {
          encoded = undefined;
          sam = undefined;
          clipseg = undefined;
          post({ kind: "loaded", id: request.id, textReady: false, textError: undefined });
          return;
        }
      }
    } catch (error) {
      post({ kind: "failed", id: request.id, message: messageOf(error) });
    }
  })();
});
