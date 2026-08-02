# Segmentation

The viewer can outline a structure in a scan. The model runs in this browser.
No pixel and no prompt leaves the device.

Written in ASD-STE100 Simplified Technical English, pragmatic mode.

---

## 1. What it does

You put a prompt on one cut. The model returns a mask for that cut.

A mask is a draft for a human to correct. It is not a measurement.

Three prompt types work:

- **Box.** Drag a rectangle around the structure. This gives the best result.
- **Click.** Click inside the structure. Alt-click marks a point to exclude.
- **Text.** Type a phrase. Read section 6 first.

You can build more than one object. Each object has a name that you give it,
a colour of its own, and prompts on as many cuts as you want. New clicks go
to the object that the panel shows as active.

Every prompt is a point in patient millimetres. It survives a scroll, a pan,
a zoom, a rotation, a window change and a change of series, because none of
those move the patient. A prompt that you placed on another slice stays on
screen and fades as the cut moves away from it.

You can also grow one clicked slice through the slices around it. Read
section 5 for what that does and section 6 for what it costs.

---

## 2. The models

| Job                         | Repo                               | Format                       | Bytes       |
| --------------------------- | ---------------------------------- | ---------------------------- | ----------- |
| Masks from a box or a click | `onnx-community/sam3-tracker-ONNX` | `q4` encoder, `fp32` decoder | 392,560,198 |
| A region from a phrase      | `Xenova/clipseg-rd64-refined`      | `q4f16`                      | 119,133,630 |

The total download is 512 MB. The panel states this number before you start.

The first model is the SAM 3 tracker. It takes points and boxes. It has no
text input.

The second model is CLIPSeg. It takes one phrase and returns a heat map of
352 by 352, with one score per pixel.

The text feature chains the two. The hot part of the heat map becomes a box,
and the box goes into SAM as a box prompt. SAM draws the edge, because a
threshold over a 352 by 352 heat map gives a soft and blocky boundary.

Both repos are public. Neither needs an approval to download.

### Why not a detector

A box detector was the first choice, because a detector gives a box directly.
No OWL export loads. Every one stops at the same node:

```
Could not find an implementation for Cast(13) node with name '/class_head/Cast'
```

Tested on 2026-08-02 against onnxruntime-web 1.26:

| Repo                                 | Format  | Provider | Result           |
| ------------------------------------ | ------- | -------- | ---------------- |
| `Xenova/owlv2-base-patch16-ensemble` | `q4f16` | WebGPU   | Cast(13) failure |
| `Xenova/owlv2-base-patch16-ensemble` | `q4`    | WASM     | Cast(13) failure |
| `Xenova/owlv2-base-patch16-ensemble` | `fp16`  | WebGPU   | Cast(13) failure |
| `Xenova/owlvit-base-patch32`         | `q8`    | WASM     | Cast(13) failure |
| `Xenova/owlvit-base-patch32`         | `q4f16` | WebGPU   | Cast(13) failure |

Two repos, four weight formats, both providers. The fault is in the export of
the classification head, not in the quantization and not in the provider.
CLIPSeg has no classification head, so it has no such node.

### MedSigLIP was measured and rejected

CLIPSeg learned from photographs, and its training set holds no MRI. That is
the likely cause of the low scores on tissue names in section 6. MedSigLIP
(`google/medsiglip-448`) learned from medical image and text pairs, and those
pairs include slices of CT and MRI volumes with their radiology reports. So it
was the obvious model to try.

It was exported, quantized and scored against this study on 2026-08-02. **It
does not work for naming tissue, and it is 894 MB.** It is not adopted.

MedSigLIP has no mask decoder, so it can never segment. It can only score how
well a picture and a phrase agree. The composition that would have worked
needs no training: SAM makes candidate masks, each is cut out, MedSigLIP
scores each cut against the phrase, the best wins. The scores below are what
that composition would have run on.

#### The model does work, which is why the result can be trusted

A negative result is only worth reading if the harness is right. These three
checks use the same code path and the same 34 crops, and each has ground
truth already:

| Check                                | Result       | Chance |
| ------------------------------------ | ------------ | ------ |
| Body part: elbow, brain, knee, chest | 34/34 (100%) | 25%    |
| Modality: MR, CT, a photograph       | 33/34 (97%)  | 33%    |
| Sequence: T1 against fat-saturated   | 17/34 (50%)  | 50%    |

