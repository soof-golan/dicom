#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["pydicom>=3.0", "numpy", "brotli", "zstandard"]
# ///
"""Pack a DICOM study into raw volumes that a browser can stream.

Each series becomes one file of raw voxels and one half-size preview. A single
`manifest.json` holds the sidecar for every file: the grid size, the spacing,
the voxel-to-patient affine, the value range, the rescale, and the window.

The voxel file has no header and no container. It is the stored values, little
endian, in the same order as `src/core/volume/build.ts` keeps them:

    offset(i, j, k) = (k * rows * columns + j * columns + i) * bytesPerVoxel

`i` runs across a row, `j` runs down a column, `k` runs through the slices. The
byte layout is described in full in `docs/demo-dataset.md`.

Pack a study:

    uv run scripts/pack_volume.py <study-dir> --out <out-dir>

Measure the three candidate encodings before you choose one:

    uv run scripts/pack_volume.py <study-dir> --measure
"""

from __future__ import annotations

import argparse
import gzip
import json
import time
from dataclasses import dataclass
from pathlib import Path

import brotli
import numpy as np
import pydicom
import zstandard
from pydicom.dataset import Dataset

FORMAT = "dicom-viewer/packed-volume@1"

GZIP_LEVEL = 9
BROTLI_QUALITY = 11
ZSTD_LEVEL = 19


@dataclass(frozen=True)
class Grid:
    """One 3D array of voxels and the geometry that places it in the patient."""

    dims: tuple[int, int, int]
    spacing: tuple[float, float, float]
    origin: tuple[float, float, float]
    axes: tuple[tuple[float, float, float], ...]
    voxels: np.ndarray

    def affine(self) -> list[float]:
        """The 4x4 voxel-to-patient matrix, column major, as WebGL wants it."""
        columns = [
            [axis * self.spacing[index] for axis in self.axes[index]] + [0.0] for index in range(3)
        ]
        return [value for column in columns for value in column] + [*self.origin, 1.0]


@dataclass(frozen=True)
class SeriesVolume:
    name: str
    series_instance_uid: str
    series_number: int
    description: str
    modality: str
    signed: bool
    rescale_slope: float
    rescale_intercept: float
    window_center: float | None
    window_width: float | None
    warnings: list[str]
    grid: Grid


def unit(vector: np.ndarray) -> np.ndarray:
    size = float(np.linalg.norm(vector))
    return vector if size == 0 else vector / size


def stored_values(ds: Dataset) -> np.ndarray:
    """The pixels with the unused high bits removed.

    A Siemens MR image stores 12 bits inside 16, and the scanner may leave
    anything in the other 4. `src/core/dicom/pixels.ts` masks them off, so the
    packer must do the same or the two disagree.
    """
    pixels = ds.pixel_array
    bits_allocated = int(ds.BitsAllocated)
    bits_stored = int(ds.BitsStored)
    if bits_stored >= bits_allocated:
        return pixels

    shift = int(ds.HighBit) + 1 - bits_stored
    mask = (1 << bits_stored) - 1
    masked = (pixels >> shift) & mask
    if int(ds.PixelRepresentation) == 1:
        sign_bit = 1 << (bits_stored - 1)
        masked = np.where(masked & sign_bit, masked - (1 << bits_stored), masked)
    return masked


def first_number(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, (list, pydicom.multival.MultiValue)):
        return float(value[0]) if len(value) else None
    return float(value)


def slice_spacing(
    positions: np.ndarray, normal: np.ndarray, head: Dataset
) -> tuple[float, list[str]]:
    """The step between slices, and a warning when the steps are uneven."""
    fallback = float(getattr(head, "SpacingBetweenSlices", None) or head.SliceThickness or 1)
    if len(positions) < 2:
        return fallback, []

    gaps = np.diff(positions @ normal)
    step = float(np.median(gaps))
    if step <= 0:
        return fallback, ["Slice positions do not advance."]

    uneven = int(np.sum(np.abs(gaps - step) > 0.01))
    warnings = []
    if uneven:
        warnings.append(f"Slice spacing is uneven in {uneven} of {len(gaps)} gaps.")
    return step, warnings


