# SAM in the browser over WebGPU: research findings

Date: 2026-08-02.
Scope: how to run a Segment Anything model locally in the browser, with WebGPU, for the DICOM/MRI viewer.
Written in ASD-STE100 Simplified Technical English (pragmatic mode).

---

## 1. Summary

SAM 3.1 is real. It exists and Meta released it on 2026-03-27.
But the feature as specified does not work. The blocker is text prompts, not WebGPU.

Three facts decide this:

1. Only the **SAM 3 tracker** has a published, quantized ONNX export that runs in a browser today.
   The tracker takes points and boxes. The tracker does not take text.
2. The text-prompt part of SAM 3 has **no official ONNX export** and **no transformers.js class**.
   transformers.js 4.2.0 ships `Sam3TrackerModel` only. There is no `Sam3Model`.
3. Text prompts fail on anatomy. The SAM 3 paper names medical terms as a known failure case.
   An independent paper measured vanilla SAM 3 text prompts at **11.9% Dice** on unseen medical data.

Terms like "radial collateral ligament" or "capitulum humeri" will not work. This is not a tuning problem.
SAM 3 learned 4M noun phrases from natural photographs. Elbow ligament names are not in that distribution.

### Recommendation

Ship **point-prompted and box-prompted segmentation**. Drop text prompts from the first release.

| Item           | Choice                                                          |
| -------------- | --------------------------------------------------------------- |
| Model          | `onnx-community/sam3-tracker-ONNX`                              |
| Runtime        | `@huggingface/transformers` 4.2.0, WebGPU device                |
| Encoder dtype  | `q4` (370.3 MB)                                                 |
| Decoder dtype  | `fp32` (22.3 MB)                                                |
| Total download | **393 MB** (374 MiB)                                            |
| Fallback model | `onnx-community/sam2.1-hiera-tiny-ONNX`, `q4f16`, 33.7 MB       |
| Biggest risk   | Grayscale MR slices are out of domain for a natural-image model |

This choice copies the official Hugging Face demo exactly. See section 4.

The second-best option is a 654 MiB community text export. Section 3 explains why it is not ready.

---

## 2. Question 1: Does SAM 3.1 exist? What are the real releases?

Yes. SAM 3.1 exists.

Meta published the SAM 3.1 blog post on 2026-03-27.
The main change is Object Multiplex. It tracks up to 16 objects in one forward pass.
Video throughput goes from 16 to 32 frames per second on one H100 GPU.
SAM 3.1 is a drop-in replacement for SAM 3.

### The full release list

| Release | Date       | Repo ID                                              | Params                    | License     | Text prompts |
| ------- | ---------- | ---------------------------------------------------- | ------------------------- | ----------- | ------------ |
| SAM 1   | 2023-04    | `facebook/sam-vit-huge`, `-large`, `-base`           | 636M / 308M / 91M         | Apache-2.0  | No           |
| SAM 2   | 2024-07    | `facebook/sam2-hiera-{tiny,small,base-plus,large}`   | 38.9M-224.4M              | Apache-2.0  | No           |
| SAM 2.1 | 2024-09    | `facebook/sam2.1-hiera-{tiny,small,base-plus,large}` | 38.9 / 46 / 80.8 / 224.4M | Apache-2.0  | No           |
| SAM 3   | 2025-11-19 | `facebook/sam3`                                      | 848M (card says 0.9B)     | SAM License | Yes          |
| SAM 3.1 | 2026-03-27 | `facebook/sam3.1`                                    | same architecture         | SAM License | Yes          |
| SAM 3D  | 2025-11-19 | `facebook/sam-3d-objects`, `facebook/sam-3d-body-*`  | n/a                       | SAM License | n/a          |

Both `facebook/sam3` and `facebook/sam3.1` are **gated with manual approval**.
The Hugging Face API reports `"gated": "manual"` for both.
A human at Meta must approve each request. An automated build cannot pull these weights.

### File sizes in the official repos

`facebook/sam3`:

