# The demo dataset

The viewer ships with a real MRI study so that anyone can try it without a scan
of their own. Test data that is not real data hides real faults.

## Whose scan this is

The study is an MRI of the right elbow of Soof Golan, the author of this
project. He gave his own scan for this purpose. No other person is in the data.

The scan comes from a Siemens MAGNETOM Aera at 1.5 T. It holds four MR series,
164 images in total. The source study is private and is not in this repository.

The source folder also holds a radiology report as a PDF. That file is not part
of this dataset. No script in this repository reads it, and it is not published.

## The patient name is present on purpose

The DICOM headers keep `(0010,0010) Patient's Name` as `Golan^Soof`. The data
subject chose that. The site itself is at `dicom.soofgolan.com`.

CAUTION: This dataset is not a de-identified corpus. Anyone who redistributes it
must know that one real name is in the headers.

Because the name is present, every image sets
`(0012,0062) Patient Identity Removed` to `NO`. A file that keeps a real name
and claims `YES` is a lie. A later reader must be able to trust that flag.

`(0012,0063) De-identification Method` records the same fact in the file:

```
PS3.15 Annex E basic profile
private tags, curves and overlays removed
UIDs replaced by salted SHA-256 hashes
image and MR descriptors kept
scripts/anonymize.py
Partial: patient name kept by the data subject choice
```

## What was removed

`scripts/anonymize.py` applies the Basic Application Level Confidentiality
Profile of DICOM PS3.15 Annex E. The attribute list is Table E.1-1. The script
does not hold a hand-written copy of that table. It reads the table from the
`dicom-anonymizer` package, edition `dicomfields_2026c`.

Every attribute in Table E.1-1 is removed, except the ones in the two lists
below. These values were in the source study and are gone from the output:

| Attribute                               | Value in the source                 |
| --------------------------------------- | ----------------------------------- |
| (0010,0020) Patient ID                  | a six-digit clinic number           |
| (0010,0030) Patient's Birth Date        | a date in 1994                      |
| (0010,1010) Patient's Age               | an age in years                     |
| (0010,0040) Patient's Sex               | one letter                          |
| (0010,1020) Patient's Size              | a height in meters                  |
| (0010,1030) Patient's Weight            | a weight in kilograms               |
| (0008,0050) Accession Number            | a seven-digit order number          |
| (0008,0080) Institution Name            | the name of a third-party practice  |
| (0008,0081) Institution Address         | the street address of that practice |
| (0008,1010) Station Name                | the name of the scanner console     |
| (0018,1000) Device Serial Number        | the serial number of the scanner    |
| (0020,0010) Study ID                    | a clinic number                     |
| (0040,0009) Scheduled Procedure Step ID | a clinic number                     |
| (0040,0253) Performed Procedure Step ID | a clinic identifier                 |
| (0008,1030) Study Description           | the German name of the examination  |
| (0032,1060) Requested Procedure Descr.  | the German short name               |
| (0020,4000) Image Comments              | free text from the console          |
| every date and time attribute           | 31 July 2026, to the microsecond    |

Three more classes of data are removed in full:

- All private tags. The Siemens groups `0021` and `0051` hold the Phoenix
  protocol, a text blob that repeats the patient details.
- All curves, group `50xx`, and all overlays, group `60xx`. An overlay can carry
  a name that is burned into the image.
- `(0002,0012) Implementation Class UID`. The source value named the scanner
  software under the Siemens root. The output names pydicom, which writes the
  file now.

`(0010,1040) Patient's Address` was never in this study. Nothing was removed for
the home address, because the DICOM headers never held one.

### Sequences that point outside the export

Four sequences reference objects that this export does not contain. They are
`ReferencedImageSequence`, `ReferencedStudySequence`, `RelatedSeriesSequence`
and `ConversionSourceAttributesSequence`. All of them point at an Enhanced MR
object that the clinic kept.

Table E.1-1 gives the UIDs inside these sequences a new value. This script
removes the whole sequence instead. The references dangle under either rule, the
viewer never reads them, and an absent sequence is one less place to verify.

### The UIDs are remapped, not kept

A Siemens UID is not opaque. `1.3.12.2.1107.5.2.18.42565.2026073113553...`
carries the device serial number `42565` and the acquisition time
`20260731135530`. The same pattern is in the SOP, Series and Frame of Reference
UIDs.

