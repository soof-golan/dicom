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

Each mask belongs to the slice you made it on. Move the cursor to another
slice and the mask disappears. Move back and it returns.

---

## 2. The models

| Job                         | Repo                                 | Format                       | Bytes       |
| --------------------------- | ------------------------------------ | ---------------------------- | ----------- |
| Masks from a box or a click | `onnx-community/sam3-tracker-ONNX`   | `q4` encoder, `fp32` decoder | 392,560,198 |
| Boxes from a phrase         | `Xenova/owlv2-base-patch16-ensemble` | `q4f16`                      | 132,046,418 |

The total download is 525 MB. The panel states this number before you start.

The first model is the SAM 3 tracker. It takes points and boxes. It has no
text input. The second model is OWLv2. It takes a phrase and returns boxes.

The text feature chains the two. OWLv2 finds a box, and the box goes into SAM
as a box prompt. This chain is the standard "grounded SAM" pattern.

Both repos are public. Neither needs an approval to download.

`facebook/sam3` and `facebook/sam3.1` hold the real text head. Both are gated
behind manual approval, and neither ships a browser format. Section 8 gives
the detail.

### License

The SAM 3 weights carry the SAM License, not Apache-2.0 or MIT. The license
permits redistribution. One condition applies: a copy of the license must
travel with the weights. OWLv2 carries Apache-2.0.

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
7. Look at the white outline on the cut.
8. To keep the mask, select **Keep**. To drop it, select **Discard**.

A kept mask joins the list under the panel. Each row gives a color, a label,
a size in cubic millimeters, a visibility button and a delete button.

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

### From a pixel to a voxel

A mask is a flat 2D image. The cut it sits on is an arbitrary plane in
patient millimeters. A `MaskFrame` records the plane, so a mask keeps its
meaning after you pan, zoom or resize the window.

The frame samples at half the finest voxel spacing. Half, not one, because a
mask pixel must map back to a voxel index within half a voxel. Rounding to
the nearest pixel costs up to 0.71 of a pitch on an oblique cut, where the
plane axes miss the grid.

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
work. The models learned 4M noun phrases from natural photographs. Elbow
ligament names are not in that set.

Sources:

- SAM 3 paper, limitations: https://arxiv.org/abs/2511.16719
- Medical SAM3: https://arxiv.org/abs/2601.10880
- SAM 2 against SAM 3 on 3D medical data: https://arxiv.org/abs/2511.21926

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
- The panel keeps masks in memory only. A reload loses them.
