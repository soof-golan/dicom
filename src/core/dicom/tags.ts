/**
 * DICOM tag numbers.
 *
 * A tag is a group number and an element number. This module packs them into
 * one integer as `group * 0x10000 + element`. Multiplication is used instead of
 * a bit shift because a bit shift in JavaScript works on 32-bit signed
 * integers, and the pixel data group (0x7FE0) overflows into a negative value.
 */

export function tag(group: number, element: number): number {
  return group * 0x10000 + element;
}

export function tagGroup(value: number): number {
  return Math.floor(value / 0x10000);
}

export function tagElement(value: number): number {
  return value % 0x10000;
}

/** Format a tag the way the DICOM standard prints it, for example `(0028,0010)`. */
export function formatTag(value: number): string {
  const group = tagGroup(value).toString(16).padStart(4, "0");
  const element = tagElement(value).toString(16).padStart(4, "0");
  return `(${group},${element})`;
}

/** A group-length element. Every group can have one, and none of them matter. */
export function isGroupLength(value: number): boolean {
  return tagElement(value) === 0x0000;
}

/** Private tags live in odd-numbered groups. */
export function isPrivate(value: number): boolean {
  return tagGroup(value) % 2 === 1;
}

export const Tag = {
  // File meta (group 0002). Always explicit VR little endian.
  FileMetaInformationGroupLength: 0x0002_0000,
  MediaStorageSopClassUid: 0x0002_0002,
  MediaStorageSopInstanceUid: 0x0002_0003,
  TransferSyntaxUid: 0x0002_0010,

  // Identity and study description.
  SpecificCharacterSet: 0x0008_0005,
  ImageType: 0x0008_0008,
  SopClassUid: 0x0008_0016,
  SopInstanceUid: 0x0008_0018,
  StudyDate: 0x0008_0020,
  StudyTime: 0x0008_0030,
  Modality: 0x0008_0060,
  Manufacturer: 0x0008_0070,
  InstitutionName: 0x0008_0080,
  InstitutionAddress: 0x0008_0081,
  ReferringPhysicianName: 0x0008_0090,
  StudyDescription: 0x0008_1030,
  SeriesDescription: 0x0008_103e,
  PerformingPhysicianName: 0x0008_1050,
  OperatorsName: 0x0008_1070,
  ManufacturerModelName: 0x0008_1090,
  ReferencedImageSequence: 0x0008_1140,
  ReferencedSopClassUid: 0x0008_1150,
  ReferencedSopInstanceUid: 0x0008_1155,
  RelatedSeriesSequence: 0x0008_1250,

  PatientName: 0x0010_0010,
  PatientId: 0x0010_0020,
  PatientBirthDate: 0x0010_0030,
  PatientSex: 0x0010_0040,
  PatientAge: 0x0010_1010,
  PatientAddress: 0x0010_1040,

  // Acquisition.
  BodyPartExamined: 0x0018_0015,
  ScanningSequence: 0x0018_0020,
  SequenceVariant: 0x0018_0021,
  ScanOptions: 0x0018_0022,
  MrAcquisitionType: 0x0018_0023,
  SliceThickness: 0x0018_0050,
  RepetitionTime: 0x0018_0080,
  EchoTime: 0x0018_0081,
  InversionTime: 0x0018_0082,
  MagneticFieldStrength: 0x0018_0087,
  SpacingBetweenSlices: 0x0018_0088,
  ProtocolName: 0x0018_1030,
  FlipAngle: 0x0018_1314,
  PatientPosition: 0x0018_5100,

  // Geometry and identity of the frame of reference.
  StudyInstanceUid: 0x0020_000d,
  SeriesInstanceUid: 0x0020_000e,
  StudyId: 0x0020_0010,
  SeriesNumber: 0x0020_0011,
  AcquisitionNumber: 0x0020_0012,
  InstanceNumber: 0x0020_0013,
  ImagePositionPatient: 0x0020_0032,
  ImageOrientationPatient: 0x0020_0037,
  FrameOfReferenceUid: 0x0020_0052,
  SliceLocation: 0x0020_1041,

  // Pixel description.
  SamplesPerPixel: 0x0028_0002,
  PhotometricInterpretation: 0x0028_0004,
  PlanarConfiguration: 0x0028_0006,
  NumberOfFrames: 0x0028_0008,
  Rows: 0x0028_0010,
  Columns: 0x0028_0011,
  PixelSpacing: 0x0028_0030,
  BitsAllocated: 0x0028_0100,
  BitsStored: 0x0028_0101,
  HighBit: 0x0028_0102,
  PixelRepresentation: 0x0028_0103,
  SmallestImagePixelValue: 0x0028_0106,
  LargestImagePixelValue: 0x0028_0107,
  WindowCenter: 0x0028_1050,
  WindowWidth: 0x0028_1051,
  RescaleIntercept: 0x0028_1052,
  RescaleSlope: 0x0028_1053,
  RescaleType: 0x0028_1054,

  // Multi-frame geometry.
  SharedFunctionalGroupsSequence: 0x5200_9229,
  PerFrameFunctionalGroupsSequence: 0x5200_9230,
  PixelMeasuresSequence: 0x0028_9110,
  PlanePositionSequence: 0x0020_9113,
  PlaneOrientationSequence: 0x0020_9116,

  ItemStart: 0xfffe_e000,
  ItemDelimiter: 0xfffe_e00d,
  SequenceDelimiter: 0xfffe_e0dd,

  PixelData: 0x7fe0_0010,
} as const;

export type TagName = keyof typeof Tag;
