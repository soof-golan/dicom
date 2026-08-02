/**
 * The DICOM byte parser.
 *
 * It turns a file into a map of tag to element. It decodes no pixels and
 * allocates no copies of the pixel data: each element records an offset and a
 * length into the original bytes. Pixel decoding is a separate step.
 */
import { lookupVr } from "./dictionary.ts";
import { Tag } from "./tags.ts";
import { hasLongHeader, isValidVr, type Vr } from "./vr.ts";

const PREAMBLE_LENGTH = 128;
const MAGIC = "DICM";
const UNDEFINED_LENGTH = 0xffffffff;

export const TransferSyntax = {
  ImplicitVrLittleEndian: "1.2.840.10008.1.2",
  ExplicitVrLittleEndian: "1.2.840.10008.1.2.1",
  DeflatedExplicitVrLittleEndian: "1.2.840.10008.1.2.1.99",
  ExplicitVrBigEndian: "1.2.840.10008.1.2.2",
  RleLossless: "1.2.840.10008.1.2.5",
  JpegBaseline: "1.2.840.10008.1.2.4.50",
  JpegExtended: "1.2.840.10008.1.2.4.51",
  JpegLosslessSv1: "1.2.840.10008.1.2.4.70",
  JpegLsLossless: "1.2.840.10008.1.2.4.80",
  JpegLsNearLossless: "1.2.840.10008.1.2.4.81",
  Jpeg2000Lossless: "1.2.840.10008.1.2.4.90",
  Jpeg2000: "1.2.840.10008.1.2.4.91",
  HighThroughputJpeg2000Lossless: "1.2.840.10008.1.2.4.201",
  HighThroughputJpeg2000: "1.2.840.10008.1.2.4.203",
} as const;

/** Transfer syntaxes whose pixel data arrives in fragments, not as a raw block. */
const ENCAPSULATED: ReadonlySet<string> = new Set([
  TransferSyntax.RleLossless,
  TransferSyntax.JpegBaseline,
  TransferSyntax.JpegExtended,
  TransferSyntax.JpegLosslessSv1,
  TransferSyntax.JpegLsLossless,
  TransferSyntax.JpegLsNearLossless,
  TransferSyntax.Jpeg2000Lossless,
  TransferSyntax.Jpeg2000,
  TransferSyntax.HighThroughputJpeg2000Lossless,
  TransferSyntax.HighThroughputJpeg2000,
]);

export interface DicomElement {
  readonly tag: number;
  readonly vr: Vr;
  /** Offset of the value inside the source bytes. */
  readonly offset: number;
  /** Length of the value in bytes. */
  readonly length: number;
  /** Items of a sequence element. Present only when the VR is `SQ`. */
  readonly items?: readonly DicomDataSet[];
  /** Fragments of encapsulated pixel data. The first one is the offset table. */
  readonly fragments?: readonly Uint8Array[];
}

export interface DicomDataSet {
  readonly elements: ReadonlyMap<number, DicomElement>;
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly littleEndian: boolean;
  readonly implicitVr: boolean;
  readonly transferSyntaxUid: string;
  readonly encapsulated: boolean;
}

interface Encoding {
  readonly littleEndian: boolean;
  readonly implicitVr: boolean;
}

const META_ENCODING: Encoding = { littleEndian: true, implicitVr: false };

class Cursor {
  offset: number;
  readonly view: DataView;
  readonly end: number;

  constructor(view: DataView, end: number, start: number) {
    this.view = view;
    this.end = end;
    this.offset = start;
  }

  get done(): boolean {
    return this.offset >= this.end;
  }

  u16(littleEndian: boolean): number {
    const value = this.view.getUint16(this.offset, littleEndian);
    this.offset += 2;
    return value;
  }

  u32(littleEndian: boolean): number {
    const value = this.view.getUint32(this.offset, littleEndian);
    this.offset += 4;
    return value;
  }

  ascii(count: number): string {
    let out = "";
    for (let i = 0; i < count; i += 1) {
      out += String.fromCharCode(this.view.getUint8(this.offset + i));
    }
    this.offset += count;
    return out;
  }
}