| Bytes         | File                |
| ------------- | ------------------- |
| 3,439,938,512 | `model.safetensors` |
| 3,450,062,241 | `sam3.pt`           |
| 3,642,073     | `tokenizer.json`    |

`facebook/sam3.1`:

| Bytes         | File                  |
| ------------- | --------------------- |
| 3,502,755,717 | `sam3.1_multiplex.pt` |

Note: `facebook/sam3.1` has **no safetensors file**. Its `library_name` is `checkpoint`, not `transformers`.
SAM 3.1 is therefore one step further from a browser export than SAM 3.

### License terms and web redistribution

The SAM License is a custom Meta license, not Apache-2.0 or MIT.
The same 7,352-byte LICENSE file appears in `facebook/sam3` and `facebook/sam3.1`.

Redistribution **is permitted**. The grant is "non-exclusive, worldwide, non-transferable and royalty-free".
One condition applies: if you give the SAM Materials to a third party, you must include a copy of the Agreement.

For this project that means one rule. If we host the weights on Cloudflare R2, we must serve the SAM License
next to them, and we must link it from the UI.

Prohibited uses are military, warfare, nuclear, espionage, weapons, and reverse engineering.
The license text has **no medical or healthcare restriction**.

Sources:

- https://ai.meta.com/blog/segment-anything-model-3/
- https://github.com/facebookresearch/sam3
- https://github.com/facebookresearch/sam3/blob/main/LICENSE
- https://huggingface.co/facebook/sam3
- https://huggingface.co/facebook/sam3.1
- https://github.com/facebookresearch/sam2
- https://arxiv.org/abs/2511.16719

---

## 3. Question 2: Text prompts and the anatomical vocabulary

**Blunt answer: text prompts will not segment named anatomy. Do not ship this feature.**

### Which variants take text

Only SAM 3 and SAM 3.1 take text. SAM 1, SAM 2, and SAM 2.1 take points, boxes, and masks only.

SAM 3 splits into two tasks:

- **PCS** (Promptable Concept Segmentation). Takes a short noun phrase or an image exemplar. Finds every instance.
- **PVS** (Promptable Visual Segmentation). Takes points, boxes, or masks. This is the SAM 2 successor.

Text lives in PCS only. The ONNX export that runs in a browser is the PVS tracker. See section 4.

### The vocabulary is natural photographs

SAM 3 trained on SA-Co. The training set holds **4M unique noun phrases**.
The benchmark holds 207K unique phrases. The phrases come from photographs and video, not from radiology.

The SAM 3 paper states its own limit in section 8. The model "struggles to generalize to out-of-domain terms".
The paper names two examples of fine-grained out-of-domain concepts: **aircraft types and medical terms**.

### The measured number

The Medical SAM3 paper measured vanilla SAM 3 with text prompts on medical images:

| Setting                          | SAM 3 baseline Dice | After medical fine-tune |
| -------------------------------- | ------------------- | ----------------------- |
| Internal validation, 10 datasets | 54.0%               | 77.0%                   |
| External validation, 7 datasets  | **11.9%**           | 73.9%                   |

11.9% Dice is not a weak result. It is a failed result.
The paper attributes this to "weak text-visual alignment" in the baseline.

Two further points make the case worse for this project:

1. Medical SAM3 tested ultrasound, endoscopy, fundus, dermoscopy, pathology, X-ray and microscopy.
   It did **not** isolate MRI or CT results. Musculoskeletal MRI was not part of the evaluation.
2. An independent 3D medical benchmark covered 16 datasets, 54 anatomical structures, CT, MRI and ultrasound.
   That study evaluated SAM 3 in **PVS mode only** - clicks, boxes and masks.
   The authors did not evaluate text prompts on medical data at all.

The second point is the strongest signal. Researchers who benchmark SAM on radiology do not use text prompts.

### What this means for the elbow MRI use case

"radial collateral ligament", "annular ligament" and "capitulum humeri" are fine-grained anatomical terms.
They are exactly the class of term the SAM 3 authors flag as a failure mode.
The model has no grounding between these phrases and grayscale MR texture.

