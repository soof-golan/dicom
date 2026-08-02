# SAM integration plan for this repo

Date: 2026-08-02.
Companion document: `sam-web-inference.md`. Read that first for the evidence.
Written in ASD-STE100 Simplified Technical English (pragmatic mode).

This document defines types and signatures only. It contains no implementation.

---

## 1. Decisions

| Question       | Decision                                                |
| -------------- | ------------------------------------------------------- |
| Model          | `onnx-community/sam3-tracker-ONNX`                      |
| Runtime        | `@huggingface/transformers`, WebGPU device              |
| Prompt types   | Box and point. **No text.**                             |
| Encoder dtype  | `q4`                                                    |
| Decoder dtype  | `fp32`                                                  |
| Download       | 393 MB                                                  |
| Weight host    | Cloudflare R2, custom domain                            |
| Fallback model | `onnx-community/sam2.1-hiera-tiny-ONNX`, `q4f16`, 34 MB |
| Load timing    | Lazy, after a user gesture                              |

Text prompts are out of scope. Section 3 of the research document gives the measured reason.

---

## 2. Packages

Add two dependencies at the start of the work. Do not add them before then.

| Package                     | Version    | Reason                                  |
| --------------------------- | ---------- | --------------------------------------- |
| `@huggingface/transformers` | `^4.2.0`   | SAM 3 tracker, WebGPU device, Cache API |
| `@types/dom-webcodecs`      | not needed | -                                       |

`onnxruntime-web` arrives as a transitive dependency of `@huggingface/transformers`. Do not add it directly.
A direct dependency risks two copies of the WASM runtime in one bundle.

No other package is required. `three`, `nuqs` and `zustand` already cover rendering, URL state and app state.

### Bundle rule

`@huggingface/transformers` must never enter the main chunk.
Import it with a dynamic `import()` inside the worker file only.
Add a build assertion that fails when the entry chunk grows past its budget.

---

## 3. Module boundary

The repo follows "functional core, imperative shell".
SAM splits cleanly along that line because the model is a pure function of pixels and prompts.

### `src/core/sam/` - pure, tested, no I/O

No `fetch`, no `GPUDevice`, no `Worker`, no React. Every function is deterministic and synchronous.

| File             | Holds                                                            |
| ---------------- | ---------------------------------------------------------------- |
| `types.ts`       | All shared types. No runtime code.                               |
| `preprocess.ts`  | Window/level to RGB. Letterbox to 1008x1008. Coordinate scaling. |
| `postprocess.ts` | Logits to a binary mask. Mask to contour polygons. Mask area.    |
| `prompt.ts`      | Prompt list operations. Add, remove, toggle a point label.       |
| `selection.ts`   | Pick the best mask from three candidates by IoU score.           |
| `capability.ts`  | Map a capability report to a model plan. Pure decision logic.    |
| `progress.ts`    | Combine per-file byte counts into one progress value.            |

`capability.ts` deserves a note. The **detection** of WebGPU is impure and lives in the shell.
The **decision** that follows from the detection is pure and lives here. This makes model choice testable.

### `src/shell/sam/` - imperative, untested by unit tests

| File                   | Holds                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| `sam.worker.ts`        | The worker entry. Owns the model and the GPU.                               |
| `SamClient.ts`         | The main-thread handle. Owns the worker, the message port and cancellation. |
| `capability.detect.ts` | Reads `navigator.gpu`, adapter limits and `navigator.storage`.              |
| `cache.ts`             | Calls `navigator.storage.persist()` and `estimate()`.                       |
| `useSam.ts`            | React 19 hook. Binds `SamClient` to component state.                        |
| `protocol.ts`          | The worker message union. Shared by both sides.                             |

### Why a worker, and why our own one

Two hard constraints force this design:

1. The encoder pass takes 1 to 5 s. On the main thread it freezes the viewer.
2. The ONNX Runtime docs state: "The proxy worker cannot work with WebGPU EP.
   This is because a GPU buffer is not transferable."

