/**
 * Typed reads from a parsed data set.
 *
 * Every function returns `undefined` or an empty array when the tag is absent,
 * so a caller never has to test for the tag first.
 */
import type { DicomDataSet, DicomElement } from "./parse.ts";
import { Tag } from "./tags.ts";
import { binaryWidth, isText, splitsOnBackslash } from "./vr.ts";

/**
 * Map a DICOM character set name to a `TextDecoder` label.
 *
 * A DICOM file can name several character sets for code extension. This viewer
 * reads the first one. Text that needs escape sequences to switch sets is rare
 * outside East Asian person names.
 */
function decoderLabel(characterSet: string | undefined): string {
  const first = characterSet?.split("\\")[0]?.trim().toUpperCase() ?? "";
  switch (first) {
    case "ISO_IR 192":
      return "utf-8";
    case "ISO_IR 101":
    case "ISO 2022 IR 101":
      return "iso-8859-2";
    case "ISO_IR 109":
      return "iso-8859-3";
    case "ISO_IR 110":
      return "iso-8859-4";
    case "ISO_IR 144":
    case "ISO 2022 IR 144":
      return "iso-8859-5";
    case "ISO_IR 127":
      return "iso-8859-6";
    case "ISO_IR 126":
      return "iso-8859-7";
    case "ISO_IR 138":
      return "iso-8859-8";
    case "ISO_IR 148":
      return "iso-8859-9";
    case "ISO_IR 166":
      return "windows-874";
    case "GB18030":
      return "gb18030";
    case "GBK":
      return "gbk";
    default:
      // ISO_IR 6 (the default) and ISO_IR 100 are both covered by latin1.
      return "windows-1252";
  }
}

const decoders = new Map<string, TextDecoder>();

function decoderFor(dataSet: DicomDataSet): TextDecoder {
  const element = dataSet.elements.get(Tag.SpecificCharacterSet);
  const raw = element
    ? String.fromCharCode(
        ...dataSet.bytes.subarray(element.offset, element.offset + element.length),
      )
    : undefined;
  const label = decoderLabel(raw);
  let decoder = decoders.get(label);
  if (!decoder) {
    decoder = new TextDecoder(label);
    decoders.set(label, decoder);
  }
  return decoder;
}

export function getElement(dataSet: DicomDataSet, tag: number): DicomElement | undefined {
  return dataSet.elements.get(tag);
}

export function has(dataSet: DicomDataSet, tag: number): boolean {
  return dataSet.elements.has(tag);
}

/** The raw value bytes of a tag, without a copy. */
export function getBytes(dataSet: DicomDataSet, tag: number): Uint8Array | undefined {
  const element = dataSet.elements.get(tag);
  if (!element) return undefined;
  return dataSet.bytes.subarray(element.offset, element.offset + element.length);
}

/**
 * The value of a text tag, with DICOM padding removed.
 *
 * DICOM pads an odd-length value to an even length with a space, or with a null
 * byte for UI values. Both are removed here.
 */
export function getString(dataSet: DicomDataSet, tag: number): string | undefined {
  const element = dataSet.elements.get(tag);
  if (!element || element.length === 0) return undefined;
  const bytes = dataSet.bytes.subarray(element.offset, element.offset + element.length);
  const text = isText(element.vr)
    ? decoderFor(dataSet).decode(bytes)
    : String.fromCharCode(...bytes);
  // DICOM pads to an even length with a space (0x20), or a null byte for UIDs.
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x00) break;
    end -= 1;
  }
  const trimmed = text.slice(0, end);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Every value of a multi-valued text tag. */
export function getStrings(dataSet: DicomDataSet, tag: number): string[] {
  const element = dataSet.elements.get(tag);
  const value = getString(dataSet, tag);
  if (value === undefined) return [];
  if (!element || !splitsOnBackslash(element.vr)) return [value];
  return value.split("\\").map((part) => part.trim());
}

function readBinaryNumbers(dataSet: DicomDataSet, element: DicomElement): number[] {
  const width = binaryWidth(element.vr);
  if (width === 0) return [];
  const count = Math.floor(element.length / width);
  const out = Array.from<number>({ length: count });
  const { view, littleEndian } = dataSet;
  for (let i = 0; i < count; i += 1) {
    const at = element.offset + i * width;
    switch (element.vr) {
      case "US":
        out[i] = view.getUint16(at, littleEndian);
        break;
      case "SS":
        out[i] = view.getInt16(at, littleEndian);
        break;
      case "UL":
      case "AT":
        out[i] = view.getUint32(at, littleEndian);
        break;
      case "SL":
        out[i] = view.getInt32(at, littleEndian);
        break;
      case "FL":
        out[i] = view.getFloat32(at, littleEndian);
        break;
      case "FD":
        out[i] = view.getFloat64(at, littleEndian);
        break;
      case "UV":
        out[i] = Number(view.getBigUint64(at, littleEndian));
        break;
      case "SV":
        out[i] = Number(view.getBigInt64(at, littleEndian));
        break;
      default:
        out[i] = Number.NaN;
    }
  }
  return out;
}

/** Every numeric value of a tag, whether it is stored as text or as binary. */
export function getNumbers(dataSet: DicomDataSet, tag: number): number[] {
  const element = dataSet.elements.get(tag);
  if (!element || element.length === 0) return [];
  if (isText(element.vr)) {
    return getStrings(dataSet, tag)
      .map((part) => Number(part))
      .filter((value) => Number.isFinite(value));
  }
  return readBinaryNumbers(dataSet, element);
}

/** The first numeric value of a tag. */
export function getNumber(dataSet: DicomDataSet, tag: number): number | undefined {
  return getNumbers(dataSet, tag)[0];
}

/** The items of a sequence tag. */
export function getSequence(dataSet: DicomDataSet, tag: number): readonly DicomDataSet[] {
  return dataSet.elements.get(tag)?.items ?? [];
}

/**
 * Read a tag from a nested sequence, taking the first item at each step.
 *
 * Multi-frame DICOM buries geometry inside functional group sequences. This
 * walks the path in one call.
 */
export function getNested(
  dataSet: DicomDataSet,
  path: readonly number[],
  tag: number,
): DicomDataSet | undefined {
  let current: DicomDataSet | undefined = dataSet;
  for (const step of path) {
    current = current ? getSequence(current, step)[0] : undefined;
  }
  return current && current.elements.has(tag) ? current : undefined;
}
