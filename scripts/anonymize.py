#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["pydicom>=3.0", "dicom-anonymizer>=2.0"]
# ///
"""De-identify a DICOM study, and prove that the result holds no secrets.

The rules come from DICOM PS3.15 Annex E, Table E.1-1, the Basic Application
Level Confidentiality Profile. The table is not written here by hand. The
`dicom-anonymizer` package ships it as data, and this script reads it.

The script removes every attribute that the basic profile names, every private
tag, every curve, and every overlay. It keeps the attributes that the viewer
needs to place the image in space and to window it. It maps each UID to a new
UID through a salted hash, so the references between the files stay correct and
the original UIDs cannot be recovered.

Anonymize a study:

    uv run scripts/anonymize.py <source-dir> --out <out-dir> --salt <secret>

Verify the result. The forbidden file holds one string per line. Keep that file
out of the repository:

    uv run scripts/anonymize.py <out-dir> --verify --forbidden-file <file>

Both steps at once:

    uv run scripts/anonymize.py <source-dir> --out <out-dir> --salt <secret> \
        --verify --forbidden-file <file>

The exit status is 1 if the verification finds a forbidden string.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pydicom
from dicomanonymizer.dicomfields_selector import dicom_anonymization_database_selector
from pydicom.dataset import Dataset

# The edition of PS3.15 that this script follows.
STANDARD_EDITION = "dicomfields_2026c"

# DeidentificationMethod is LO, so each item must stay at or below 64 bytes.
DEIDENTIFICATION_METHOD = [
    "PS3.15 Annex E basic profile",
    "private tags, curves and overlays removed",
    "UIDs replaced by salted SHA-256 hashes",
    "image and MR descriptors kept",
    "scripts/anonymize.py",
]

# PS3.16 Context ID 7050. 113100 is the basic profile.
DEIDENTIFICATION_METHOD_CODE = ("113100", "DCM", "Basic Application Confidentiality Profile")

# Attributes that the viewer needs. Most of them are outside Table E.1-1 and
# survive on their own. The few that the basic profile removes are listed here
# on purpose, and none of them names a person, a place, or a time.
#
#   SeriesDescription and ProtocolName hold the scanner protocol, such as
#   "pd_tse_fs_cor_DRB". The viewer shows that text as the name of the series.
KEPT_ATTRIBUTES = frozenset(
    {
        # Geometry.
        "ImageOrientationPatient",
        "ImagePositionPatient",
        "PixelSpacing",
        "SliceThickness",
        "SpacingBetweenSlices",
        "SliceLocation",
        "PatientPosition",
        "Laterality",
        # Pixel layout.
        "Rows",
        "Columns",
        "BitsAllocated",
        "BitsStored",
        "HighBit",
        "PixelRepresentation",
        "PhotometricInterpretation",
        "SamplesPerPixel",
        "NumberOfFrames",
        "PlanarConfiguration",
        # Display transform.
        "RescaleSlope",
        "RescaleIntercept",
        "RescaleType",
        "WindowCenter",
        "WindowWidth",
        "PresentationLUTShape",
        "SmallestImagePixelValue",
        "LargestImagePixelValue",
        # Identity of the series inside the study.
        "Modality",
        "SeriesDescription",
        "SeriesNumber",
        "InstanceNumber",
        "AcquisitionNumber",
        "ProtocolName",
        "ImageType",
        # MR acquisition parameters.
        "BodyPartExamined",
        "ScanningSequence",
        "SequenceVariant",
        "ScanOptions",
        "MRAcquisitionType",
        "SequenceName",
        "AngioFlag",
        "RepetitionTime",
        "EchoTime",
        "InversionTime",
        "EchoNumbers",
        "EchoTrainLength",
        "NumberOfAverages",
        "ImagingFrequency",
        "ImagedNucleus",
        "MagneticFieldStrength",
        "NumberOfPhaseEncodingSteps",
        "PercentSampling",
        "PercentPhaseFieldOfView",
        "PixelBandwidth",
        "FlipAngle",
        "VariableFlipAngleFlag",
        "SpecificAbsorptionRateValue",
        "InPlanePhaseEncodingDirection",
        "AcquisitionMatrix",
        # Safety facts that a reader must be able to check.
        "BurnedInAnnotation",
        "LossyImageCompression",
        "SpecificCharacterSet",
    }
)

# Repeating groups. Curve data is 50xx, overlay data is 60xx. The whole group
# goes, because an overlay can carry a burned-in name.
CURVE_GROUPS = range(0x5000, 0x5100)
OVERLAY_GROUPS = range(0x6000, 0x6100)


@dataclass(frozen=True)
class Profile:
    """The parts of Table E.1-1 that this script acts on."""

    remove: frozenset[tuple[int, int]]
    remap: frozenset[tuple[int, int]]
    masked: tuple[tuple[int, int, int, int], ...]

    def matches_masked(self, group: int, element: int) -> bool:
        return any(
            group & group_mask == want_group and element & element_mask == want_element
            for want_group, want_element, group_mask, element_mask in self.masked
        )


def load_profile() -> Profile:
    """Read Table E.1-1 and split it into the actions this script takes.

    Every action of the basic profile except U removes the attribute. Replacing
    a value with a dummy would leave a field that a reader could mistake for
    real data, so the removal is total.
    """
    table = dicom_anonymization_database_selector(STANDARD_EDITION)
    remap = {tag for tag in table["U_TAGS"] if len(tag) == 2}
    kept = {
        (tag >> 16, tag & 0xFFFF)
        for tag in (pydicom.datadict.tag_for_keyword(name) for name in KEPT_ATTRIBUTES)
        if tag is not None
    }
    remove = {tag for tag in table["ALL_TAGS"] if len(tag) == 2} - remap - kept
    masked = tuple(tag for tag in table["ALL_TAGS"] if len(tag) == 4)
    return Profile(frozenset(remove), frozenset(remap), masked)


def hashed_uid(uid: str, salt: str) -> str:
    """Map one UID to a new UID under the 2.25 root.

    The same input and salt always give the same output, so a reference from one
    file to another still points at the right object. The hash is one way, so
    the original UID cannot be read back. Without the salt an attacker cannot
    confirm a guessed UID either.
    """
    digest = hashlib.sha256(f"{salt}\x00{uid}".encode()).digest()
    return f"2.25.{int.from_bytes(digest[:16], 'big')}"


def remap_value(value: object, salt: str) -> object:
    if isinstance(value, (list, pydicom.multival.MultiValue)):
        return [hashed_uid(str(item), salt) for item in value if str(item)]
    text = str(value)
    return hashed_uid(text, salt) if text else value


def scrub(ds: Dataset, profile: Profile, salt: str) -> None:
    """Apply the profile to one dataset and to every dataset inside it."""
    for element in list(ds):
        tag = element.tag
        group, number = tag.group, tag.element
        drop = (
            tag.is_private
            or number == 0x0000  # group length, wrong after any edit
            or group in CURVE_GROUPS
            or group in OVERLAY_GROUPS
            or profile.matches_masked(group, number)
            or (group, number) in profile.remove
        )
        if drop:
            del ds[tag]
        elif (group, number) in profile.remap:
            element.value = remap_value(element.value, salt)
        elif element.VR == "SQ":
            for item in element.value:
                scrub(item, profile, salt)


def anonymize(ds: Dataset, profile: Profile, salt: str, patient_name: str) -> None:
    """De-identify one file in place."""
    scrub(ds, profile, salt)

    for name in (
        "SourceApplicationEntityTitle",
        "PrivateInformation",
        "PrivateInformationCreatorUID",
    ):
        if name in ds.file_meta:
            delattr(ds.file_meta, name)
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID

    ds.PatientName = patient_name
    ds.PatientID = "DEMO"
    ds.PatientIdentityRemoved = "YES"
    ds.DeidentificationMethod = DEIDENTIFICATION_METHOD

    code, scheme, meaning = DEIDENTIFICATION_METHOD_CODE
    item = Dataset()
    item.CodeValue = code
    item.CodingSchemeDesignator = scheme
    item.CodeMeaning = meaning
    ds.DeidentificationMethodCodeSequence = [item]


def dicom_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*.dcm") if p.is_file())


def anonymize_tree(source: Path, out: Path, salt: str, patient_name: str) -> int:
    profile = load_profile()
    files = dicom_files(source)
    if not files:
        raise SystemExit(f"no DICOM files under {source}")

    for path in files:
        ds = pydicom.dcmread(path)
        anonymize(ds, profile, salt, patient_name)
        target = out / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        ds.save_as(target, enforce_file_format=True)

    print(f"anonymized {len(files)} files from {source} to {out}")
    print(f"profile: PS3.15 Annex E basic, table {STANDARD_EDITION}")
    return len(files)


@dataclass
class VerifyReport:
    files: int = 0
    forbidden: int = 0
    hits: list[str] = field(default_factory=list)
    private_tags: list[str] = field(default_factory=list)
    not_marked: list[str] = field(default_factory=list)


def read_forbidden(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def element_texts(ds: Dataset) -> list[str]:
    """Every value in the file as text, including the file meta group."""
    texts: list[str] = []
    for element in list(ds.file_meta) + list(ds.iterall()):
        value = element.value
        if isinstance(value, bytes):
            texts.append(value.decode("latin-1"))
        elif element.VR != "SQ":
            texts.append(str(value))
    return texts


def byte_needles(secret: str) -> list[bytes]:
    """The forms one string can take inside a DICOM file."""
    lowered = secret.lower()
    return [lowered.encode("latin-1", "ignore"), lowered.encode("utf-16-le")]


def verify_tree(root: Path, forbidden: list[str]) -> VerifyReport:
    report = VerifyReport(forbidden=len(forbidden))
    needles = {secret: byte_needles(secret) for secret in forbidden}

    for path in dicom_files(root):
        report.files += 1
        raw = path.read_bytes().lower()
        ds = pydicom.dcmread(path)
        joined = "\n".join(element_texts(ds)).lower()

        for secret in forbidden:
            where = []
            if secret.lower() in joined:
                where.append("element value")
            if any(needle and needle in raw for needle in needles[secret]):
                where.append("raw bytes")
            if where:
                report.hits.append(f"{path}: {secret!r} in {' and '.join(where)}")

        private = [str(el.tag) for el in ds.iterall() if el.tag.is_private]
        if private:
            report.private_tags.append(f"{path}: {', '.join(private)}")
        if str(ds.get("PatientIdentityRemoved", "")) != "YES":
            report.not_marked.append(str(path))

    return report


def print_report(root: Path, report: VerifyReport) -> None:
    print()
    print(f"verification of {root}")
    print(f"  files scanned      : {report.files}")
    print(f"  forbidden strings  : {report.forbidden}")
    print(f"  matches found      : {len(report.hits)}")
    print(f"  private tags left  : {len(report.private_tags)}")
    print(f"  files not marked   : {len(report.not_marked)}")

    for line in report.hits[:20]:
        print(f"  FORBIDDEN STRING {line}")
    for line in report.private_tags[:20]:
        print(f"  PRIVATE TAG {line}")
    for line in report.not_marked[:20]:
        print(f"  NOT MARKED {line}")

    clean = not (report.hits or report.private_tags or report.not_marked)
    print("  result             : PASS" if clean else "  result             : FAIL")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, help="Study to read. In verify mode, the study to check."
    )
    parser.add_argument("--out", type=Path, help="Where to write the de-identified study")
    parser.add_argument("--salt", default="", help="Secret that the UID hash uses")
    parser.add_argument("--patient-name", default="Anonymous^Demo")
    parser.add_argument(
        "--verify", action="store_true", help="Scan the result for forbidden strings"
    )
    parser.add_argument("--forbidden-file", type=Path, help="One forbidden string per line")
    args = parser.parse_args()

    if args.out:
        if not args.salt:
            raise SystemExit("--salt is required when writing. Without it the UIDs are guessable.")
        anonymize_tree(args.source, args.out, args.salt, args.patient_name)

    if not args.verify:
        return

    if not args.forbidden_file:
        raise SystemExit("--verify needs --forbidden-file")
    root = args.out or args.source
    report = verify_tree(root, read_forbidden(args.forbidden_file))
    print_report(root, report)
    if report.hits or report.private_tags or report.not_marked:
        sys.exit(1)


if __name__ == "__main__":
    main()