So `env.wasm.proxy` must stay off, and we must create the worker ourselves.
WebGPU works inside a dedicated worker, so this is a supported path.

### Data across the boundary

Send `ArrayBuffer` and typed arrays. Transfer them, do not copy them.
Never send a `GPUBuffer` or a `GPUTexture`. They are not transferable.

---

## 4. Public API surface

Types and signatures only.

### `src/core/sam/types.ts`

```ts
/** A point prompt in image pixel coordinates. */
export type SamPoint = {
  readonly x: number;
  readonly y: number;
  /** 1 includes the region. 0 excludes it. */
  readonly label: 0 | 1;
};

/** A box prompt in image pixel coordinates. */
export type SamBox = {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
};

export type SamPrompt = {
  readonly points: readonly SamPoint[];
  readonly box: SamBox | null;
};

/** One grayscale slice after window/level, before model preprocessing. */
export type SliceImage = {
  readonly width: number;
  readonly height: number;
  /** 8-bit grayscale, length = width * height. */
  readonly gray: Uint8Array;
};

/** Model input after letterbox and normalization. */
export type EncoderInput = {
  readonly data: Float32Array;
  readonly width: 1008;
  readonly height: 1008;
  readonly scale: number;
  readonly padX: number;
  readonly padY: number;
};

export type SamMask = {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel. 0 or 1. */
  readonly data: Uint8Array;
  /** Model IoU estimate, 0 to 1. */
  readonly score: number;
};

export type SamModelId = "sam3-tracker" | "sam2.1-hiera-tiny" | "slimsam-77";

export type SamDevice = "webgpu" | "wasm";

export type SamPlan = {
  readonly modelId: SamModelId;
  readonly device: SamDevice;
  readonly encoderDtype: "q4" | "q4f16" | "fp16" | "q8";
  readonly decoderDtype: "fp32";
  readonly downloadBytes: number;
};

export type GpuCapability = {
  readonly hasWebGpu: boolean;
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly quotaBytes: number;
  readonly usageBytes: number;
};

export type SamPhase =
  "idle" | "downloading" | "compiling" | "encoding" | "ready" | "decoding" | "error";

export type SamProgress = {
  readonly phase: SamPhase;
  /** 0 to 1. null when the total is unknown. */
  readonly fraction: number | null;
  readonly loadedBytes: number;
  readonly totalBytes: number | null;
  readonly file: string | null;
};

export type SamError =
  | { readonly kind: "no-webgpu" }
  | { readonly kind: "out-of-memory"; readonly requestedBytes: number }
  | { readonly kind: "download-failed"; readonly status: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unknown"; readonly message: string };
```

### `src/core/sam/` function signatures

```ts
// preprocess.ts
export function toEncoderInput(image: SliceImage): EncoderInput;
export function promptToModelSpace(prompt: SamPrompt, input: EncoderInput): SamPrompt;

// postprocess.ts
export function logitsToMask(
  logits: Float32Array,
  input: EncoderInput,
  target: { width: number; height: number },
  threshold: number,
): SamMask;
export function maskToPolygons(mask: SamMask): readonly (readonly number[])[];
export function maskAreaPixels(mask: SamMask): number;

// selection.ts
export function pickBestMask(masks: readonly SamMask[]): SamMask;

// prompt.ts
export function emptyPrompt(): SamPrompt;
export function addPoint(prompt: SamPrompt, point: SamPoint): SamPrompt;
export function removeLastPoint(prompt: SamPrompt): SamPrompt;
export function setBox(prompt: SamPrompt, box: SamBox | null): SamPrompt;
export function isPromptUsable(prompt: SamPrompt): boolean;

// capability.ts
export function planFor(capability: GpuCapability): SamPlan;
export function isPlanAffordable(plan: SamPlan, capability: GpuCapability): boolean;

// progress.ts
export function combineProgress(
  files: ReadonlyMap<string, { loaded: number; total: number | null }>,
  phase: SamPhase,
): SamProgress;
```

### `src/shell/sam/SamClient.ts`

