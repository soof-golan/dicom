import { describe, expect, it } from "vite-plus/test";
import { readSeries, SERIES_NAMES } from "../dicom/fixtures.ts";
import { readInstance } from "../dicom/instance.ts";
import { parseDicom } from "../dicom/parse.ts";
import { buildVolume } from "../volume/build.ts";
import { findSequencePair, readSequenceKind } from "./sequence.ts";

const volumeOf = (name: (typeof SERIES_NAMES)[number]) =>
  buildVolume(readSeries(name).map((bytes) => readInstance(parseDicom(bytes))));

const coronalFatSat = volumeOf("pd_tse_fs_cor_DRB");
const coronalT1 = volumeOf("t1_tse_cor_DRB");
const axialFatSat = volumeOf("pd_tse_fs_tra_DRB");
const sagittalFatSat = volumeOf("pd_tse_fs_sag_DRB");

describe("readSequenceKind", () => {
  it("reads the four protocol names of the real study", () => {
    expect(readSequenceKind("t1_tse_cor_DRB")).toBe("t1");
    expect(readSequenceKind("pd_tse_fs_cor_DRB")).toBe("fatsat");
    expect(readSequenceKind("pd_tse_fs_tra_DRB")).toBe("fatsat");
    expect(readSequenceKind("pd_tse_fs_sag_DRB")).toBe("fatsat");
  });

  it("puts fat saturation before the weighting", () => {
    // A fat-saturated T2 behaves like a fat-saturated PD, not like a T2.
    expect(readSequenceKind("t2_tse_fs_ax")).toBe("fatsat");
    expect(readSequenceKind("t2_tse_ax")).toBe("t2");
  });

  it("reads the other names for fat suppression", () => {
    for (const name of ["STIR cor", "t2 spair sag", "TIRM_tra", "T1 FATSAT post"]) {
      expect(readSequenceKind(name)).toBe("fatsat");
    }
  });

  it("does not find t1 inside an unrelated word", () => {
    expect(readSequenceKind("localizer")).toBe("unknown");
    expect(readSequenceKind("MPRAGE")).toBe("unknown");
  });

  it("reads a description that names nothing as unknown", () => {
    expect(readSequenceKind("")).toBe("unknown");
    expect(readSequenceKind("Series 4")).toBe("unknown");
  });
});

describe("findSequencePair", () => {
  const study = [coronalFatSat, coronalT1, axialFatSat, sagittalFatSat];

  it("pairs the coronal T1 with the coronal fat-sat, not the axial one", () => {
    // Every fat-sat series is a legal partner. The coronal one wins because it
    // was cut at the same angle, so no detail is lost to the slice gap.
    const pair = findSequencePair(coronalT1, study);
    expect(pair?.fatsat.description).toBe("pd_tse_fs_cor_DRB");
    expect(pair?.t1.description).toBe("t1_tse_cor_DRB");
    expect(pair?.oblique).toBe(false);
  });

  it("finds the same pair when the fat-sat series is the active one", () => {
    const pair = findSequencePair(coronalFatSat, study);
    expect(pair?.t1.description).toBe("t1_tse_cor_DRB");
    expect(pair?.fatsat.description).toBe("pd_tse_fs_cor_DRB");
  });

  it("reports an oblique pair when only a series at another angle is left", () => {
    const pair = findSequencePair(axialFatSat, [axialFatSat, coronalT1]);
    expect(pair?.oblique).toBe(true);
  });

  it("finds no pair when the study holds one sequence", () => {
    expect(findSequencePair(coronalFatSat, [coronalFatSat, axialFatSat])).toBeUndefined();
  });

  it("refuses a partner from another frame of reference", () => {
    const stranger = { ...coronalT1, frameOfReferenceUid: "1.2.3.4" };
    expect(findSequencePair(coronalFatSat, [coronalFatSat, stranger])).toBeUndefined();
  });

  it("finds no pair for a series whose sequence it cannot read", () => {
    const unnamed = { ...coronalT1, description: "Series 7" };
    expect(findSequencePair(unnamed, study)).toBeUndefined();
  });

  it("never pairs a series with itself", () => {
    expect(findSequencePair(coronalT1, [coronalT1])).toBeUndefined();
  });
});
