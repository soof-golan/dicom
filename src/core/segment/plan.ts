/**
 * Which model to download, and on which backend.
 *
 * Finding out what a machine can do touches the browser, so it lives in the
 * shell. Deciding what to do about it is arithmetic, so it lives here and has
 * tests.
 *
 * Every byte count comes from the Hugging Face file listing of the named repo.
 * The listings were read on 2026-08-02.
 */

export type Backend = "webgpu" | "wasm";

export type ModelId = "sam3-tracker" | "sam2.1-hiera-tiny" | "slimsam-77";

/**
 * The weight formats that the runtime accepts.
 *
 * These names are the ones transformers.js maps to a file suffix. `q8` reads
 * `*_quantized.onnx`, and `fp32` reads the plain `*.onnx`.
 */
export type Dtype = "fp32" | "fp16" | "int8" | "uint8" | "q8" | "q4" | "q4f16" | "bnb4";

/** What the browser reports about itself. */
export interface Capability {
  readonly hasWebGpu: boolean;
  /** The largest single storage buffer a shader can bind, in bytes. */
  readonly maxStorageBufferBindingSize: number;
  readonly mobile: boolean;
}

export interface ModelPlan {
  readonly id: ModelId;
  /** The Hugging Face repo that holds the ONNX graphs. */
  readonly repo: string;
  readonly backend: Backend;
  readonly encoderDtype: Dtype;
  /**
   * Always `fp32`. The decoder makes the mask logits, and it costs 20 MB.
   * Quantizing it moves a boundary by a pixel or two for no useful saving.
   */
  readonly decoderDtype: "fp32";
  readonly bytes: number;
  readonly label: string;
  /** True when the masks are known to be worse than the first choice. */
  readonly reduced: boolean;
}

/** The text model that turns a phrase into boxes. */
export interface TextPlan {
  readonly repo: string;
  readonly backend: Backend;
  readonly dtype: Dtype;
  readonly bytes: number;
  readonly label: string;
}

/** The default WebGPU floor. A device below this cannot hold the SAM 3 encoder. */
export const MIN_STORAGE_BUFFER = 134_217_728;

const SAM3: ModelPlan = {
  id: "sam3-tracker",
  repo: "onnx-community/sam3-tracker-ONNX",
  backend: "webgpu",
  encoderDtype: "q4",
  decoderDtype: "fp32",
  // vision_encoder_q4: 1,320,396 + 368,954,368. decoder: 213,114 + 22,072,320.
  bytes: 392_560_198,
  label: "SAM 3 tracker",
  reduced: false,
};

const SAM2_TINY: ModelPlan = {
  id: "sam2.1-hiera-tiny",
  repo: "onnx-community/sam2.1-hiera-tiny-ONNX",
  backend: "webgpu",
  encoderDtype: "q4f16",
  decoderDtype: "fp32",
  // vision_encoder_q4f16: 327,108 + 28,532,736. decoder: 213,114 + 20,958,208.
  bytes: 50_031_166,
  label: "SAM 2.1 tiny",
  reduced: true,
};

const SLIMSAM: ModelPlan = {
  id: "slimsam-77",
  repo: "Xenova/slimsam-77-uniform",
  backend: "wasm",
  encoderDtype: "q8",
  decoderDtype: "fp32",
  // vision_encoder_quantized: 8,882,165. decoder: 16,557,892.
  bytes: 25_440_057,
  label: "SlimSAM 77",
  reduced: true,
};

/**
 * The text model.
 *
 * OWLv2 finds boxes from a phrase. SAM turns a box into a mask. Chaining the
 * two is the standard "grounded SAM" pattern, and it is the only text route
 * with published, ungated ONNX weights that transformers.js can load.
 *
 * `onnx/model_q4f16.onnx` is 128,434,817 bytes. The tokenizer adds 3.6 MB.
 */
const OWLV2: TextPlan = {
  repo: "Xenova/owlv2-base-patch16-ensemble",
  backend: "webgpu",
  dtype: "q4f16",
  bytes: 132_046_418,
  label: "OWLv2 base",
};

/**
 * Pick a model, or nothing when the machine cannot run one usefully.
 *
 * The fallback is a smaller model, never the same model on a slower backend.
 * SAM 3 on WebAssembly takes minutes for one cut, which is a failure with a
 * progress bar on top of it.
 */
export function planFor(capability: Capability): ModelPlan | undefined {
  if (capability.hasWebGpu) {
    return capability.maxStorageBufferBindingSize >= MIN_STORAGE_BUFFER ? SAM3 : SAM2_TINY;
  }
  return capability.mobile ? undefined : SLIMSAM;
}

/** The text model for a plan, or nothing when the backend cannot carry it. */
export function textPlanFor(plan: ModelPlan | undefined): TextPlan | undefined {
  if (!plan || plan.backend !== "webgpu") return undefined;
  return OWLV2;
}

/** Bytes as a short string, for a button that must state the real cost. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** Combine per-file byte counts into one fraction, or nothing when unknown. */
export function combineProgress(files: ReadonlyMap<string, { loaded: number; total: number }>): {
  loaded: number;
  total: number;
  fraction: number | undefined;
} {
  let loaded = 0;
  let total = 0;
  let known = true;
  for (const file of files.values()) {
    loaded += file.loaded;
    if (file.total > 0) total += file.total;
    else known = false;
  }
  return { loaded, total, fraction: known && total > 0 ? Math.min(loaded / total, 1) : undefined };
}