Each UID becomes `2.25.<n>`, where `<n>` is the first 128 bits of
`SHA-256(salt + "\0" + original UID)` read as a decimal integer. The map is
deterministic, so a reference from one file to another still points at the right
object. The map is one way, so nobody can read the original UID back. Without
the salt, nobody can match a guessed UID against the output either.

After the remap the study keeps its shape:

- One Study Instance UID.
- One Frame of Reference UID, shared by all four series.
- Four Series Instance UIDs, one for each series.
- 164 distinct SOP Instance UIDs, one for each image.

## What was kept

The viewer needs these attributes, and none of them names a person, a place or a
time:

| Group             | Attributes                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometry          | ImageOrientationPatient, ImagePositionPatient, PixelSpacing, SliceThickness, SpacingBetweenSlices, SliceLocation, Laterality, PatientPosition                                                                                   |
| Pixel layout      | Rows, Columns, BitsAllocated, BitsStored, HighBit, PixelRepresentation, PhotometricInterpretation, SamplesPerPixel                                                                                                              |
| Display transform | RescaleSlope, RescaleIntercept, WindowCenter, WindowWidth, PresentationLUTShape, SmallestImagePixelValue, LargestImagePixelValue                                                                                                |
| Series identity   | Modality, SeriesDescription, SeriesNumber, InstanceNumber, AcquisitionNumber, ProtocolName, ImageType                                                                                                                           |
| MR acquisition    | BodyPartExamined, RepetitionTime, EchoTime, ScanningSequence, SequenceVariant, ScanOptions, SequenceName, MRAcquisitionType, MagneticFieldStrength, ImagedNucleus, EchoTrainLength, FlipAngle, PixelBandwidth, NumberOfAverages |
| Safety facts      | BurnedInAnnotation, LossyImageCompression                                                                                                                                                                                       |

`Manufacturer` and `ManufacturerModelName` stay as `Siemens Healthineers` and
`MAGNETOM Aera`. They name a class of machine. `StationName` and
`DeviceSerialNumber` name one machine, so both are gone.

The basic profile removes `SeriesDescription` and `ProtocolName`. This dataset
keeps both. Their values are protocol names such as `pd_tse_fs_cor_DRB`, and the
viewer shows that text as the name of the series.

## How the format was chosen

The four volumes are 85.9 MB of raw 16-bit voxels. Three encodings were measured
on the real data with `scripts/pack_volume.py --measure`. Sizes are in MB of
10^6 bytes. Levels are gzip 9, brotli 11 and zstd 19.

| File                      | raw MB | gzip MB | brotli MB | zstd MB | gzip | brotli | zstd |
| ------------------------- | -----: | ------: | --------: | ------: | ---: | -----: | ---: |
| pd_tse_fs_cor_DRB         |  20.97 |   11.80 |      9.38 |   10.29 | 1.78 |   2.24 | 2.04 |
| pd_tse_fs_cor_DRB preview |   5.24 |    2.97 |      2.38 |    2.65 | 1.77 |   2.20 | 1.98 |
| pd_tse_fs_sag_DRB         |  21.50 |   11.66 |      9.26 |    9.95 | 1.84 |   2.32 | 2.16 |
| pd_tse_fs_sag_DRB preview |   5.37 |    2.94 |      2.36 |    2.61 | 1.83 |   2.28 | 2.06 |
| pd_tse_fs_tra_DRB         |  16.91 |    9.76 |      7.98 |    8.49 | 1.73 |   2.12 | 1.99 |
| pd_tse_fs_tra_DRB preview |   4.23 |    2.53 |      2.07 |    2.29 | 1.67 |   2.04 | 1.85 |
| t1_tse_cor_DRB            |  26.54 |   15.61 |     12.43 |   13.65 | 1.70 |   2.13 | 1.94 |
| t1_tse_cor_DRB preview    |   6.64 |    3.92 |      3.14 |    3.50 | 1.69 |   2.11 | 1.89 |
| **total**                 | 107.40 |   61.18 |     49.00 |   53.44 | 1.76 |   2.19 | 2.01 |

The ratios are modest because MR data is mostly noise. The scanner stores 12
bits inside 16, so the top four bits of every second byte are zero. That is most
of what any of the three encoders finds.