```ts
export type SamClientOptions = {
  readonly plan: SamPlan;
  readonly weightsBaseUrl: string;
  readonly onProgress: (progress: SamProgress) => void;
};

export declare class SamClient {
  /** Starts the worker. Does NOT download weights. */
  static create(options: SamClientOptions): Promise<SamClient>;

  /** Downloads and compiles the model. Rejects with SamError. */
  load(signal: AbortSignal): Promise<void>;

  /** Runs the vision encoder once for one slice. Cancellable. */
  encodeSlice(image: SliceImage, signal: AbortSignal): Promise<void>;

  /** Runs the decoder for the current slice. Fast. Call per click. */
  segment(prompt: SamPrompt, signal: AbortSignal): Promise<SamMask>;

  /** Frees GPU buffers and stops the worker. */
  dispose(): Promise<void>;

  readonly phase: SamPhase;
}
```

The split between `encodeSlice` and `segment` is the whole performance story.
`encodeSlice` is slow and runs once per slice. `segment` is fast and runs per click.

### `src/shell/sam/useSam.ts`

```ts
export type UseSamResult = {
  readonly progress: SamProgress;
  readonly error: SamError | null;
  readonly mask: SamMask | null;
  readonly isAvailable: boolean;
  /** Starts the download. Call from a user gesture only. */
  readonly enable: () => void;
  readonly cancel: () => void;
  readonly segment: (prompt: SamPrompt) => void;
};

export declare function useSam(slice: SliceImage | null): UseSamResult;
```

---

## 5. Lazy loading

SAM must never delay first paint. Four rules give that result.

1. **No static import.** `@huggingface/transformers` appears in `sam.worker.ts` only, behind `await import()`.
2. **No worker at startup.** `SamClient.create()` runs when the user opens the segmentation panel.
3. **No download without a gesture.** `load()` runs only after the user selects "Enable segmentation".
4. **No capability probe at startup.** `navigator.gpu.requestAdapter()` costs time. Run it with the panel.

### The five states

| State   | Trigger                           | Cost                           |
| ------- | --------------------------------- | ------------------------------ |
| Absent  | Page load                         | 0 bytes, 0 ms                  |
| Probed  | User opens the segmentation panel | One adapter request            |
| Offered | Probe succeeds                    | UI shows the size and a button |
| Loading | User selects the button           | 393 MB, cancellable            |
| Ready   | Compilation completes             | Clicks return masks            |

The "Offered" state must state the real cost. Example text:
"Segmentation needs a 393 MB download. It stays on this device."

### Vite chunking

The worker becomes its own chunk through `new Worker(new URL("./sam.worker.ts", import.meta.url), { type: "module" })`.
Rolldown then keeps the worker graph out of the entry chunk. Do not import `protocol.ts` types with a value import.
Use `import type` on both sides, so no runtime edge joins the worker to the main chunk.

---

## 6. Progress and cancel contract

### Progress

`onProgress` fires for every phase. The consumer never computes percentages.

| Phase         | `fraction` | Note                                        |
| ------------- | ---------- | ------------------------------------------- |
| `downloading` | 0 to 1     | Needs `content-length` exposed by R2 CORS   |
| `compiling`   | `null`     | Shader compilation gives no progress events |
| `encoding`    | `null`     | One forward pass, 1 to 5 s                  |
| `decoding`    | `null`     | Under 100 ms. Show no progress UI.          |

Rule: when `fraction` is `null`, show an indeterminate indicator with a phase label.
Never show a fake percentage.

### Cancel

Every long call takes an `AbortSignal`. Three levels of cancellation apply:

1. **During download.** Abort the `fetch`. Partial files stay in the Cache API and resume later.
2. **During compilation.** Cannot abort. Let it finish, then discard the model.
   Tell the user "Finishing setup" and disable the cancel button.
3. **During encoding.** Cannot abort mid-pass. When the result lands, discard it.

State this in the UI. A cancel button that does nothing is worse than a disabled one.

