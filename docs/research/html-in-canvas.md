# HTML-in-Canvas

Research date: 2026-08-02. Proposal: [WICG/html-in-canvas](https://github.com/WICG/html-in-canvas).

## Verdict

Do not use HTML-in-Canvas. The feature is Chromium-only, and it needs a flag or
an origin trial token. Chrome stable is 151 today, the origin trial ends at
milestone 154, and no second engine has a position or a prototype. A public
medical-image viewer must not put labels behind a single-engine trial feature.
Instead, we will draw labels and view-cube faces to a texture atlas with
`OffscreenCanvas` and `fillText`, then map that atlas on normal meshes. This
gives depth-correct occlusion today, in every engine, with no new dependency.
The security model is not the blocker, because the proposal does not taint the
canvas and permits both read-back and texture upload.

## Evidence

### 1. Spec status and API surface

Older write-ups name `drawElement`, `layoutSubtree`, and `updateLayout`. Those
names are out of date. The current API is different.

| Item               | Current name                                             |
| ------------------ | -------------------------------------------------------- |
| Opt-in attribute   | `layoutsubtree` (IDL: `HTMLCanvasElement.layoutSubtree`) |
| 2D draw method     | `CanvasRenderingContext2D.drawElementImage()`            |
| WebGL draw method  | `WebGLRenderingContext.texElementImage2D()`              |
| WebGPU draw method | `GPUQueue.copyElementImageToTexture()`                   |
| Frame hook         | `paint` event, `onpaint`, `requestPaint()`               |
| Worker snapshot    | `canvas.captureElementImage()`, `ElementImage`           |
| Transform helper   | `getElementTransform(element, drawTransform)`            |

`drawElementImage()` returns a `DOMMatrix`. The `paint` event carries a
`changedElements` array. `ElementImage` is transferable to a worker.

An older proposal named `placeElement` exists. WebKit closed its position issue
for `placeElement` with the label "proposal withdrawn" on
[2026-03-14](https://github.com/WebKit/standards-positions/issues/403).

Ownership: the explainer sits in WICG. The specification work moved to the
WHATWG HTML Workstream. The stages issue is
[whatwg/html#10650](https://github.com/whatwg/html/issues/10650), labeled
**stage 2 Iteration**. The specification pull request
[whatwg/html#11588](https://github.com/whatwg/html/pull/11588) is open. A TAG
design review is open at
[w3ctag/design-reviews#1204](https://github.com/w3ctag/design-reviews/issues/1204).

Most recent changes in the explainer repository:

- 2026-06-16: rename "privacy-preserving painting" to "read-back-allowed rendering".
- 2026-06-24: add IME pop-ups and text formatting to the sensitive-information list.
- 2026-07-13: allow nested HTML-in-canvas.
- 2026-07-14: `paint` events fire in reverse tree order.

### 2. Implementation status per engine

**Chromium.** Flag: `chrome://flags/#canvas-draw-element`. The Finch feature
name is `CanvasDrawElement`. The tracking bug is
[crbug.com/500967896](https://crbug.com/500967896). A developer trial started at
milestone 138. An origin trial ran on desktop, Android, and WebView from
milestone 148 to 150. Blink API owners approved an extension on
[2026-06-11](http://www.mail-archive.com/blink-dev@chromium.org/msg16743.html),
and the extension ends at milestone 154. Chrome stable on 2026-08-02 is
**151**. Milestone 154 reaches stable on 2026-09-22, so the trial ends near the
end of October 2026. The Chrome Platform Status entry
([5172548013916160](https://chromestatus.com/feature/5172548013916160), updated
2026-04-17) still reports status "In development".

**WebKit.** [WebKit/standards-positions#630](https://github.com/WebKit/standards-positions/issues/630),
opened 2026-03-13, is open with no position label. Chrome Platform Status
records "No signal". The only comments are about venue and accessibility review.

**Gecko.** [mozilla/standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076),
opened 2024-09-25, is open with no position label. Chrome Platform Status
records "No signal", with the note that Mozilla did not object to stage 2. The
thread is stronger than that note. On 2025-12-09 a Mozilla graphics engineer
wrote that rendering documents to canvas "is the wrong approach at multiple
levels". Later comments on 2026-03-11 and 2026-03-13 raise fingerprinting, a
"pixel oracle" compatibility risk, and ad-block detection. Treat Gecko as
unfriendly, not neutral.

No second engine has an implementation.

### 3. Security model

Tainting looks like the obvious blocker. It is not one.

The explainer calls the model **read-back-allowed rendering**. The design goal
is to allow pixel read-back instead of tainting. The explainer states that the
draw methods "must not reveal any security- or privacy-sensitive information".

- **The canvas is not tainted.** A Chromium engineer confirmed the reasoning on
  [2026-06-16](https://github.com/mozilla/standards-positions/issues/1076):
  tainting "would prevent use in WebGL/WebGPU", so the design removes sensitive
  content instead.
- **`getImageData()`, `toDataURL()`, and `readPixels()` stay available.** The
  proposal exists partly for media export, and the explainer lists "Media
  Export" as a use case.
- **Sensitive content is not painted.** The engine drops it from both the
  drawn pixels and the `paint` invalidation signal.
- **Iframes.** Same-origin iframes paint. Cross-origin content inside them does
  not paint.
- **Cross-origin images.** They do not paint. They are excluded, not blocking.

The explainer gives this list of sensitive content:

- Cross-origin data in embedded content, such as `<iframe>` and `<img>`.
- Cross-origin `<url>` references, such as `background-image` and `clip-path`.
- Canvases already tainted by cross-origin data.
- Cross-origin SVG references, such as `<use>`, `<pattern>`, and `<feImage>`.
- System colors, themes, and preferences.
- Spelling and grammar markers.
- **Visited link information.**
- Pending form autofill data that JavaScript cannot otherwise read.
- Subpixel text anti-aliasing.
- Caption and subtitle preferences.
- IME pop-ups and distinctive IME text formatting.

So `:visited` and cross-origin leaks are handled by omission. Mozilla's open
objection is that this denylist has a long tail and must stay correct forever.

### 4. Texture upload

Texture upload is a first-class part of the API, not a workaround. The IDL adds
`texElementImage2D()` to `WebGLRenderingContext` and
`copyElementImageToTexture()` to `GPUQueue`. Tainting never applies, so the
question "is upload allowed from a tainted canvas" does not arise.

three.js already integrates this. Pull request
[mrdoob/three.js#31233](https://github.com/mrdoob/three.js/pull/31233) merged on
2026-04-10 and added `src/textures/HTMLTexture.js` to the core, plus an
`examples/jsm/interaction/InteractionManager.js` addon. The first release with
it is **r184** (2026-04-16). This project pins `three@^0.182.0`, which is r182
(2025-12-10) and does not contain `HTMLTexture`. Adoption needs a three.js
upgrade.

### 5. Interactivity

The drawn HTML is not a dead raster, but interactivity is not free.

The element stays a real DOM child of the `<canvas>`. The `layoutsubtree`
attribute makes children lay out and take part in hit testing, while their own
painting stays invisible. CSS transforms on the child are ignored for drawing
but still drive hit testing and accessibility. To make clicks land in the right
place, the author must write the returned matrix back to
`element.style.transform`. The Chrome blog calls this step critical.

Two limits matter for us:

1. **DOM hit testing has no depth buffer.** A label hidden behind geometry still
   takes pointer events. We must still ray-cast to reject occluded targets.
2. **Each drawable must be a direct child of the canvas.** A view cube with 6
   faces, 12 edges, and 8 corners means 26 pick regions. That maps badly to
   direct DOM children.

### 6. Performance

The `paint` event fires once per frame, after the paint step of "update the
rendering". Option C in the explainer was chosen exactly to avoid a loop, so
author code runs once per frame. `requestPaint()` forces one event, like
`requestAnimationFrame()`. `drawElementImage()` uses a snapshot taken once per
frame, so it does not force synchronous layout or paint.

No vendor benchmark is published. Two known costs:

- Content in a canvas cannot scroll or animate off the main thread. The Chrome
  blog states that scrolling and animations cannot update independently of
  JavaScript. Threaded support is a future "auto-updating canvas" idea only.
- Mozilla names this loss of asynchronous rendering as a main objection.

For our labels this does not matter. Label text changes rarely, so a bake fits
better than a per-frame draw.

### 7. Availability today

Zero availability for a public site with no flags. A user needs Chrome or Brave
with `chrome://flags/#canvas-draw-element`, or the site needs an origin trial
token. The realistic timeline: the trial ends at milestone 154 near the end of
October 2026. A stable ship can follow in late 2026 or 2027 if trial data is
good and the TAG and Mozilla concerns are answered. Cross-engine support has no
timeline at all, because neither WebKit nor Gecko has a position or a prototype.

## What this means for the four use cases

**(a) Labels and annotations in the 3D scene.** HTML-in-Canvas gives real CSS
layout and correct depth, because the texture goes on a normal mesh. It does
not beat the alternatives enough to justify a single-engine dependency. Note
also that `drawElementImage()` produces a raster. Zoom in and the label softens
unless we redraw at a larger scale. SDF text stays sharp at any scale. So
HTML-in-Canvas is not even the crispest option at close range. **Ship:**
`OffscreenCanvas` atlas on a mesh.

**(b) The CAD-style view cube.** Not viable, and not attractive after a close
look. The face labels are 6 fixed strings: "ANT", "POST", "SUP", "INF", "LEFT",
"RIGHT". They never change. HTML layout buys nothing for 6 static words. Picking
needs 26 regions with depth-correct rejection of back faces, which DOM hit
testing cannot do. **Ship:** bake the 6 labels into one atlas, and ray-cast
against face, edge, and corner meshes.

**(c) UI panels composited into the canvas.** Bad idea. Our panels are plain
DOM. They need no depth interaction. Drawing them into the canvas removes
off-main-thread scrolling, adds a Chromium-only path, and makes text selection
and accessibility depend on transform write-back. Keep panels as DOM.

**(d) Screenshot and report export.** HTML-in-Canvas helps here. Read-back is
allowed, so a single raster is possible with no tainting. We do not need it. We
own the overlay content as data. We can draw the three.js canvas into a 2D
canvas, then draw the same text with `fillText`. That works in every engine
today and gives us exact control of the export layout.

## Comparison for use cases (a) and (b)

| Approach                                                             | Crispness                                                                  | Depth-correct occlusion                 | Interactivity                                                               | Bundle cost                                 | Browser support                                      | Effort                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| HTML-in-Canvas texture (`texElementImage2D`, three.js `HTMLTexture`) | Raster at bake scale. Full CSS layout. Softens on close zoom.              | Yes. It is a normal mesh.               | Native DOM events, but needs transform write-back. No depth-aware hit test. | 0 KB, in three.js core from r184.           | Chromium only, flag or origin trial. None on stable. | Medium. Upgrade three.js, plus a fallback path. |
| `troika-three-text` (SDF)                                            | Best. Resolution independent at any zoom.                                  | Yes. It is a normal mesh.               | None built in. Ray-cast yourself.                                           | 843 KB unpacked, 4 runtime dependencies.    | Every WebGL browser.                                 | Low.                                            |
| `CSS2DRenderer` / `CSS3DRenderer`                                    | Best. Real DOM text.                                                       | **No.** DOM composites over the canvas. | Full native DOM.                                                            | Small addon in three.js. No new dependency. | Every browser.                                       | Low.                                            |
| `OffscreenCanvas` `fillText` atlas                                   | Good near the bake scale. Mipmaps and a scale budget cover our zoom range. | Yes. It is a normal mesh.               | None built in. Ray-cast yourself.                                           | 0 KB.                                       | Every browser with `OffscreenCanvas`.                | Low to medium. Atlas packing.                   |

Notes on the table. `troika-three-text` is maintained: version 0.52.5 was
published on 2026-07-24. Pick it over the atlas if the label count grows or the
zoom range gets wide. The atlas stays first choice while labels are short and
few, because it costs no dependency.

## Revisit when

Re-open this document when **all three** conditions are true:

1. Chrome ships HTML-in-Canvas unflagged on stable, with no origin trial token.
2. A second engine records a positive or neutral standards position, on
   [WebKit#630](https://github.com/WebKit/standards-positions/issues/630) or
   [mozilla#1076](https://github.com/mozilla/standards-positions/issues/1076).
3. We run three.js r184 or later, so `HTMLTexture` is available.

The tainting condition in the original brief is already met and needs no watch.
The design deliberately avoids tainting, so texture upload and read-back are
both permitted.

Earliest plausible check: milestone 154 reaches stable on 2026-09-22. Check
condition 1 after that date.

## Sources

- [WICG/html-in-canvas explainer](https://github.com/WICG/html-in-canvas), latest commit 2026-07-14
- [Security and Privacy Questionnaire](https://github.com/WICG/html-in-canvas/blob/main/security-privacy-questionnaire.md)
- [Chrome Platform Status: HTML-in-canvas](https://chromestatus.com/feature/5172548013916160), updated 2026-04-17
- [Introducing the HTML-in-Canvas API origin trial](https://developer.chrome.com/blog/html-in-canvas-origin-trial), updated 2026-05-19
- [blink-dev: Intent to Extend Experiment](http://www.mail-archive.com/blink-dev@chromium.org/msg16735.html), approved 2026-06-11
- [mozilla/standards-positions#1076](https://github.com/mozilla/standards-positions/issues/1076), latest comment 2026-06-16
- [WebKit/standards-positions#630](https://github.com/WebKit/standards-positions/issues/630), opened 2026-03-13
- [WebKit/standards-positions#403 `placeElement`, withdrawn](https://github.com/WebKit/standards-positions/issues/403), closed 2026-03-14
- [whatwg/html#10650 stages issue](https://github.com/whatwg/html/issues/10650), stage 2
- [whatwg/html#11588 spec pull request](https://github.com/whatwg/html/pull/11588), open
- [mrdoob/three.js#31233 `HTMLTexture`](https://github.com/mrdoob/three.js/pull/31233), merged 2026-04-10, released in r184
- [Chromium Dash release data](https://chromiumdash.appspot.com/), Chrome stable 151, milestone 154 stable on 2026-09-22
- [troika-three-text on npm](https://www.npmjs.com/package/troika-three-text), 0.52.5 published 2026-07-24