The model reads a whole picture well. It knows an elbow MRI, and it ranks
"an MRI of the knee" above "an MRI of the brain", which is the right order.
It cannot tell T1 from a fat-saturated sequence, which is the first thing a
reader learns, and which naming a tissue depends on.

#### Naming a tissue: at chance

Crops came from the tissue classifier in `src/core/tissue`, so the label is
signal-derived ground truth, not a hand-drawn guess. Four classes, four crop
widths, both sequences, 32 labelled crops. The task is to pick the right one
of eight tissue concepts.

| Wording                                   | Correct    | Chance |
| ----------------------------------------- | ---------- | ------ |
| Single noun, "fat"                        | 3/32 (9%)  | 12%    |
| Report phrasing, "subcutaneous fat"       | 4/32 (12%) | 12%    |
| Full sentence, "an MRI slice showing ..." | 1/32 (3%)  | 12%    |

**Report phrasing did not beat single nouns.** That was the hypothesis worth
testing, and it failed: the mean cosine difference over the four classes is
-0.0040. The one class where phrasing helped, edema at +0.2593, is explained
by the next table.

#### The negative control fails

A crop of pure subcutaneous fat, scored against edema wording, must lose to a
crop of the real bone bruise. It does not.

| Wording             | Mean on fat crops | Mean on edema crops | Separation |
| ------------------- | ----------------- | ------------------- | ---------- |
| "edema"             | -0.0595           | -0.0544             | +0.0051    |
| "bone marrow edema" | +0.2039           | +0.2049             | +0.0010    |

"bone marrow edema" scores about +0.20 on everything. That is a property of
the phrase, not of the picture.

#### Why: the wording decides the answer

Splitting the score matrix into what the prompt contributes, what the picture
contributes, and what the two contribute together:

| Source            | Share of the variation |
| ----------------- | ---------------------- |
| The wording alone | 74.0%                  |
| The picture alone | 5.7%                   |
| The two together  | 20.3%                  |

Only the last row can name a tissue. Removing the per-prompt constant, which
is the usual fix for a text prior, moves the four-way choice from 25% to 28%
against a 25% chance. There is nothing to recover.

This is the same failure CLIPSeg shows. CLIPSeg returns a box over most of
the arm; MedSigLIP returns "the distal biceps tendon" for almost every crop
wider than 60 mm. Neither reads the tissue.

#### Size and speed, measured

Exported with `torch.onnx.export` at opset 17, quantized with
`onnxruntime.quantization.quantize_dynamic` to QUInt8.

| Tower  | Parameters | ONNX float32 | ONNX q8      |
| ------ | ---------- | ------------ | ------------ |
| Vision | 429 M      | 1714.8 MB    | 442.7 MB     |
| Text   | 450 M      | 1799.4 MB    | 451.8 MB     |
| Both   | 879 M      | 3514.2 MB    | **894.5 MB** |

Latency on this machine, CPU only:

| Run             | Image   | Text          |
| --------------- | ------- | ------------- |
| PyTorch float32 | 1009 ms | 52 ms/prompt  |
| onnxruntime q8  | 2769 ms | 125 ms/prompt |

Quantization is not the reason it fails. The q8 scores correlate with the
float scores at r = 0.909, with a mean absolute difference of 0.031.

Browser load time and WebGPU latency were **not** measured. The model was
ruled out twice over before that work was worth doing: the scores are at
chance, and 894.5 MB is about ten times the whole current model payload.
Cloudflare refuses a single asset above 25 MiB, so the weights would have gone
to R2 in many parts.

#### If anyone tries again

The runtime side is ready. transformers.js 4.2.0, the pinned version, already
exports `SiglipModel`, `SiglipTextModel`, `SiglipVisionModel`,
`SiglipImageProcessor` and `SiglipTokenizer`, so no new dependency is needed.

Two traps cost time here, and both are recorded so nobody repeats them:

- This checkpoint trained to `logit_scale` 10.03 and `logit_bias` -10.0. The
  sigmoid probability that SigLIP normally reports therefore cannot pass 0.5
  even for a perfect match, and reads 0.000 for everything. Google's own model
  card uses a softmax across the candidate texts. Read the cosine, or the
  softmax, never the sigmoid.
- In transformers 4.57, `get_image_features` and `get_text_features` return an
  output object, not a tensor. Take `.pooler_output`.

Three conditions apply before any MedSigLIP weight is served from our origin,
because the license is Health AI Developer Foundations and not Apache-2.0:

- Pass on the use restrictions.
- Ship a NOTICE file.
- Mark each modified file as modified. A quantized export is a modification.

None of those apply today, because no weight is shipped.