A user who types "annular ligament" will get an empty mask or a wrong region. Both outcomes are worse than no feature.

Sources:

- https://arxiv.org/abs/2511.16719 (SAM 3 paper, limitations)
- https://arxiv.org/html/2511.16719v1
- https://arxiv.org/abs/2601.10880 (Medical SAM3)
- https://arxiv.org/html/2601.10880v1
- https://arxiv.org/abs/2511.21926 (SAM 2 vs SAM 3, 3D medical, PVS only)

---

## 4. Question 3: Browser inference paths

### Path A: transformers.js (recommended)

Package: `@huggingface/transformers`, latest 4.2.0, published 2026-04-22.

transformers.js exposes exactly two SAM 3 symbols. A grep of the 4.2.0 bundle returns:

```
Sam3ImageProcessor
Sam3TrackerModel
```

There is no `Sam3Model`. Text prompting through transformers.js is **not possible today**.

`Sam3TrackerModel` works and is proven. Hugging Face publishes a reference demo:
`webml-community/SAM3-Tracker-WebGPU`. Its loader is 12 lines:

```js
const model_id = "onnx-community/sam3-tracker-ONNX";
model = await Sam3TrackerModel.from_pretrained(model_id, {
  dtype: {
    vision_encoder: "q4",
    prompt_encoder_mask_decoder: "fp32",
  },
  device: "webgpu",
});
processor = await AutoProcessor.from_pretrained(model_id);
```

The model takes `input_points`, `input_labels` and `input_boxes`. It returns `pred_masks` and `iou_scores`.
Its config reports `"model_type": "sam3_tracker"` and `"image_size": 1008`.

`onnx-community/sam3-tracker-ONNX` is **not gated**. Anyone can download it without approval.
Its `base_model` is `facebook/sam3`, so the SAM License follows the weights.

### Path B: onnxruntime-web with the WebGPU EP

Package: `onnxruntime-web`, latest 1.27.0, published 2026-06-19.

This is the only path to text prompts. It needs a text-capable ONNX export, and only community exports exist.

`danilobukvic/sam3-text-onnx` (last change 2026-05-28) is the best of them. It holds three graphs:
a vision encoder, a text encoder, and a decoder. It also holds the export and quantization scripts.

Its author states the position clearly: transformers.js "only has Sam3TrackerModel (point/box) but not Sam3Model",
so browser users must call `onnxruntime-web` directly.

Known limits of that export:

- Fixed 1008x1008 input. The positional embeddings are precomputed.
- **Text only.** Box and point prompts are not supported.
- The fp16 export is broken. A type mismatch fails in the decoder.
- fp32 needs more than 4 GB of VRAM. Softmax buffers reach about 1.7 GB.

The repo has **0 downloads**. Nobody has validated it in production. We become the first user.

### Path C: WebGPU-native ports

No native WGSL or wgpu port of any SAM model has published weights and a maintained API.
The community work targets ONNX or MLX. Three MLX repos exist (`mlx-community/sam3-bf16`, `-4bit`, `-mxfp8`),
but MLX runs on Apple Silicon natively, not in a browser.

### Verdict

Path A has working, published, quantized weights **today**, plus a first-party demo.
Path B has weights but no validation, no transformers.js support, and text prompts that fail on anatomy.
Path C does not exist.

Sources:

- https://www.npmjs.com/package/@huggingface/transformers
- https://huggingface.co/onnx-community/sam3-tracker-ONNX
- https://huggingface.co/spaces/webml-community/SAM3-Tracker-WebGPU
- https://www.npmjs.com/package/onnxruntime-web
- https://huggingface.co/danilobukvic/sam3-text-onnx
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html

---

## 5. Question 4: Model sizes and the encoder/decoder split

Every SAM model splits into two graphs:

- **Vision encoder.** Runs once per image. Holds almost all the weights.
- **Prompt encoder plus mask decoder.** Runs once per click. Small and fast.