function readTag(cursor: Cursor, littleEndian: boolean): number {
  const group = cursor.u16(littleEndian);
  const element = cursor.u16(littleEndian);
  return group * 0x10000 + element;
}

interface Header {
  readonly tag: number;
  readonly vr: Vr;
  readonly length: number;
}

function readHeader(cursor: Cursor, encoding: Encoding): Header {
  const tag = readTag(cursor, encoding.littleEndian);

  // Item and delimiter tags never carry a VR, in any transfer syntax.
  if (tag === Tag.ItemStart || tag === Tag.ItemDelimiter || tag === Tag.SequenceDelimiter) {
    return { tag, vr: "UN", length: cursor.u32(encoding.littleEndian) };
  }

  if (encoding.implicitVr) {
    return { tag, vr: lookupVr(tag), length: cursor.u32(encoding.littleEndian) };
  }

  const code = cursor.ascii(2);
  if (!isValidVr(code)) {
    // Some writers emit implicit VR inside an explicit VR file. Step back and
    // read the four bytes as a length instead of a VR.
    cursor.offset -= 2;
    return { tag, vr: lookupVr(tag), length: cursor.u32(encoding.littleEndian) };
  }
  if (hasLongHeader(code)) {
    cursor.offset += 2; // two reserved bytes
    return { tag, vr: code, length: cursor.u32(encoding.littleEndian) };
  }
  return { tag, vr: code, length: cursor.u16(encoding.littleEndian) };
}

/** Read the items of a sequence, up to its delimiter or its stated length. */
function readItems(
  cursor: Cursor,
  encoding: Encoding,
  bytes: Uint8Array,
  transferSyntaxUid: string,
  sequenceLength: number,
): DicomDataSet[] {
  const items: DicomDataSet[] = [];
  const limit =
    sequenceLength === UNDEFINED_LENGTH
      ? cursor.end
      : Math.min(cursor.offset + sequenceLength, cursor.end);

  while (cursor.offset < limit) {
    const header = readHeader(cursor, encoding);
    if (header.tag === Tag.SequenceDelimiter) break;
    if (header.tag !== Tag.ItemStart) break;

    const itemEnd =
      header.length === UNDEFINED_LENGTH ? limit : Math.min(cursor.offset + header.length, limit);
    const item = readDataSet(
      cursor.view,
      bytes,
      cursor.offset,
      itemEnd,
      encoding,
      transferSyntaxUid,
      header.length === UNDEFINED_LENGTH,
    );
    items.push(item.dataSet);
    cursor.offset = item.end;
  }
  return items;
}

/** Read the fragments of encapsulated pixel data, up to the sequence delimiter. */
function readFragments(cursor: Cursor, bytes: Uint8Array, encoding: Encoding): Uint8Array[] {
  const fragments: Uint8Array[] = [];
  while (!cursor.done) {
    const header = readHeader(cursor, encoding);
    if (header.tag === Tag.SequenceDelimiter) break;
    if (header.tag !== Tag.ItemStart) break;
    const start = cursor.offset;
    const end = Math.min(start + header.length, cursor.end);
    fragments.push(bytes.subarray(start, end));
    cursor.offset = end;
  }
  return fragments;
}

interface DataSetResult {
  readonly dataSet: DicomDataSet;
  readonly end: number;
}

