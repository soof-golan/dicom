# DICOM Viewer

A web-native viewer for MRI and CT scans. It runs in the browser. Your scans stay on your device.

Live at [dicom.soofgolan.com](https://dicom.soofgolan.com).

## What it does

The viewer reads DICOM files and builds a 3D volume from them. You can look at the volume in three ways at the same time: axial, coronal, and sagittal. You can also cut the volume at any angle.

The 3D view uses a CAD-style view cube. You drag the cube to rotate the camera. You click a face, an edge, or a corner of the cube to jump to that view.

The viewer colors tissue types from the MRI signal. Bone, muscle, fat, fluid, and tendon each get a color. A separate tool segments a region when you click it or describe it in words.

## Privacy

The viewer sends no data anywhere. It has no server, no analytics, and no accounts. DICOM files that you open are read in the browser and stay in memory. The only saved state is in `localStorage`, and it holds the tutorial progress and your view preferences.

## Not a medical product

This software is not a medical device. Do not use it for diagnosis or treatment. It comes with no warranty. Read [Terms and Conditions](docs/terms.md) for the full text.

## Development

The project uses [Vite+](https://viteplus.dev). Install the `vp` CLI first.

```bash
vp install
vp dev
```

Other commands:

```bash
vp check   # format, lint, and type check
vp test    # run the tests
vp build   # build for production
```

Pre-commit hooks run through [prek](https://github.com/j178/prek):

```bash
prek install
```

## Architecture

The code has a functional core and an imperative shell.

`src/core` holds pure functions. They parse DICOM bytes, build volumes, compute geometry, and classify tissue. They touch no DOM, no GPU, and no network. Every module here has tests.

`src/shell` holds the parts that talk to the outside world: React components, three.js renderers, Web Workers, and file input.

## License

MIT. Copyright (c) 2026 Soof Golan. See [LICENSE](LICENSE).