This split is why interactive clicking is cheap. Only the first pass over a slice costs real time.

### `onnx-community/sam3-tracker-ONNX` (recommended)

Byte counts come from the Hugging Face file listing. Each row adds the `.onnx` graph and its `.onnx_data` weights.

| dtype             | Vision encoder | Decoder    | Total                   |
| ----------------- | -------------- | ---------- | ----------------------- |
| fp32              | 1,870,741,928  | 22,285,434 | 1,893,027,362 (1.89 GB) |
| fp16              | 935,992,733    | 11,240,876 | 947,233,609 (947 MB)    |
| int8 / q8 / uint8 | 528,670,397    | 10,066,013 | 538,736,410 (539 MB)    |
| bnb4              | 342,490,428    | 8,212,347  | 350,702,775 (351 MB)    |
| q4                | 370,274,764    | 8,470,668  | 378,745,432 (379 MB)    |
| q4f16             | 296,930,472    | 5,364,622  | 302,295,094 (302 MB)    |

The official demo mixes dtypes: `q4` encoder plus `fp32` decoder.
That combination totals **392,560,198 bytes (393 MB, 374 MiB)**. We recommend the same mix.

The decoder is 22 MB at fp32. Quantizing it saves 14 MB and adds mask-boundary error. It is not worth it.

### `onnx-community/sam2.1-hiera-tiny-ONNX` (fallback)

| dtype | Vision encoder | Decoder    | Total                |
| ----- | -------------- | ---------- | -------------------- |
| fp32  | 134,439,102    | 21,171,322 | 155,610,424 (156 MB) |
| fp16  | 67,320,429     | 10,683,815 | 78,004,244 (78 MB)   |
| int8  | 53,013,511     | 8,951,901  | 61,965,412 (62 MB)   |
| q4    | 44,124,937     | 7,356,556  | 51,481,493 (51 MB)   |
| q4f16 | 28,859,844     | 4,807,566  | 33,667,410 (34 MB)   |

### `Xenova/slimsam-77-uniform` (minimum viable)

SlimSAM-77 is a pruned SAM 1. It is Apache-2.0 and has 54,612 downloads. Single-file graphs, no `.onnx_data`.

| dtype          | Vision encoder | Decoder    | Total              |
| -------------- | -------------- | ---------- | ------------------ |
| fp32           | 23,276,014     | 16,557,892 | 39,833,906 (40 MB) |
| fp16           | 12,170,657     | 8,550,118  | 20,720,775 (21 MB) |
| quantized (q8) | 8,882,165      | 4,903,810  | 13,785,975 (14 MB) |

14 MB is small enough to preload with the viewer. Mask quality is lower than SAM 2.1 and much lower than SAM 3.

### `danilobukvic/sam3-text-onnx` (text path, not recommended)

This export has a third graph: a text encoder.

| dtype | Vision encoder | Text encoder  | Decoder    | Total                         |
| ----- | -------------- | ------------- | ---------- | ----------------------------- |
| fp32  | 1,841,695,256  | 1,416,014,936 | 95,951,921 | 3,353,662,113 (3.35 GB)       |
| int8  | 496,047,770    | 357,021,801   | 26,804,694 | 879,874,265 (880 MB)          |
| int4  | 298,668,062    | 367,189,722   | 19,809,839 | 685,667,623 (686 MB, 654 MiB) |

The text encoder is large. At int4 it is bigger than the vision encoder.
SAM 3 uses a 353M-parameter text tower, and 4-bit weights do not compress the embedding tables well.

### Full comparison table