def read_series(series_dir: Path) -> SeriesVolume:
    """Build one volume the same way `buildVolume` in the TypeScript core does."""
    datasets = [pydicom.dcmread(path) for path in sorted(series_dir.glob("*.dcm"))]
    head = datasets[0]
    orientation = np.array([float(v) for v in head.ImageOrientationPatient])
    axis_i = unit(orientation[0:3])
    axis_j = unit(orientation[3:6])
    normal = unit(np.cross(axis_i, axis_j))

    datasets.sort(
        key=lambda ds: (
            float(np.array([float(v) for v in ds.ImagePositionPatient]) @ normal),
            int(ds.InstanceNumber),
        )
    )
    head = datasets[0]

    positions = np.array([[float(v) for v in ds.ImagePositionPatient] for ds in datasets])
    step, warnings = slice_spacing(positions, normal, head)

    rows, columns = int(head.Rows), int(head.Columns)
    row_spacing, column_spacing = (float(v) for v in head.PixelSpacing)
    signed = int(head.PixelRepresentation) == 1
    dtype = np.dtype("<i2") if signed else np.dtype("<u2")

    voxels = np.empty((len(datasets), rows, columns), dtype=dtype)
    for index, ds in enumerate(datasets):
        voxels[index] = stored_values(ds)

    return SeriesVolume(
        name=series_dir.name,
        series_instance_uid=str(head.SeriesInstanceUID),
        series_number=int(head.SeriesNumber),
        description=str(
            getattr(head, "SeriesDescription", "") or getattr(head, "ProtocolName", "")
        ),
        modality=str(head.Modality),
        signed=signed,
        rescale_slope=float(getattr(head, "RescaleSlope", 1) or 1),
        rescale_intercept=float(getattr(head, "RescaleIntercept", 0) or 0),
        window_center=first_number(getattr(head, "WindowCenter", None)),
        window_width=first_number(getattr(head, "WindowWidth", None)),
        warnings=warnings,
        grid=Grid(
            dims=(columns, rows, len(datasets)),
            # i runs across a row, so it steps by the column spacing.
            spacing=(column_spacing, row_spacing, step),
            origin=tuple(positions[0]),
            axes=(tuple(axis_i), tuple(axis_j), tuple(normal)),
            voxels=voxels,
        ),
    )


def halve_in_plane(grid: Grid) -> Grid:
    """Average each 2x2 block of a slice. The slice count does not change.

    The new sample sits at the center of the block, which is half a voxel from
    the old first sample along both in-plane axes. The origin moves with it, or
    the preview and the full volume would not line up.
    """
    columns, rows, slices = grid.dims
    half_columns, half_rows = columns // 2, rows // 2
    blocks = grid.voxels[:, : half_rows * 2, : half_columns * 2]
    reduced = blocks.reshape(slices, half_rows, 2, half_columns, 2).mean(axis=(2, 4))

    axis_i = np.array(grid.axes[0])
    axis_j = np.array(grid.axes[1])
    origin = np.array(grid.origin) + 0.5 * grid.spacing[0] * axis_i + 0.5 * grid.spacing[1] * axis_j

    # floor(x + 0.5) sends a half up. np.rint sends a half to the even
    # neighbour, and 3095 of the 12288 preview samples in the test fixtures are
    # exact halves. JavaScript Math.round sends a half up, so the packer must
    # too, or the round-trip test can only ever sample around the difference.
    return Grid(
        dims=(half_columns, half_rows, slices),
        spacing=(grid.spacing[0] * 2, grid.spacing[1] * 2, grid.spacing[2]),
        origin=tuple(origin),
        axes=grid.axes,
        voxels=np.floor(reduced + 0.5).astype(grid.voxels.dtype),
    )


