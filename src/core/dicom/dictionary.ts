/**
 * The part of the DICOM data dictionary that this viewer needs.
 *
 * An implicit VR file carries no value representation in the byte stream. The
 * parser looks the tag up here instead. The length field is always 32 bits in
 * implicit VR, so an unknown tag is still safe to skip. Only the tags that the
 * viewer reads need an entry.
 */
import { Tag } from "./tags.ts";
import type { Vr } from "./vr.ts";

const DICTIONARY = new Map<number, Vr>([
  [Tag.FileMetaInformationGroupLength, "UL"],
  [Tag.MediaStorageSopClassUid, "UI"],
  [Tag.MediaStorageSopInstanceUid, "UI"],
  [Tag.TransferSyntaxUid, "UI"],

  [Tag.SpecificCharacterSet, "CS"],
  [Tag.ImageType, "CS"],
  [Tag.SopClassUid, "UI"],
  [Tag.SopInstanceUid, "UI"],
  [Tag.StudyDate, "DA"],
  [Tag.StudyTime, "TM"],
  [Tag.Modality, "CS"],
  [Tag.Manufacturer, "LO"],
  [Tag.InstitutionName, "LO"],
  [Tag.InstitutionAddress, "ST"],
  [Tag.ReferringPhysicianName, "PN"],
  [Tag.StudyDescription, "LO"],
  [Tag.SeriesDescription, "LO"],
  [Tag.PerformingPhysicianName, "PN"],
  [Tag.OperatorsName, "PN"],
  [Tag.ManufacturerModelName, "LO"],
  [Tag.ReferencedImageSequence, "SQ"],
  [Tag.ReferencedSopClassUid, "UI"],
  [Tag.ReferencedSopInstanceUid, "UI"],
  [Tag.RelatedSeriesSequence, "SQ"],

  [Tag.PatientName, "PN"],
  [Tag.PatientId, "LO"],
  [Tag.PatientBirthDate, "DA"],
  [Tag.PatientSex, "CS"],
  [Tag.PatientAge, "AS"],
  [Tag.PatientAddress, "LO"],

  [Tag.BodyPartExamined, "CS"],
  [Tag.ScanningSequence, "CS"],
  [Tag.SequenceVariant, "CS"],
  [Tag.ScanOptions, "CS"],
  [Tag.MrAcquisitionType, "CS"],
  [Tag.SliceThickness, "DS"],
  [Tag.RepetitionTime, "DS"],
  [Tag.EchoTime, "DS"],
  [Tag.InversionTime, "DS"],
  [Tag.MagneticFieldStrength, "DS"],
  [Tag.SpacingBetweenSlices, "DS"],
  [Tag.ProtocolName, "LO"],
  [Tag.FlipAngle, "DS"],
  [Tag.PatientPosition, "CS"],

  [Tag.StudyInstanceUid, "UI"],
  [Tag.SeriesInstanceUid, "UI"],
  [Tag.StudyId, "SH"],
  [Tag.SeriesNumber, "IS"],
  [Tag.AcquisitionNumber, "IS"],
  [Tag.InstanceNumber, "IS"],
  [Tag.ImagePositionPatient, "DS"],
  [Tag.ImageOrientationPatient, "DS"],
  [Tag.FrameOfReferenceUid, "UI"],
  [Tag.SliceLocation, "DS"],

  [Tag.SamplesPerPixel, "US"],
  [Tag.PhotometricInterpretation, "CS"],
  [Tag.PlanarConfiguration, "US"],
  [Tag.NumberOfFrames, "IS"],
  [Tag.Rows, "US"],
  [Tag.Columns, "US"],
  [Tag.PixelSpacing, "DS"],
  [Tag.BitsAllocated, "US"],
  [Tag.BitsStored, "US"],
  [Tag.HighBit, "US"],
  [Tag.PixelRepresentation, "US"],
  [Tag.SmallestImagePixelValue, "US"],
  [Tag.LargestImagePixelValue, "US"],
  [Tag.WindowCenter, "DS"],
  [Tag.WindowWidth, "DS"],
  [Tag.RescaleIntercept, "DS"],
  [Tag.RescaleSlope, "DS"],
  [Tag.RescaleType, "LO"],

  [Tag.SharedFunctionalGroupsSequence, "SQ"],
  [Tag.PerFrameFunctionalGroupsSequence, "SQ"],
  [Tag.PixelMeasuresSequence, "SQ"],
  [Tag.PlanePositionSequence, "SQ"],
  [Tag.PlaneOrientationSequence, "SQ"],

  [Tag.PixelData, "OW"],
]);

/**
 * Look up the value representation of a tag.
 *
 * Returns `UN` for a tag that is not in the dictionary. An `UN` element keeps
 * its raw bytes and is skipped correctly, so an unknown tag never breaks the
 * parse.
 */
export function lookupVr(tag: number): Vr {
  return DICTIONARY.get(tag) ?? "UN";
}