| Model                                    | Params        | ONNX today     | Smallest browser size | License      | Text prompts          | Gated           |
| ---------------------------------------- | ------------- | -------------- | --------------------- | ------------ | --------------------- | --------------- |
| `onnx-community/sam3-tracker-ONNX`       | ~467M encoder | Yes            | 302 MB (q4f16)        | SAM License  | **No**                | No              |
| `danilobukvic/sam3-text-onnx`            | 848M          | Yes, community | 686 MB (int4)         | SAM License  | Yes, fails on anatomy | No              |
| `facebook/sam3` / `sam3.1`               | 848M          | No             | n/a                   | SAM License  | Yes                   | **Yes, manual** |
| `vil-uob/sam3-litetext-s0`               | ~0.5B         | No             | n/a                   | Apache-2.0   | Yes                   | No              |
| `onnx-community/sam2.1-hiera-tiny-ONNX`  | 38.9M         | Yes            | 34 MB (q4f16)         | Apache-2.0   | No                    | No              |
| `onnx-community/sam2.1-hiera-large-ONNX` | 224.4M        | Yes            | not measured          | Apache-2.0   | No                    | No              |
| `Xenova/slimsam-77-uniform`              | 77M           | Yes            | 14 MB (q8)            | Apache-2.0   | No                    | No              |
| `wanglab/MedSAM2`                        | 38.9M         | **No**         | n/a                   | CC-BY-SA-4.0 | No                    | No              |

Sources:

- https://huggingface.co/onnx-community/sam3-tracker-ONNX/tree/main/onnx
- https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/tree/main/onnx
- https://huggingface.co/Xenova/slimsam-77-uniform/tree/main/onnx
- https://huggingface.co/danilobukvic/sam3-text-onnx/tree/main
- https://huggingface.co/vil-uob/sam3-litetext-s0

---

## 6. Question 5: Quantization, published versus self-made

### Already published

For the recommended path, **we produce nothing**. `onnx-community/sam3-tracker-ONNX` ships seven dtypes:
`fp32`, `fp16`, `int8`, `uint8`, `quantized`, `q4`, `q4f16`, `bnb4`.
The same holds for the SAM 2.1 and SlimSAM repos.

This removes a whole workstream. It is the main practical reason to pick the tracker.

### If we must quantize

Two tools cover the work.

Export first with optimum-onnx:

```
pip install optimum[onnxruntime]
optimum-cli export onnx --model facebook/sam3 --task mask-generation ./sam3-onnx
```

Then quantize. Dynamic int8 uses `onnxruntime.quantization`:

```
optimum-cli onnxruntime quantize --avx512 --onnx_model ./sam3-onnx -o ./sam3-onnx-int8
```

4-bit weights use `onnxruntime.quantization.matmul_4bits_quantizer.MatMul4BitsQuantizer`.
The `q4f16` variant applies 4-bit MatMul weights over an fp16 graph.

`danilobukvic/sam3-text-onnx` publishes its own scripts, which are a working reference:
`export_sam3_vision.py`, `export_sam3_text.py`, `export_sam3_decoder.py`,
`quantize_sam3_int8.py`, `quantize_sam3_int4.py`, `quantize_sam3_fp16.py`.

### Accuracy risk per method

Measured on the text export, counting detections above score 0.5:

| Variant | Detections | Max score | Note                                                      |
| ------- | ---------- | --------- | --------------------------------------------------------- |
| fp32    | 12         | 0.926     | Reference                                                 |
| int8    | 12         | 0.925     | "essentially indistinguishable from fp32"                 |
| int4    | 12         | 0.898     | Correct top detections, scores about 3% lower, more noise |

Risk ranking for our use:

- **fp16.** Lowest risk on weights. But the SAM 3 fp16 export is **broken today** - a type mismatch fails the decoder.
- **q8 dynamic (int8).** Low risk. Per-tensor scales lose precision on attention outliers. 539 MB is still large.
- **q4 / q4f16.** Medium risk. 4-bit block quantization shifts mask boundaries by a pixel or two.
  For a medical viewer, a one-pixel boundary shift is a real concern, not a cosmetic one.
- **Never quantize the decoder.** It produces the mask logits. It costs 22 MB at fp32. Leave it there.

Sources:

- https://huggingface.co/docs/optimum-onnx/en/onnxruntime/usage_guides/quantization
- https://huggingface.co/docs/transformers.js/guides/dtypes
- https://huggingface.co/danilobukvic/sam3-text-onnx