On abort, `load()`, `encodeSlice()` and `segment()` reject with `{ kind: "cancelled" }`.

### Click coalescing

A user drags a box and generates many prompts per second.
`segment()` must drop stale requests. Keep the newest prompt only, and abort the one in flight.
The core stays pure. The coalescing logic lives in `SamClient`.

---

## 7. Fallback when WebGPU is missing

About one visitor in six has no WebGPU. Firefox on Linux and Intel Macs is the main gap.

`planFor()` decides. The decision is pure and testable:

| Condition                                                | Plan                                        |
| -------------------------------------------------------- | ------------------------------------------- |
| WebGPU present, `maxStorageBufferBindingSize` >= 128 MiB | `sam3-tracker`, `q4`, webgpu, 393 MB        |
| WebGPU present, limits below that                        | `sam2.1-hiera-tiny`, `q4f16`, webgpu, 34 MB |
| No WebGPU, desktop                                       | `slimsam-77`, `q8`, wasm, 14 MB             |
| No WebGPU, mobile                                        | Feature off. Show why.                      |

The key rule from the research: **the fallback is a smaller model, not the same model on a slower backend.**
SAM 3 on WASM takes minutes per slice. That is not a fallback. It is a failure with a spinner.

SlimSAM-77 at q8 is 14 MB and Apache-2.0. It is weaker than SAM 3, and it works everywhere.
Label its output clearly, so a user knows the quality differs.

WASM multi-threading needs COOP and COEP headers. We do not set them. See section 9 of the research document.
Single-threaded SlimSAM is acceptable at 14 MB.

---

## 8. Weight hosting

Copy the ONNX files from `onnx-community/sam3-tracker-ONNX` to R2. Do not fetch from the Hugging Face CDN at runtime.
Two reasons: we control availability, and we control the CORS headers.

Layout:

```
/models/sam3-tracker/onnx/vision_encoder_q4.onnx
/models/sam3-tracker/onnx/vision_encoder_q4.onnx_data
/models/sam3-tracker/onnx/prompt_encoder_mask_decoder.onnx
/models/sam3-tracker/onnx/prompt_encoder_mask_decoder.onnx_data
/models/sam3-tracker/config.json
/models/sam3-tracker/preprocessor_config.json
/models/sam3-tracker/LICENSE.txt
```

`LICENSE.txt` is required. The SAM License states that a copy must travel with the materials.

Set `env.remoteHost` to the R2 custom domain, so transformers.js reads from there.
Apply the CORS policy from section 9 of the research document, and expose `content-length`.

---

## 9. Test plan

The core is fully unit-testable with no mocks. This matches the repo rule against mocks.

| File             | Test                                                          |
| ---------------- | ------------------------------------------------------------- |
| `preprocess.ts`  | Known 4x4 gray input, exact expected Float32Array.            |
| `postprocess.ts` | Known logits, exact expected mask bytes and polygon.          |
| `selection.ts`   | Three masks with fixed scores, expect the highest.            |
| `capability.ts`  | Each capability row from section 7, expect the matching plan. |
| `progress.ts`    | Two files at known byte counts, expect the combined fraction. |
| `prompt.ts`      | Add, remove and toggle sequences.                             |

The shell needs a manual test, not a unit test. The check is one slice from the real elbow MRI study.
Draw a box around the annular ligament. Compare the mask with the anatomy. Record the result before any release.

---

## 10. Work order

1. Add `docs/research/` (this branch).
2. Copy the weights to R2. Set CORS. Add `LICENSE.txt`.
3. Write `src/core/sam/types.ts`. No runtime code.
4. Write the core functions test-first, in this order: `prompt`, `capability`, `progress`, `preprocess`, `postprocess`, `selection`.
5. Write `protocol.ts` and `sam.worker.ts`.
6. Write `SamClient.ts` with cancellation and coalescing.
7. Write `useSam.ts` and the panel UI.
8. Run the manual elbow MRI check.
9. Add the bundle-size assertion for the entry chunk.

Steps 3 and 4 need no network and no GPU. They can start immediately.