Brotli is the smallest. It saves 12.2 MB against gzip, which is 20 percent of
the transfer. Zstd sits between the two, and no browser decodes it from
`Content-Encoding` without a library.

**The chosen delivery format is raw 16-bit little-endian voxels with a JSON
manifest, served from R2 with `Content-Encoding: br`.**

The reasons:

- One request per series. The manifest is one more request for the whole study.
- The browser inflates the body. Brotli is a transport encoding, so `fetch`
  returns plain voxels and the app loads no codec.
- The bytes are the final memory layout. `new Uint16Array(buffer)` costs one
  cast and no copy, and the result uploads to the GPU as it is.
- The body streams. A reader can paint slices before the last byte arrives.
- No container. There is no header to parse and no version to migrate.

Gzip is the fallback if a client without brotli ever matters. It costs 12.2 MB
more, and `DecompressionStream("gzip")` can inflate it in a Worker or a Web
Worker without a library.

CAUTION: R2 stores what you upload and does not transcode. An object with
`Content-Encoding: br` is served as brotli to every client. Upload gzip instead
if you must support a client that does not accept brotli.

## The byte layout

Each series produces three things:

1. One entry in `manifest.json`.
2. `<series>.raw`, the full volume.
3. `<series>.preview.raw`, the same volume halved in plane.

### The voxel file

A `.raw` file has no header, no magic number, no padding, and no trailer. It is
`dims[0] * dims[1] * dims[2] * 2` bytes and nothing else.

Each voxel is one 16-bit little-endian integer. The `dataType` field of the
sidecar says whether the integer is `uint16` or `int16`. Every series in this
study is `uint16`.

The byte offset of the voxel at index `(i, j, k)` is:

```
offset(i, j, k) = (k * dims[1] * dims[0] + j * dims[0] + i) * 2
```

- `i` runs across a row, from 0 to `dims[0] - 1`.
- `j` runs down a column, from 0 to `dims[1] - 1`.
- `k` runs through the slices, from 0 to `dims[2] - 1`.

`i` is the fastest index, so one slice is contiguous. This is the same order
that `src/core/volume/build.ts` uses, which is why the reader copies nothing.

The values are stored values, not physical units. The scanner stores 12 bits
inside 16, and the packer already removed the unused high bits. For physical
units, multiply by `rescaleSlope` and add `rescaleIntercept`.

### The manifest

`manifest.json` holds one entry per series. Each entry holds two sidecars, one
for the full volume and one for the preview. A sidecar is self-contained: it is
everything the reader needs except the voxels.

```json
{
  "format": "dicom-viewer/packed-volume@1",
  "voxelOrder": "i fastest, then j, then k",
  "series": [
    {
      "name": "pd_tse_fs_tra_DRB",
      "seriesNumber": 3,
      "full": { "...": "sidecar" },
      "preview": { "...": "sidecar" }
    }
  ]
}
```

Every field of a sidecar:

| Field                 | Type       | Meaning                                                        |
| --------------------- | ---------- | -------------------------------------------------------------- |
| `url`                 | string     | Name of the voxel file, relative to the manifest               |
| `bytes`               | number     | Length of the voxel file, before transport encoding            |
| `dataType`            | string     | `uint16` or `int16`                                            |
| `dims`                | 3 numbers  | Voxel counts along i, j and k                                  |
| `spacing`             | 3 numbers  | Millimeters between voxel centers along i, j and k             |
| `origin`              | 3 numbers  | Patient coordinates of the center of voxel (0, 0, 0)           |
| `axes`                | 3x3        | Unit direction of i, j and k in patient space                  |
| `voxelToPatient`      | 16 numbers | 4x4 affine, column major, voxel index to patient millimeters   |
| `valueRange`          | min, max   | Smallest and largest stored value in the file                  |
| `rescaleSlope`        | number     | Multiply a stored value by this for physical units             |
| `rescaleIntercept`    | number     | Add this after the multiply                                    |
| `windowCenter`        | number     | Suggested window center, from the scanner. Can be absent.      |
| `windowWidth`         | number     | Suggested window width, from the scanner. Can be absent.       |
| `description`         | string     | SeriesDescription, such as `pd_tse_fs_cor_DRB`                 |
| `modality`            | string     | `MR` for every series here                                     |
| `seriesInstanceUid`   | string     | The remapped Series Instance UID                               |
| `frameOfReferenceUid` | string     | The remapped Frame of Reference UID. All four series share it. |
| `warnings`            | strings    | Geometry faults the packer found. Empty for this study.        |