What MedSigLIP is good at, on this study, is naming the whole picture: the
body part and the modality, both near perfect. If the viewer ever needs to
check that a loaded series is what its description claims, that is the use to
come back to. It is not segmentation.

### License

The SAM 3 weights carry the SAM License, not Apache-2.0 or MIT. The license
permits redistribution. One condition applies: a copy of the license must
travel with the weights. CLIPSeg carries Apache-2.0.

`facebook/sam3` and `facebook/sam3.1` hold the real text head. Both are gated
behind manual approval, and neither ships a browser format. Section 8 gives
the detail.

---

## 3. What the machine needs

| Browser              | State                         |
| -------------------- | ----------------------------- |
| Chrome, Edge desktop | Works since version 113       |
| Chrome Android       | Works since version 150       |
| Safari 26 and later  | Works on macOS and iOS        |
| Firefox Windows      | Works since version 141       |
| Firefox macOS ARM64  | Works since version 147       |
| Firefox macOS Intel  | No WebGPU. The panel says so. |
| Firefox Linux        | No WebGPU. The panel says so. |

The panel asks the browser for a WebGPU adapter when you open it. The answer
picks the model:

| Condition                                    | Model                         | Download |
| -------------------------------------------- | ----------------------------- | -------- |
| WebGPU, storage buffer limit 128 MiB or more | SAM 3 tracker, `q4`           | 393 MB   |
| WebGPU, storage buffer limit below that      | SAM 2.1 tiny, `q4f16`         | 50 MB    |
| No WebGPU, desktop                           | SlimSAM 77, `q8`, WebAssembly | 25 MB    |
| No WebGPU, phone                             | None. The panel says why.     | 0        |

The fallback is a smaller model, never the same model on a slower backend.
SAM 3 on WebAssembly takes minutes for one cut.

The text feature needs WebGPU. On the WebAssembly path the panel hides it.

---

## 4. How to use it

1. Open a study.
2. Open the **Segment** section in the left sidebar.
3. Select **Load model**. The download starts and shows its progress.
4. Wait for the panel to show the backend and the model name.
5. Select **Box** or **Click**.
6. Drag a rectangle around a structure, or click inside it.
7. Look at the outline on the cut. The first click makes an object.
8. Scroll to another slice, or use another pane, and click again. The clicks
   join the same object.
9. To exclude a region, select **Exclude**, or hold alt while you click.
10. To start a second object, select **New object**.
11. To rename an object, double click its name.
12. To take back the last action, select **Undo**.

The list under the panel gives one row for each object: a colour, a name, a
size in cubic millimetres, a visibility button and a delete button. Under the
active object the panel lists every slice you clicked on. Select a slice to
move the cursor back to it.

Where two objects overlap, the object lower in the list covers the object
above it. The list runs in the order the objects were made.

To stop a download, select **Stop**. The next download starts again from the
beginning, because the model loader takes no abort signal.

---

## 5. How it works

The feature splits along the line that the rest of the repo follows.
`src/core/segment/` holds pure functions with tests. `src/shell/segment/`
holds the worker, the React panel and the overlay.

### Nothing loads until you ask

The first page load carries one flag and two lazy boundaries. That is 2.4 kB,
or 0.9 kB after gzip. The store, the panel, the overlay and the 561 kB model
runtime arrive in a separate chunk when you open the section.

The weights arrive only after you select the load button.

### The worker

The model lives in a dedicated worker. Two facts force this design. The
vision encoder takes seconds, and on the main thread it freezes the viewer.
And the ONNX Runtime documentation states that its own proxy worker cannot
carry the WebGPU backend, because a GPU buffer does not transfer between
threads.

### The encoder and the decoder

Every SAM model splits into two graphs. The vision encoder holds almost all
the weights and runs once per cut. The mask decoder is small and runs once
per prompt.

This split is why a second click on the same cut is fast. The viewer keeps
the embedding for the cut under the cursor and reuses it.

Measured on an Apple Silicon Mac, Chrome, WebGPU, on the sample elbow study:

| Step                                 | Time         |
| ------------------------------------ | ------------ |
| First visit, 512 MB over a slow link | 5 to 12 min  |
| Later visit, everything cached       | 2.6 s        |
| First prompt on a cut, with encoding | 6.6 s        |
| Later box prompt on the same cut     | 166 ms       |
| Later click prompt on the same cut   | 242 ms       |
| One CLIPSeg search                   | 60 to 100 ms |

### From a pixel to a voxel