---

## 7. Question 6: WebGPU constraints in 2026

### Browser support

| Browser               | State                                              |
| --------------------- | -------------------------------------------------- |
| Chrome / Edge desktop | Supported since 113                                |
| Chrome Android        | Supported since 150                                |
| Safari desktop        | Partial since 26.0                                 |
| Safari iOS            | Supported since 26.0                               |
| Firefox Windows       | Default-on since 141                               |
| Firefox macOS ARM64   | Default-on since 145, shipped in 147 on 2026-01-13 |
| Firefox macOS Intel   | Not default-on                                     |
| Firefox Linux         | Not default-on, expected during 2026               |

Global support is about 83.6%. Roughly one visitor in six needs the fallback path.

### Limits that matter

These are the guaranteed minimums. Real adapters usually report more, but code must not assume that.

| Limit                               | Default                     |
| ----------------------------------- | --------------------------- |
| `maxBufferSize`                     | 268,435,456 bytes (256 MiB) |
| `maxStorageBufferBindingSize`       | 134,217,728 bytes (128 MiB) |
| `maxStorageBuffersPerShaderStage`   | 8                           |
| `maxUniformBufferBindingSize`       | 65,536 bytes                |
| `maxComputeWorkgroupStorageSize`    | 16,384 bytes                |
| `maxComputeInvocationsPerWorkgroup` | 256                         |

The 128 MiB storage-buffer default is the sharp edge.
A 370 MB encoder does not load into one buffer. ONNX Runtime splits weights across buffers, so this works.
But intermediate activations can exceed it. At 1008x1008, attention buffers grow fast.
The community text export reports about 1.7 GB of Softmax buffers at fp32. That is why fp32 fails on a 4 GB GPU.

The runtime must request raised limits from the adapter at device creation. onnxruntime-web does this internally.

### Cold start

Budget three separate costs:

1. **Download.** 393 MB. About 30 s on a 100 Mbit/s link. Much longer on mobile.
2. **Shader compilation.** The first forward pass adds 1 to 5 s. First-frame compile cost alone can exceed 200 ms.
3. **Weight upload to GPU.** Hundreds of milliseconds for a model of this size.

First visit: expect 35 to 60 s before the first mask.
Later visits with a warm cache: expect 2 to 6 s.

This is why SAM must never block first paint. See the integration plan.

### Fallback to WASM

`executionProviders: ['webgpu', 'wasm']` falls back automatically.
WASM is 5 to 10 times slower. A 393 MB SAM 3 encoder on WASM is not usable interactively.
The correct fallback is a **smaller model**, not the same model on a slower backend. See section 10.

Sources:

- https://caniuse.com/webgpu
- https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits
- https://www.w3.org/TR/webgpu/#limits

---

## 8. Question 7: Caching a large model across visits

### What transformers.js does by default

transformers.js uses the browser **Cache API**. `env.useBrowserCache` is `true` by default.
Setting `env.useBrowserCache = false` turns it off.

For a 393 MB model this default is correct. We do not need custom cache code for the first release.

### The three options

| Option        | Fit                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------- |
| **Cache API** | Best. Stores `Response` objects, streams, survives reloads. transformers.js default.      |
| **OPFS**      | Good for random access into one large file. More code. No benefit for whole-file weights. |
| **IndexedDB** | Worst. Blob storage adds a copy. Slower for files of this size.                           |

### Eviction is the real problem

Quotas are generous. Chrome allows 60% of disk per origin. Firefox allows 10% or 10 GiB, whichever is smaller.
Safari on macOS 14+ and iOS 17+ allows about 60% of disk.

Eviction is the risk, not quota:

- Under storage pressure, browsers evict least-recently-used origins.
- **Safari deletes script-created storage after 7 days with no user interaction.**
- When an origin is evicted, **all of its data goes at once** - Cache API, IndexedDB and OPFS together.