function readDataSet(
  view: DataView,
  bytes: Uint8Array,
  start: number,
  end: number,
  encoding: Encoding,
  transferSyntaxUid: string,
  stopAtItemDelimiter = false,
): DataSetResult {
  const elements = new Map<number, DicomElement>();
  const cursor = new Cursor(view, end, start);
  const encapsulated = ENCAPSULATED.has(transferSyntaxUid);

  // A header needs at least 8 bytes. Anything shorter is trailing padding.
  while (cursor.offset + 8 <= end) {
    const headerStart = cursor.offset;
    const header = readHeader(cursor, encoding);

    if (header.tag === Tag.ItemDelimiter) {
      if (stopAtItemDelimiter) {
        return { dataSet: build(), end: cursor.offset };
      }
      continue;
    }
    if (header.tag === Tag.SequenceDelimiter) {
      return { dataSet: build(), end: cursor.offset };
    }

    const isPixelData = header.tag === Tag.PixelData;

    if (header.vr === "SQ" || (header.length === UNDEFINED_LENGTH && !isPixelData)) {
      const items = readItems(cursor, encoding, bytes, transferSyntaxUid, header.length);
      elements.set(header.tag, {
        tag: header.tag,
        vr: "SQ",
        offset: headerStart,
        length: cursor.offset - headerStart,
        items,
      });
      continue;
    }

    if (isPixelData && header.length === UNDEFINED_LENGTH) {
      const valueStart = cursor.offset;
      const fragments = readFragments(cursor, bytes, encoding);
      elements.set(header.tag, {
        tag: header.tag,
        vr: header.vr,
        offset: valueStart,
        length: cursor.offset - valueStart,
        fragments,
      });
      continue;
    }

    const valueStart = cursor.offset;
    const length = Math.min(header.length, end - valueStart);
    elements.set(header.tag, {
      tag: header.tag,
      vr: header.vr,
      offset: valueStart,
      length,
    });
    cursor.offset = valueStart + length;
  }

  return { dataSet: build(), end: cursor.offset };

  function build(): DicomDataSet {
    return {
      elements,
      bytes,
      view,
      littleEndian: encoding.littleEndian,
      implicitVr: encoding.implicitVr,
      transferSyntaxUid,
      encapsulated,
    };
  }
}

function encodingFor(transferSyntaxUid: string): Encoding {
  if (transferSyntaxUid === TransferSyntax.ImplicitVrLittleEndian) {
    return { littleEndian: true, implicitVr: true };
  }
  if (transferSyntaxUid === TransferSyntax.ExplicitVrBigEndian) {
    return { littleEndian: false, implicitVr: false };
  }
  return { littleEndian: true, implicitVr: false };
}

function readMetaTransferSyntax(
  view: DataView,
  bytes: Uint8Array,
): {
  uid: string;
  end: number;
} {
  const cursor = new Cursor(view, bytes.length, PREAMBLE_LENGTH + MAGIC.length);
  let uid: string = TransferSyntax.ExplicitVrLittleEndian;

  while (cursor.offset + 8 <= bytes.length) {
    const before = cursor.offset;
    const header = readHeader(cursor, META_ENCODING);
    if (Math.floor(header.tag / 0x10000) !== 0x0002) {
      return { uid, end: before };
    }
    if (header.tag === Tag.TransferSyntaxUid) {
      uid = decodeAscii(bytes, cursor.offset, header.length);
    }
    cursor.offset += header.length;
  }
  return { uid, end: cursor.offset };
}

function decodeAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const code = bytes[offset + i];
    if (code === undefined || code === 0 || code === 0x20) continue;
    out += String.fromCharCode(code);
  }
  return out;
}

export class DicomParseError extends Error {
  override readonly name = "DicomParseError";
}

/**
 * Parse a DICOM file.
 *
 * @throws {DicomParseError} if the bytes are too short or carry no `DICM` mark.
 */
export function parseDicom(bytes: Uint8Array): DicomDataSet {
  if (bytes.length < PREAMBLE_LENGTH + MAGIC.length + 8) {
    throw new DicomParseError(`file is too short to be DICOM: ${bytes.length} bytes`);
  }
  const magic = String.fromCharCode(
    ...bytes.subarray(PREAMBLE_LENGTH, PREAMBLE_LENGTH + MAGIC.length),
  );
  if (magic !== MAGIC) {
    throw new DicomParseError(`not a DICOM file: expected "DICM" at byte 128, found "${magic}"`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = readMetaTransferSyntax(view, bytes);

  if (meta.uid === TransferSyntax.DeflatedExplicitVrLittleEndian) {
    throw new DicomParseError(
      "deflated transfer syntax is not supported yet: 1.2.840.10008.1.2.1.99",
    );
  }

  return readDataSet(view, bytes, meta.end, bytes.length, encodingFor(meta.uid), meta.uid).dataSet;
}

export function isEncapsulated(transferSyntaxUid: string): boolean {
  return ENCAPSULATED.has(transferSyntaxUid);
}