`voxelToPatient` is column major, the order that WebGL and three.js want. Column
`n` is `axes[n]` multiplied by `spacing[n]`. The last column is `origin` and 1.

`frameOfReferenceUid` must survive the remap with its value shared. Two series
sit in one patient coordinate system only when this UID matches, and
`src/core/tissue/resample.ts` refuses to combine them otherwise. A remap that
gave each series its own value would turn off the cross-series tools without an
error message.

### The preview

The preview is the mean of each 2x2 block of a slice. The slice count does not
change, so a preview of 40 slices stays 40 slices.

Two numbers move with the mean:

- `spacing[0]` and `spacing[1]` double. `spacing[2]` does not change.
- `origin` moves half a full voxel along i and half along j. The mean of a 2x2
  block sits at the center of that block, not at its corner.

A preview that skips the origin shift draws the anatomy a quarter of a
millimeter out of place. `src/core/volume/packed.test.ts` asserts the shift.

The mean is rounded with `floor(x + 0.5)`. That is what `Math.round` does in
JavaScript. Half of a rounding tie goes up, never to the even neighbor.

## The sizes

| Series            | Grid       |   Full raw | Full brotli | Preview raw | Preview brotli |
| ----------------- | ---------- | ---------: | ----------: | ----------: | -------------: |
| pd_tse_fs_tra_DRB | 384x512x43 | 16,908,288 |   7,976,385 |   4,227,072 |      2,080,644 |
| pd_tse_fs_cor_DRB | 512x512x40 | 20,971,520 |   9,377,909 |   5,242,880 |      2,396,810 |
| t1_tse_cor_DRB    | 576x576x40 | 26,542,080 |  12,432,481 |   6,635,520 |      3,155,954 |
| pd_tse_fs_sag_DRB | 512x512x41 | 21,495,808 |   9,262,382 |   5,373,952 |      2,373,835 |
| **total**         |            | 85,917,696 |  39,049,157 |  21,479,424 |      8,007,243 |

`manifest.json` is 12,563 bytes, or 1,383 bytes after brotli.

**Total published bytes: 49,057,783 after brotli.** That is 46.8 MiB for the
whole study, at both resolutions.

The four previews are 8,007,243 bytes together. One preview is 2.0 MB to 3.2 MB,
so the viewer can paint a series in about one second on a normal connection.

## How to regenerate everything

You need the source study, `uv`, and a salt that you keep secret. The scripts
write nothing into this repository except the test fixtures.

### 1. De-identify the study

Run the anonymizer over the source study:

```bash
uv run scripts/anonymize.py "<source-study>" \
  --out /tmp/demo-anon \
  --salt "<your-secret-salt>" \
  --patient-name "Golan^Soof" \
  --keep-real-name
```

For anyone else's study, remove the last two flags. The patient name then
becomes `Anonymous^Demo`, and the files claim `PatientIdentityRemoved YES`.

CAUTION: Keep the salt in a password manager, not in this repository. A public
salt lets an attacker match a guessed UID against the output.

### 2. Verify the result

Write a file with one forbidden string per line. Put these values in it:

- The patient ID and the birth date.
- The age and the accession number.
- The name of the practice and its street.
- The station name and the device serial number.
- The date of the scan.

Keep that file outside the repository. Then run:

```bash
uv run scripts/anonymize.py /tmp/demo-anon \
  --verify --forbidden-file "<your-forbidden-file>"
```

The verification reads every element value and the raw bytes of every file. It
exits 1 on any match. It also reports the private tags left, the UIDs that the
remap missed, and the referential integrity of the study.

The verification of this dataset reported 164 files, 20 forbidden strings, 0
matches, 0 private tags left, and 0 scanner UIDs left.

### 3. Pack the volumes

```bash
uv run scripts/pack_volume.py /tmp/demo-anon --out /tmp/demo-out
```

To print the compression table again, run:

```bash
uv run scripts/pack_volume.py /tmp/demo-anon --measure
```