A Safari user who visits every two weeks re-downloads 393 MB every time.

The fix is one call, made after a user gesture:

```js
const persisted = await navigator.storage.persist();
```

With persistent storage granted, data survives until the user deletes it.
Firefox prompts the user. Chrome and Safari decide from interaction history.

Report free space before the download starts:

```js
const { usage, quota } = await navigator.storage.estimate();
```

Sources:

- https://github.com/huggingface/skills/blob/main/skills/transformers-js/references/CACHE.md
- https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria

---

## 9. Question 8: CORS and hosting on Cloudflare R2

### Cross-origin isolation is NOT required

This point is widely misreported. The facts:

- **WebGPU does not need `SharedArrayBuffer`.** It does not need COOP or COEP. It works on a normal page.
- **WASM multi-threading does need it.** The ONNX Runtime docs state that multi-threading turns on
  "Only when the browser supports WebAssembly multi-threading and `crossOriginIsolated` mode is enabled".

So: no headers needed for the recommended WebGPU path. Headers needed only to make the WASM fallback fast.

If we add `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`,
every cross-origin subresource must then send `Cross-Origin-Resource-Policy: cross-origin`.
That includes the R2 weights. This is a real cost and it can break unrelated embeds.

Recommendation: **do not set COOP/COEP for the first release.** Accept single-threaded WASM in the fallback.

### One more runtime constraint

The ONNX Runtime docs state: "The proxy worker cannot work with WebGPU EP. This is because a GPU buffer is not
transferable." So `env.wasm.proxy` must stay off. We must create our own worker instead. See the plan.

### R2 CORS policy