def sidecar(series: SeriesVolume, grid: Grid, url: str) -> dict:
    values = grid.voxels
    return {
        "url": url,
        "bytes": int(values.nbytes),
        "dataType": "int16" if series.signed else "uint16",
        "dims": list(grid.dims),
        "spacing": [round(v, 9) for v in grid.spacing],
        "origin": [round(v, 9) for v in grid.origin],
        "axes": [[round(v, 12) for v in axis] for axis in grid.axes],
        "voxelToPatient": [round(v, 12) for v in grid.affine()],
        "valueRange": {"min": int(values.min()), "max": int(values.max())},
        "rescaleSlope": series.rescale_slope,
        "rescaleIntercept": series.rescale_intercept,
        **({"windowCenter": series.window_center} if series.window_center is not None else {}),
        **({"windowWidth": series.window_width} if series.window_width is not None else {}),
        "description": series.description,
        "modality": series.modality,
        "seriesInstanceUid": series.series_instance_uid,
        "warnings": series.warnings,
    }


def series_directories(root: Path) -> list[Path]:
    directories = sorted(p for p in root.rglob("*") if p.is_dir() and any(p.glob("*.dcm")))
    if not directories:
        raise SystemExit(f"no DICOM series under {root}")
    return directories


def pack(root: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    entries = []

    for directory in series_directories(root):
        series = read_series(directory)
        preview = halve_in_plane(series.grid)

        full_name = f"{series.name}.raw"
        preview_name = f"{series.name}.preview.raw"
        (out / full_name).write_bytes(series.grid.voxels.tobytes())
        (out / preview_name).write_bytes(preview.voxels.tobytes())

        entries.append(
            {
                "name": series.name,
                "seriesNumber": series.series_number,
                "full": sidecar(series, series.grid, full_name),
                "preview": sidecar(series, preview, preview_name),
            }
        )
        print(
            f"{series.name}: {series.grid.dims} "
            f"{series.grid.voxels.nbytes / 1e6:.1f} MB, preview {preview.voxels.nbytes / 1e6:.1f} MB"
        )

    entries.sort(key=lambda entry: entry["seriesNumber"])
    manifest = {"format": FORMAT, "voxelOrder": "i fastest, then j, then k", "series": entries}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    total = sum(path.stat().st_size for path in out.iterdir())
    print(f"wrote {len(entries)} series to {out} ({total / 1e6:.1f} MB before transport encoding)")


def measure(root: Path) -> None:
    """Compress each raw volume three ways and print what each one costs."""
    header = f"{'file':<30}{'raw MB':>9}{'gzip MB':>9}{'br MB':>9}{'zstd MB':>9}"
    header += f"{'gzip x':>8}{'br x':>8}{'zstd x':>8}{'br s':>8}"
    print(header)
    print("-" * len(header))

    totals = [0, 0, 0, 0]
    for directory in series_directories(root):
        series = read_series(directory)
        grids = {series.name: series.grid, f"{series.name} preview": halve_in_plane(series.grid)}
        for label, grid in grids.items():
            raw = grid.voxels.tobytes()

            packed_gzip = gzip.compress(raw, GZIP_LEVEL)
            started = time.monotonic()
            packed_brotli = brotli.compress(raw, quality=BROTLI_QUALITY)
            brotli_seconds = time.monotonic() - started
            packed_zstd = zstandard.ZstdCompressor(level=ZSTD_LEVEL).compress(raw)

            sizes = [len(raw), len(packed_gzip), len(packed_brotli), len(packed_zstd)]
            totals = [total + size for total, size in zip(totals, sizes)]
            print(
                f"{label:<30}"
                + "".join(f"{size / 1e6:>9.2f}" for size in sizes)
                + "".join(f"{sizes[0] / size:>8.2f}" for size in sizes[1:])
                + f"{brotli_seconds:>8.1f}"
            )

    print("-" * len(header))
    print(
        f"{'total':<30}"
        + "".join(f"{size / 1e6:>9.2f}" for size in totals)
        + "".join(f"{totals[0] / size:>8.2f}" for size in totals[1:])
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Root of the de-identified study")
    parser.add_argument("--out", type=Path, help="Where to write the packed volumes")
    parser.add_argument("--measure", action="store_true", help="Print a compression table and stop")
    args = parser.parse_args()

    if args.measure:
        measure(args.source)
        return
    if not args.out:
        raise SystemExit("--out is required unless you pass --measure")
    pack(args.source, args.out)


if __name__ == "__main__":
    main()