Brotli at quality 11 is slow. The table takes about three minutes.

### 4. Rebuild the test fixtures

The packed fixtures under `tests/fixtures/packed/` come from the DICOM fixtures
under `tests/fixtures/series/`. Rebuild both after any change to either script:

```bash
uv run scripts/make_fixtures.py "<source-study>"
uv run scripts/pack_volume.py tests/fixtures/series --out tests/fixtures/packed
vp check --fix
vp test --run
```

NOTE: `vp check --fix` reflows `tests/fixtures/packed/manifest.json`. The packer
writes one number per line, and the formatter puts short arrays on one line. The
content does not change.

`src/core/volume/packed.test.ts` builds each volume twice. It builds one from
the DICOM fixtures with `buildVolume`, and one from the packed fixtures with
`volumeFromPacked`. Then it asserts that the two agree on the grid, the spacing,
the affine and every voxel. That round-trip is what keeps the packer and the
reader in step.

## Upload to R2

This is a runbook for the owner of the bucket. Nothing in this repository
uploads anything.

### 1. Compress every file

R2 does not compress for you. Compress first, then upload the compressed bytes
with the matching `Content-Encoding`.

```bash
cd /tmp/demo-out
for file in *.raw manifest.json; do
  brotli --quality=11 --keep --force "$file"
done
```

### 2. Create the bucket

```bash
npx wrangler r2 bucket create dicom-demo
```

### 3. Upload each object

Upload the manifest first:

```bash
npx wrangler r2 object put dicom-demo/demo/manifest.json \
  --file manifest.json.br --remote \
  --content-type application/json \
  --content-encoding br \
  --cache-control "public, max-age=3600"
```

Then upload each volume and each preview:

```bash
for file in *.raw; do
  npx wrangler r2 object put "dicom-demo/demo/$file" \
    --file "$file.br" --remote \
    --content-type application/octet-stream \
    --content-encoding br \
    --cache-control "public, max-age=31536000, immutable"
done
```

NOTE: The object key keeps the `.raw` name. The `.br` suffix belongs to the
local file only. `Content-Encoding` tells the browser what to do.

### 4. Give the bucket a custom domain

Do this in the Cloudflare dashboard, under R2, the bucket, Settings, Public
access. Add a custom domain such as `demo.dicom.soofgolan.com`.

A custom domain gives you the Cloudflare cache and the WAF. The `r2.dev` URL is
rate limited and is for development only.

### 5. Set the CORS policy

Write `cors.json`:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://dicom.soofgolan.com"],
        "methods": ["GET", "HEAD"],
        "headers": ["Range"]
      },
      "exposeHeaders": ["Content-Encoding", "Content-Length", "ETag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

Apply it and read it back:

```bash
npx wrangler r2 bucket cors set dicom-demo --file cors.json
npx wrangler r2 bucket cors list dicom-demo
```

### 6. Allow the origin in the site policy

`public/_headers` holds a `connect-src` directive with the placeholder
`R2-BUCKET-HOSTNAME.example.com`. Replace it with the real bucket hostname. The
browser blocks every request to R2 until you do.

### 7. Verify the upload

```bash
curl -sI -H "Accept-Encoding: br" \
  https://demo.dicom.soofgolan.com/demo/manifest.json
```

The response must hold `content-encoding: br` and
`content-type: application/json`. If it does not, the upload missed a flag.

CAUTION: If you change the CORS policy on a domain that already serves traffic,
purge the cache. The cached responses hold the old CORS headers.

## License

The code in this repository is MIT. See [LICENSE](../LICENSE).

The imaging data is a separate work with a separate license. It is dedicated to
the public domain under **CC0 1.0 Universal**. See
[LICENSE-DATA](../LICENSE-DATA) for the dedication and the full legal code.

CC0 asks nothing of you. You can copy the study, change it, and use it for any
purpose, including a commercial one, without a notice and without permission.

Two facts still apply, and neither is a license condition.

The patient name is in the DICOM headers, kept by the choice of the data
subject. So this is real medical imaging that is not fully de-identified, and it
names a living person. Read "What the files hold" above before you redistribute
it.

The scan shows a real injury. Do not use it to make a medical decision about
anyone, including the person in it.

Upload `LICENSE-DATA` to the bucket beside the data, so the dedication travels
with the files.
