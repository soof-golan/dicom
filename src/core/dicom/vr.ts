/**
 * Value Representations: the type system of DICOM.
 *
 * Each element carries a two-letter VR that says how to read its bytes. In
 * explicit VR files the VR is in the byte stream. In implicit VR files it is
 * not, and the parser looks it up in the data dictionary.
 */

export type Vr =
  | "AE"
  | "AS"
  | "AT"
  | "CS"
  | "DA"
  | "DS"
  | "DT"
  | "FL"
  | "FD"
  | "IS"
  | "LO"
  | "LT"
  | "OB"
  | "OD"
  | "OF"
  | "OL"
  | "OV"
  | "OW"
  | "PN"
  | "SH"
  | "SL"
  | "SQ"
  | "SS"
  | "ST"
  | "SV"
  | "TM"
  | "UC"
  | "UI"
  | "UL"
  | "UN"
  | "UR"
  | "US"
  | "UT"
  | "UV";

/**
 * VRs whose explicit header is 12 bytes, not 8.
 *
 * These use two reserved bytes and a 32-bit length, because their values can be
 * longer than 65535 bytes.
 */
const LONG_HEADER: ReadonlySet<string> = new Set([
  "OB",
  "OD",
  "OF",
  "OL",
  "OV",
  "OW",
  "SQ",
  "SV",
  "UC",
  "UN",
  "UR",
  "UT",
  "UV",
]);

export function hasLongHeader(vr: string): boolean {
  return LONG_HEADER.has(vr);
}

/** VRs whose value is text. Everything else is binary. */
const TEXT: ReadonlySet<string> = new Set([
  "AE",
  "AS",
  "CS",
  "DA",
  "DS",
  "DT",
  "IS",
  "LO",
  "LT",
  "PN",
  "SH",
  "ST",
  "TM",
  "UC",
  "UI",
  "UR",
  "UT",
]);

export function isText(vr: string): boolean {
  return TEXT.has(vr);
}

/**
 * VRs that hold several values divided by a backslash.
 *
 * Text VRs for free-form text (LT, ST, UT, UR) never split. A backslash inside
 * them is a literal character.
 */
const SINGLE_VALUE: ReadonlySet<string> = new Set(["LT", "ST", "UT", "UR"]);

export function splitsOnBackslash(vr: string): boolean {
  return isText(vr) && !SINGLE_VALUE.has(vr);
}

/** Bytes per value for the fixed-width binary VRs. Zero means variable. */
export function binaryWidth(vr: string): number {
  switch (vr) {
    case "US":
    case "SS":
      return 2;
    case "UL":
    case "SL":
    case "FL":
    case "AT":
      return 4;
    case "FD":
    case "UV":
    case "SV":
      return 8;
    default:
      return 0;
  }
}

export function isValidVr(value: string): value is Vr {
  return value.length === 2 && value >= "AA" && value <= "ZZ" && /^[A-Z]{2}$/.test(value);
}