A mask is a flat 2D image. The cut it sits on is an arbitrary plane in
patient millimeters. A `MaskFrame` records the plane, so a mask keeps its
meaning after you pan, zoom or resize the window.

The frame samples at half the finest voxel spacing. Half, not one, because a
mask pixel must map back to a voxel index within half a voxel. Rounding to
the nearest pixel costs up to 0.71 of a pitch on an oblique cut, where the
plane axes miss the grid.

### The session

`src/core/segment/session.ts` holds the whole interaction model as pure
functions over plain data. It has tests and it needs no browser.

A session holds objects. An object holds cuts. A cut holds the prompts that
you placed on one slice of one series, and the mask they made.

A prompt keeps its patient coordinates and nothing else. To draw it, the
overlay projects it into the frame of the pane it is looking at. To run it,
the store projects it into the frame of the picture the model reads. Neither
step stores a pixel, so no view change can break a prompt.

Two prompts share a cut while they sit inside one voxel slab of that pane.
`src/core/segment/slice.ts` holds that rule and the depth arithmetic.

### Prompts across many slices

SAM reads one 2D picture at a time. A prompt from another slice is not a
prompt on this one, and this viewer never pretends that it is.

So the prompts of one object group by the cut they were placed on. Each group
runs on its own picture and returns its own 2D mask. The object is the set of
those masks. Its size in cubic millimetres is the union of the voxels under
them, so a voxel that two crossing masks cover counts once.

### Growth through the slices

SAM 2 and SAM 3 can follow an object through a video with a memory encoder
and memory attention. Those graphs are not in the exports this viewer
downloads. `onnx-community/sam3-tracker-ONNX` and
`onnx-community/sam2.1-hiera-tiny-ONNX` each hold only `vision_encoder` and
`prompt_encoder_mask_decoder`, and `Sam3TrackerModel` in transformers.js
4.2.0 is an empty subclass of `Sam2Model` with no video session. Checked on
2026-08-02.

So **Grow through slices** re-prompts instead. It starts at the last slice
you clicked, steps out one slice at a time on both sides, and builds the
prompt for each new slice out of the mask of the slice before it: a point
well inside that mask, and a box that is 12% wider than it.

A walk that never stops draws a confident tube of nothing. `judgeSlice` in
`src/core/segment/propagate.ts` stops it:

| Test                                           | Cause       |
| ---------------------------------------------- | ----------- |
| The mask is empty                              | `vanished`  |
| The mask is under 24 pixels                    | `collapsed` |
| The mask is over 2.5 times the slice before    | `leaked`    |
| The mask is under 0.4 of the slice before      | `collapsed` |
| The mask is over 3 times the slice you clicked | `drifted`   |
| The model rates its own mask under 0.5         | `low-score` |
| 32 slices on this side                         | `limit`     |
| No more slices in the volume                   | `edge`      |

A slice that fails a test is dropped, not kept. The panel reports the cause
for each side, because a structure that ended and a tracker that gave up are
different facts.

A slice you clicked draws with a solid edge. A slice the walk inferred draws
with a broken edge and a fainter fill. A click on an inferred slice takes it
over, and the model reads that slice again.

### Windowed pixels, not stored values

The model learned on photographs. A cut goes to it as the picture a reader
sees after the window transform, copied across red, green and blue. Raw
stored values give a much worse result.

### Storage

The weights go into the browser Cache API. The load button also calls
`navigator.storage.persist()`, because a gesture must come first. Without
that call, Safari deletes storage that a script made after seven days with
no visit.

---

## 6. Accuracy

**Read this before you trust a mask.**

### Text prompts on MRI

Text prompts are unreliable on radiology. This is a limit of the models, not
a setting you can correct.

The SAM 3 paper states the limit in its own section 8. The model "struggles
to generalize to out-of-domain terms", and the paper names medical terms as
an example.

The Medical SAM3 paper measured it. Vanilla SAM 3 with text prompts scored
**11.9% Dice** on external validation over seven medical datasets. The same
model after a medical fine-tune scored 73.9%.

A third study benchmarked SAM on 16 datasets, 54 anatomical structures, CT,
MRI and ultrasound. Those authors evaluated clicks, boxes and masks only.
They did not evaluate text prompts on medical data at all.

Terms such as "radial collateral ligament" or "capitulum humeri" will not
work. The models learned their phrases from natural photographs. Elbow
ligament names are not in that set.

Sources:

- SAM 3 paper, limitations: https://arxiv.org/abs/2511.16719
- Medical SAM3: https://arxiv.org/abs/2601.10880
- SAM 2 against SAM 3 on 3D medical data: https://arxiv.org/abs/2511.21926

### What we measured on this study

One axial cut of the sample elbow MRI, series `pd_tse_fs_tra_DRB`, on
2026-08-02. The number is the peak of the CLIPSeg heat map, 0 to 1.

| Phrase             | Peak | What came back                          |
| ------------------ | ---- | --------------------------------------- |
| "skin"             | 0.96 | The correct outer border of the arm     |
| "the bright fluid" | 0.52 | A small bright spot. Plausible.         |
| "bone"             | 0.40 | A box over most of the arm. Not useful. |
| "fat"              | 0.39 | A tall strip. Not useful.               |
| "muscle"           | 0.34 | A box over most of the arm. Not useful. |

This matches the published numbers. Everyday words that a photograph can
show, such as "skin", work. Tissue names do not. A peak below about 0.5
means the model found nothing and returned the whole picture.

The panel reports the peak after each search, so a reader can see this.

A model trained on radiology does no better. MedSigLIP names the body part in
34 crops out of 34, and names the tissue at chance. Section 2 gives the
measurements. So the limit is not that CLIPSeg learned from photographs. Two
towers trained to match a whole picture to a whole report do not learn which
tissue fills a crop, whatever they were trained on.

### Box and click prompts

These work well enough to ship, and they are what the research community
uses on radiology.

Box prompts beat click prompts. A click gives no size and no boundary, so
the model must guess how much to include. On one ultrasound dataset, a
better box moved Dice from 0.8904 to 0.9576.

Thin structures stay the weak point. A ligament a few pixels wide is the
hardest case for every SAM variant.

### Rules for a reader

- Use a box for anything you will act on.
- Treat every mask as a draft. Correct it by hand.
- Never present a mask as a measurement.
- The size in the panel counts pixels. It carries the same error as the mask.

---

## 7. Hosting

Today the weights come from `huggingface.co`, which redirects to a CDN host
under `hf.co`. `public/_headers` lists both in `connect-src`.

transformers.js also loads the ONNX Runtime WebAssembly files from
`cdn.jsdelivr.net`. That host is not in the policy, so a deployed build will
block them. Two ways to correct this, and the second is better:

1. Add `https://cdn.jsdelivr.net` to `script-src` and `connect-src`.
2. Set `env.backends.onnx.wasm.wasmPaths` to a copy on our own origin. The
   build already writes `ort-wasm-simd-threaded.asyncify.wasm` into `dist`,
   at 23.5 MB, so the file is there but nothing points at it.

Option 2 keeps the policy tight. Do it before the first deploy.

The plan is to copy the files to Cloudflare R2 on a custom domain. Two
reasons: we control availability, and we control the CORS headers. After the
move, remove the two Hugging Face hosts from `connect-src`.

The R2 CORS policy must expose `content-length`. Without it the progress bar
cannot show a total.

`LICENSE.txt` must sit next to the SAM 3 weights in the same R2 prefix.

WebGPU needs no COOP or COEP headers. It does not use `SharedArrayBuffer`.
Only multi-threaded WebAssembly needs them, and we accept a single thread on
the fallback path.

---

## 8. Why not the real SAM 3 text head

`facebook/sam3` and `facebook/sam3.1` hold the text head. Both are gated
behind manual approval by a person at Meta.

`facebook/sam3.1` ships one file of weights, `sam3.1_multiplex.pt`, at
3,502,755,717 bytes. It has no safetensors file, and its `library_name` is
`checkpoint`, not `transformers`. Its config names `Sam3VideoModel`, and a
`text_config` sits inside `detector_config`.

An ONNX export is therefore possible but not cheap. It needs three separate
graphs, and the one published community attempt reports a broken `fp16`
export, 1.7 GB of Softmax buffers at `fp32`, and 686 MB at `int4`. That
export also drops box and point prompts.

The chain of OWLv2 and SAM costs 132 MB, keeps every prompt type, and uses
weights that anybody can download today.

---

## 9. Known limits

- A mask covers one slice. There is no 3D growth between slices.
- Masks draw on the cuts. The 3D view does not show them.
- A stopped download starts again from the beginning.
- The text field searches the cut of the last prompt, or the axial cut.
- CLIPSeg takes one phrase per run. Two phrases stop with a shape mismatch.
- The panel keeps masks in memory only. A reload loses them.
- One failed model load poisons the runtime. The worker must stop and start
  again, which is what the **Stop** button does.
