#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["pydicom>=3.0", "numpy"]
# ///
"""Build the DICOM test fixtures.

The fixtures are small, de-identified crops of a real elbow MRI. They keep every
header field that the parser reads, so the tests run against real data and never
need a mock.

Usage:
    uv run scripts/make_fixtures.py <source-dicom-root> [--out tests/fixtures]

The source data is private and is not in this repository.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    ExplicitVRBigEndian,
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    RLELossless,
)

# Tags that name a person, a place, or an appointment. All of them are removed.
IDENTIFYING_TAGS = [
    "AccessionNumber",
    "AcquisitionDate",
    "AcquisitionDateTime",
    "AcquisitionTime",
    "AdmittingDiagnosesDescription",
    "ContentDate",
    "ContentTime",
    "CurrentPatientLocation",
    "InstanceCreationDate",
    "InstanceCreationTime",
    "IssuerOfPatientID",
    "PatientSex",
    "InstitutionAddress",
    "InstitutionName",
    "InstitutionalDepartmentName",
    "NameOfPhysiciansReadingStudy",
    "OperatorsName",
    "OtherPatientIDs",
    "OtherPatientNames",
    "PatientAddress",
    "PatientAge",
    "PatientBirthDate",
    "PatientBirthTime",
    "PatientID",
    "PatientName",
    "PatientSize",
    "PatientTelephoneNumbers",
    "PatientWeight",
    "PerformedProcedureStepDescription",
    "PerformedProcedureStepID",
    "PerformedProcedureStepStartDate",
    "PerformedProcedureStepStartTime",
    "PerformingPhysicianName",
    "PhysiciansOfRecord",
    "ReferringPhysicianName",
    "RequestAttributesSequence",
    "RequestedProcedureDescription",
    "ScheduledProcedureStepDescription",
    "ScheduledProcedureStepID",
    "SeriesDate",
    "SeriesTime",
    "StationName",
    "StudyDate",
    "StudyID",
    "StudyTime",
]

CROP = 64
SLICES_PER_SERIES = 3


def de_identify(ds: Dataset) -> None:
    """Remove every identifying field and every private tag, in place."""
    ds.remove_private_tags()
    for name in IDENTIFYING_TAGS:
        if name in ds:
            delattr(ds, name)
    ds.PatientName = "Anonymous^Test"
    ds.PatientID = "FIXTURE"
    ds.PatientIdentityRemoved = "YES"
    ds.DeidentificationMethod = "scripts/make_fixtures.py"


def crop_center(ds: Dataset, size: int) -> None:
    """Cut a square from the middle of the image and correct the geometry.

    The crop moves the top-left corner of the image. ImagePositionPatient names
    the center of that corner voxel, so it moves with the crop. If it did not,
    every geometry test would pass against a wrong origin.
    """
    pixels = ds.pixel_array
    rows, cols = pixels.shape
    row0 = (rows - size) // 2
    col0 = (cols - size) // 2

    row_spacing, col_spacing = (float(v) for v in ds.PixelSpacing)
    orientation = [float(v) for v in ds.ImageOrientationPatient]
    row_dir = np.array(orientation[0:3])
    col_dir = np.array(orientation[3:6])
    origin = np.array([float(v) for v in ds.ImagePositionPatient])

    # DICOM row direction runs along a row (increasing column index).
    new_origin = origin + row_dir * (col0 * col_spacing) + col_dir * (row0 * row_spacing)

    cropped = np.ascontiguousarray(pixels[row0 : row0 + size, col0 : col0 + size])
    ds.PixelData = cropped.tobytes()
    ds.Rows, ds.Columns = size, size
    ds.ImagePositionPatient = [f"{v:.6f}" for v in new_origin]
    for tag in ("SmallestImagePixelValue", "LargestImagePixelValue"):
        if tag in ds:
            delattr(ds, tag)


def write(ds: Dataset, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(path, enforce_file_format=True)


def transcode(source: Path, out_dir: Path) -> None:
    """Write the same image under four transfer syntaxes.

    The parser must read all of them and produce identical pixels. That property
    is what the round-trip test asserts.

    Nested sequences are dropped here. pydicom cannot convert an undefined-length
    sequence to big endian without corrupting it, and the series fixtures already
    cover nested sequence parsing.
    """
    variants = {
        "explicit-le.dcm": (ExplicitVRLittleEndian, False, True),
        "implicit-le.dcm": (ImplicitVRLittleEndian, True, True),
        "explicit-be.dcm": (ExplicitVRBigEndian, False, False),
        "rle.dcm": (RLELossless, False, True),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (syntax, implicit_vr, little_endian) in variants.items():
        ds = pydicom.dcmread(source)
        ds.file_meta = FileMetaDataset(ds.file_meta)
        for element in list(ds.iterall()):
            if element.VR == "SQ" and element.tag in ds:
                del ds[element.tag]
        if syntax == RLELossless:
            ds.compress(RLELossless)
        else:
            ds.file_meta.TransferSyntaxUID = syntax
        if not little_endian:
            # pydicom writes PixelData verbatim. A big endian file needs the
            # 16-bit words swapped by hand, or the fixture lies about its bytes.
            ds.PixelData = np.frombuffer(ds.PixelData, dtype="<u2").astype(">u2").tobytes()
        ds.set_original_encoding(implicit_vr, little_endian)
        pydicom.dcmwrite(
            out_dir / name,
            ds,
            enforce_file_format=True,
            implicit_vr=implicit_vr,
            little_endian=little_endian,
        )


def write_signed(source: Path, out_dir: Path) -> None:
    """Write a copy with signed pixels and a negative rescale intercept.

    MR data is unsigned. CT is signed and uses a rescale intercept of -1024.
    The fixture proves the parser handles both without a CT dataset on hand.
    """
    ds = pydicom.dcmread(source)
    shifted = ds.pixel_array.astype(np.int32) - 1024
    ds.PixelData = shifted.astype(np.int16).tobytes()
    ds.PixelRepresentation = 1
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.RescaleIntercept = -1024
    ds.RescaleSlope = 2
    write(ds, out_dir / "signed-rescaled.dcm")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Root of the source DICOM tree")
    parser.add_argument("--out", type=Path, default=Path("tests/fixtures"))
    args = parser.parse_args()

    series_dirs = sorted(p for p in args.source.rglob("*") if p.is_dir() and any(p.glob("*.dcm")))
    if not series_dirs:
        raise SystemExit(f"no DICOM series under {args.source}")

    if args.out.exists():
        shutil.rmtree(args.out)

    manifest: dict[str, object] = {"series": []}
    first_slice: Path | None = None

    for series_dir in series_dirs:
        files = sorted(series_dir.glob("*.dcm"), key=lambda p: int(p.stem.rsplit("_", 1)[1]))
        # Take slices from the middle of the stack, where the anatomy is.
        middle = len(files) // 2
        picked = files[middle : middle + SLICES_PER_SERIES]
        out_dir = args.out / "series" / series_dir.name

        for index, source in enumerate(picked):
            ds = pydicom.dcmread(source)
            de_identify(ds)
            crop_center(ds, CROP)
            target = out_dir / f"{index + 1:03d}.dcm"
            write(ds, target)
            if first_slice is None:
                first_slice = target

        head = pydicom.dcmread(out_dir / "001.dcm")
        manifest["series"].append(
            {
                "name": series_dir.name,
                "files": len(picked),
                "rows": int(head.Rows),
                "columns": int(head.Columns),
                "pixelSpacing": [float(v) for v in head.PixelSpacing],
                "sliceThickness": float(head.SliceThickness),
                "spacingBetweenSlices": float(head.SpacingBetweenSlices),
                "orientation": [float(v) for v in head.ImageOrientationPatient],
                "seriesInstanceUid": str(head.SeriesInstanceUID),
            }
        )

    assert first_slice is not None
    transcode(first_slice, args.out / "syntax")
    write_signed(first_slice, args.out / "syntax")

    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(p.stat().st_size for p in args.out.rglob("*.dcm"))
    print(f"wrote {len(list(args.out.rglob('*.dcm')))} fixtures ({total / 1024:.0f} KiB) to {args.out}")


if __name__ == "__main__":
    main()
