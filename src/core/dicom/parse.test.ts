import { describe, expect, it } from "vite-plus/test";
import { parseDicom } from "./parse.ts";
import { getNumber, getNumbers, getString, getStrings, getSequence } from "./access.ts";
import { readFixture, readSeries } from "./fixtures.ts";
import { Tag } from "./tags.ts";

const CORONAL = readSeries("pd_tse_fs_cor_DRB");

describe("parseDicom", () => {
  it("rejects bytes that are not DICOM", () => {
    expect(() => parseDicom(new Uint8Array(200))).toThrow(/not a DICOM file/i);
  });

  it("rejects a file that is too short to hold a preamble", () => {
    expect(() => parseDicom(new Uint8Array(8))).toThrow(/too short/i);
  });

  it("reads the transfer syntax from the file meta group", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(ds.transferSyntaxUid).toBe("1.2.840.10008.1.2.1");
    expect(ds.littleEndian).toBe(true);
    expect(ds.implicitVr).toBe(false);
  });

  it("reads string values and trims the padding byte", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(getString(ds, Tag.Modality)).toBe("MR");
    expect(getString(ds, Tag.SeriesDescription)).toBe("pd_tse_fs_cor_DRB");
    expect(getString(ds, Tag.BodyPartExamined)).toBe("ELBOW");
  });

  it("reads binary numbers", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(getNumber(ds, Tag.Rows)).toBe(64);
    expect(getNumber(ds, Tag.Columns)).toBe(64);
    expect(getNumber(ds, Tag.BitsAllocated)).toBe(16);
    expect(getNumber(ds, Tag.BitsStored)).toBe(12);
    expect(getNumber(ds, Tag.PixelRepresentation)).toBe(0);
  });

  it("reads decimal strings as numbers", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(getNumbers(ds, Tag.PixelSpacing)).toEqual([0.2734, 0.2734]);
    expect(getNumber(ds, Tag.SliceThickness)).toBe(3);
    expect(getNumber(ds, Tag.SpacingBetweenSlices)).toBe(3.3);
  });

  it("splits multi-valued strings on the backslash", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(getStrings(ds, Tag.ImageType)).toContain("ORIGINAL");
    expect(getStrings(ds, Tag.ImageType)).toContain("PRIMARY");
  });

  it("reads the six direction cosines of the image plane", () => {
    const ds = parseDicom(CORONAL[0]!);
    const orientation = getNumbers(ds, Tag.ImageOrientationPatient);
    expect(orientation).toHaveLength(6);
    expect(orientation[0]).toBeCloseTo(-0.510084, 6);
    expect(orientation[1]).toBeCloseTo(0.860125, 6);
    expect(orientation[5]).toBeCloseTo(-1, 6);
  });

  it("returns undefined for a tag that is absent", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(getString(ds, Tag.PatientAddress)).toBeUndefined();
    expect(getNumber(ds, Tag.NumberOfFrames)).toBeUndefined();
  });

  it("parses nested sequences", () => {
    const ds = parseDicom(CORONAL[0]!);
    const related = getSequence(ds, Tag.RelatedSeriesSequence);
    expect(related.length).toBeGreaterThan(0);
    const inner = getSequence(related[0]!, Tag.ReferencedImageSequence);
    expect(inner.length).toBeGreaterThan(0);
    expect(getString(inner[0]!, Tag.ReferencedSopClassUid)).toMatch(/^1\.2\.840\.10008\./);
  });

  it("carries no patient identity", () => {
    const ds = parseDicom(CORONAL[0]!);
    expect(getString(ds, Tag.PatientName)).toBe("Anonymous^Test");
    expect(getString(ds, Tag.PatientBirthDate)).toBeUndefined();
    expect(getString(ds, Tag.InstitutionName)).toBeUndefined();
  });
});

describe("transfer syntaxes", () => {
  const cases = [
    ["explicit-le.dcm", "1.2.840.10008.1.2.1", false, true],
    ["implicit-le.dcm", "1.2.840.10008.1.2", true, true],
    ["explicit-be.dcm", "1.2.840.10008.1.2.2", false, false],
    ["rle.dcm", "1.2.840.10008.1.2.5", false, true],
  ] as const;

  it.each(cases)("reads headers from %s", (file, uid, implicitVr, littleEndian) => {
    const ds = parseDicom(readFixture(`syntax/${file}`));
    expect(ds.transferSyntaxUid).toBe(uid);
    expect(ds.implicitVr).toBe(implicitVr);
    expect(ds.littleEndian).toBe(littleEndian);
    expect(getNumber(ds, Tag.Rows)).toBe(64);
    expect(getNumber(ds, Tag.Columns)).toBe(64);
    expect(getString(ds, Tag.Modality)).toBe("MR");
  });

  it("infers the value representation for implicit VR", () => {
    const ds = parseDicom(readFixture("syntax/implicit-le.dcm"));
    expect(getNumbers(ds, Tag.PixelSpacing)).toEqual([0.2734, 0.2734]);
    expect(getNumbers(ds, Tag.ImagePositionPatient)).toHaveLength(3);
  });

  it("splits encapsulated pixel data into fragments", () => {
    const ds = parseDicom(readFixture("syntax/rle.dcm"));
    expect(ds.encapsulated).toBe(true);
    const pixelData = ds.elements.get(Tag.PixelData);
    expect(pixelData?.fragments?.length).toBeGreaterThan(0);
  });

  it("marks uncompressed syntaxes as not encapsulated", () => {
    expect(parseDicom(readFixture("syntax/explicit-le.dcm")).encapsulated).toBe(false);
  });
});