A custom domain on an R2 bucket returns CORS headers automatically once a policy exists.
Write `cors.json`:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://dicom.soofgolan.com"],
        "methods": ["GET", "HEAD"],
        "headers": ["range", "content-type"]
      },
      "exposeHeaders": ["content-length", "content-range", "etag"],
      "maxAgeSeconds": 86400
    }
  ]
}
```

Apply it and read it back:

```
npx wrangler r2 bucket cors set <BUCKET_NAME> --file cors.json
npx wrangler r2 bucket cors list <BUCKET_NAME>
```

Three notes:

1. Use a **custom domain**, not the `r2.dev` URL. The `r2.dev` URL is rate-limited and for development only.
   Only a custom domain gives Cloudflare Cache, WAF rules and access control.
2. `exposeHeaders` must include `content-length`. Without it the download progress bar cannot show a total.
3. If a CORS policy changes on a domain that already served traffic, purge the cache. Cached objects keep old headers.

### License obligation

The SAM License requires that we ship a copy of the Agreement with the weights.
Put `LICENSE.txt` in the same R2 prefix as the ONNX files, and link it from the model-loading UI.

Sources:

- https://developers.cloudflare.com/r2/buckets/cors/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- https://web.dev/articles/coop-coep

---

## 10. Question 9: Medical imaging reality check

### Does a medical fine-tune with web-runnable weights exist?

**No.** Not one medical SAM variant ships ONNX weights.

| Model                       | Weights           | ONNX   | License                 |
| --------------------------- | ----------------- | ------ | ----------------------- |
| MedSAM                      | PyTorch           | No     | Apache-2.0              |
| MedSAM2 (`wanglab/MedSAM2`) | `.pt` only        | **No** | CC-BY-SA-4.0            |
| Medical SAM3                | Announced, GitHub | No     | Not stated in the paper |
| SAM-Med2D                   | PyTorch           | No     | Apache-2.0              |

`wanglab/MedSAM2` holds nine `.pt` checkpoints, each about 156 MB.
Variants include `MedSAM2_MRI_LiverLesion.pt` and `MedSAM2_CTLesion.pt`. There is no elbow or musculoskeletal variant.
MedSAM2 builds on SAM 2.1 hiera-tiny, so a self-made ONNX export is plausible. Nobody has published one.

Two blockers on MedSAM2:

1. **CC-BY-SA-4.0 is share-alike.** A derivative ONNX export must also be CC-BY-SA-4.0.
   This repo is MIT. Mixing the two needs a decision, not an assumption.
2. Its published fine-tunes target lesions in liver CT and heart ultrasound. Elbow MRI is out of domain for it too.

### How natural-image SAM performs on grayscale MR

Better than the text numbers suggest, and good enough to ship - with box or point prompts.

The independent 3D medical benchmark covered 16 public datasets, 54 anatomical structures, CT, MRI, ultrasound
and endoscopy. Its finding: SAM 3 "is consistently stronger under click prompting across modalities,
with fewer prompt-frame over-segmentation failures" than SAM 2.

Prompt type dominates the result. Box prompts beat point prompts consistently in the medical SAM literature.
Point prompts suffer from "semantic ambiguity" because a click gives no size or boundary guidance.
On the BUSI ultrasound dataset, better box quality moved Dice from 0.8904 to 0.9576.

Practical consequences for a DICOM viewer:

- **Give the user a box tool first.** Make box the default. Points refine.
- **Feed windowed 8-bit pixels, not raw stored values.** The encoder expects a 3-channel natural image.
  Replicate the window/level output across R, G and B. This is what MedSAM does.
- **Segment per slice, in 2D.** SAM has no notion of slice thickness or through-plane continuity.
- **Thin structures are the weak point.** Ligaments a few pixels wide are the hardest case for any SAM variant.

### Recommendation for this repo

Use `onnx-community/sam3-tracker-ONNX` with box and point prompts.
It is the strongest available model on medical data under click prompting, and the weights are ready today.

Treat the output as a draft that a human edits. Never present a SAM mask as a measurement.

Sources:

- https://arxiv.org/abs/2511.21926
- https://huggingface.co/wanglab/MedSAM2
- https://github.com/bowang-lab/MedSAM2
- https://github.com/bowang-lab/MedSAM
- https://arxiv.org/abs/2601.10880
- https://arxiv.org/html/2606.04705v2
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11312622/

---

## 11. Open risks

| #   | Risk                                                  | Impact                              | Reduction                                                                          |
| --- | ----------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Text prompts do not work on anatomy                   | Feature cancelled                   | Ship box and point prompts. State the limit in the UI.                             |
| 2   | 393 MB download on a medical site                     | Users leave before the first mask   | Lazy-load. Never block first paint. Ask before download.                           |
| 3   | Grayscale MR is out of domain                         | Masks leak past thin ligaments      | Box prompts by default. Human edit required.                                       |
| 4   | SAM License is not open source                        | Legal review needed before launch   | Ship the LICENSE next to the weights. Link it in the UI.                           |
| 5   | `onnx-community/sam3-tracker-ONNX` has no license tag | Unclear provenance                  | Treat it as SAM License through `base_model`. Ask onnx-community to tag it.        |
| 6   | Safari evicts storage after 7 days idle               | Repeat 393 MB downloads             | Call `navigator.storage.persist()` after a user gesture.                           |
| 7   | q4 shifts mask boundaries                             | Wrong contours in a medical context | Compare q4, q4f16 and fp16 on real MR slices before choosing.                      |
| 8   | 128 MiB storage-buffer minimum                        | Fails on low-end GPUs               | Detect limits at startup. Fall back to SAM 2.1 tiny.                               |
| 9   | Firefox Linux and Intel Mac have no WebGPU            | About 1 in 6 users                  | Ship the SlimSAM WASM fallback.                                                    |
| 10  | `facebook/sam3.1` is gated and has no safetensors     | Cannot use SAM 3.1 improvements     | Stay on the SAM 3 tracker export. Object Multiplex helps video, not still slices.  |
| 11  | No medical SAM has ONNX weights                       | No domain-tuned option              | Track MedSAM2. A self-made export is possible but CC-BY-SA-4.0 conflicts with MIT. |
| 12  | Mask quality is not validated on elbow MRI            | Unknown real accuracy               | Run a manual test on the sample study before any release.                          |
