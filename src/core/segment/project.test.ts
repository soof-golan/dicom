import { describe, expect, it } from "vite-plus/test";
import { affineFromAxes, normalize, scale, type Vec3 } from "../geometry/vec3.ts";
import { standardPlane, type PlaneId } from "../view/planes.ts";
import type { Volume } from "../volume/build.ts";
import { emptyMask } from "./mask.ts";
import {
  fitSpan,
  framePixelToPatient,
  frameToVoxel,
  maskVolumeCubicMillimeters,
  maskVoxelIndices,
  paneFrame,
  patientToFramePixel,
  resampleMask,
  sampleSliceGray,
  sliceFrame,
  voxelExtentAlong,
  voxelToFrame,
} from "./project.ts";
import type { Mask, MaskFrame } from "./types.ts";

function makeVolume(options: {
  dims: readonly [number, number, number];
  spacing: readonly [number, number, number];
  axes: readonly [Vec3, Vec3, Vec3];
  origin: Vec3;
  data?: Uint16Array;
}): Volume {
  const { dims, spacing, axes, origin } = options;
  const data = options.data ?? new Uint16Array(dims[0] * dims[1] * dims[2]);
  return {
    dims,
    spacing,
    origin,
    axes,
    voxelToPatient: affineFromAxes(
      scale(axes[0], spacing[0]),
      scale(axes[1], spacing[1]),
      scale(axes[2], spacing[2]),
      origin,
    ),
    data,
    signed: false,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    valueRange: { min: 0, max: 4095 },
    description: "test",
    modality: "MR",
    seriesInstanceUid: "1.2.3",
    warnings: [],
  };
}

const AXIS_ALIGNED = makeVolume({
  dims: [8, 6, 4],
  spacing: [1, 1, 2],
  axes: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  origin: [0, 0, 0],
});

/** The same grid, turned 30 degrees about z and shifted, as a real scan is. */
const OBLIQUE = (() => {
  const angle = Math.PI / 6;
  const rowDirection: Vec3 = [Math.cos(angle), Math.sin(angle), 0];
  const columnDirection: Vec3 = [-Math.sin(angle) * 0.8, Math.cos(angle) * 0.8, 0.6];
  const normal = normalize([
    rowDirection[1] * columnDirection[2] - rowDirection[2] * columnDirection[1],
    rowDirection[2] * columnDirection[0] - rowDirection[0] * columnDirection[2],
    rowDirection[0] * columnDirection[1] - rowDirection[1] * columnDirection[0],
  ]);
  return makeVolume({
    dims: [9, 7, 5],
    spacing: [0.7, 0.7, 3],
    axes: [rowDirection, normalize(columnDirection), normal],
    origin: [-31.5, 12.25, 88],
  });
})();

const PLANES: readonly PlaneId[] = ["axial", "coronal", "sagittal"];

describe("fitSpan", () => {
  it("grows the height when the plane is wider than the pane", () => {
    expect(fitSpan([100, 50], 100, 100, 1)).toEqual([100, 100]);
  });

  it("grows the width when the plane is taller than the pane", () => {
    expect(fitSpan([50, 100], 100, 100, 1)).toEqual([100, 100]);
  });

  it("shows fewer millimeters when the user zooms in", () => {
    expect(fitSpan([100, 100], 100, 100, 2)).toEqual([50, 50]);
  });
});

describe("frame and patient", () => {
  const frame: MaskFrame = {
    width: 4,
    height: 2,
    origin: [10, 20, 30],
    u: [1, 0, 0],
    v: [0, 1, 0],
    spanX: 8,
    spanY: 4,
  };

  it("puts the middle of the grid at the origin of the frame", () => {
    const middle = framePixelToPatient(frame, 1.5, 0.5);
    expect(middle[0]).toBeCloseTo(10, 12);
    expect(middle[1]).toBeCloseTo(20, 12);
    expect(middle[2]).toBeCloseTo(30, 12);
  });

  it("puts pixel 0,0 half a pixel inside the top left corner", () => {
    expect(framePixelToPatient(frame, 0, 0)).toEqual([10 - 3, 20 - 1, 30]);
  });

  it("moves the width of one pixel per step", () => {
    const step = framePixelToPatient(frame, 1, 0)[0] - framePixelToPatient(frame, 0, 0)[0];
    expect(step).toBeCloseTo(2, 12);
  });

  it("reports the distance off the plane as depth", () => {
    const off = framePixelToPatient(frame, 2, 1, 7);
    expect(patientToFramePixel(frame, off).depth).toBeCloseTo(7, 12);
  });

  it("round trips a pixel and a depth exactly", () => {
    for (const [x, y, depth] of [
      [0, 0, 0],
      [3.25, 1.75, -4.5],
      [2, 1, 12.5],
    ] as const) {
      const back = patientToFramePixel(frame, framePixelToPatient(frame, x, y, depth));
      expect(back.x).toBeCloseTo(x, 10);
      expect(back.y).toBeCloseTo(y, 10);
      expect(back.depth).toBeCloseTo(depth, 10);
    }
  });
});

describe("voxel round trip", () => {
  const cases = [
    { name: "axis aligned", volume: AXIS_ALIGNED },
    { name: "oblique", volume: OBLIQUE },
  ];

  for (const { name, volume } of cases) {
    it(`returns the same voxel after a trip through a ${name} cut, without rounding`, () => {
      for (const id of PLANES) {
        const plane = standardPlane(volume, id, [0, 0, 0]);
        const frame = sliceFrame(volume, plane, 512);
        for (let k = 0; k < volume.dims[2]; k += 1) {
          for (let j = 0; j < volume.dims[1]; j += 2) {
            for (let i = 0; i < volume.dims[0]; i += 3) {
              const voxel: Vec3 = [i, j, k];
              const pixel = voxelToFrame(volume, frame, voxel);
              const back = frameToVoxel(volume, frame, pixel.x, pixel.y, pixel.depth);
              expect(back[0]).toBeCloseTo(voxel[0], 8);
              expect(back[1]).toBeCloseTo(voxel[1], 8);
              expect(back[2]).toBeCloseTo(voxel[2], 8);
            }
          }
        }
      }
    });

    it(`stays within half a voxel through a ${name} cut, with rounding`, () => {
      for (const id of PLANES) {
        const plane = standardPlane(volume, id, [0, 0, 0]);
        const frame = sliceFrame(volume, plane, 4096);
        for (let k = 0; k < volume.dims[2]; k += 1) {
          for (let j = 0; j < volume.dims[1]; j += 1) {
            for (let i = 0; i < volume.dims[0]; i += 1) {
              const voxel: Vec3 = [i, j, k];
              const pixel = voxelToFrame(volume, frame, voxel);
              const back = frameToVoxel(
                volume,
                frame,
                Math.round(pixel.x),
                Math.round(pixel.y),
                pixel.depth,
              );
              expect(Math.abs(back[0] - i)).toBeLessThanOrEqual(0.5);
              expect(Math.abs(back[1] - j)).toBeLessThanOrEqual(0.5);
              expect(Math.abs(back[2] - k)).toBeLessThanOrEqual(0.5);
            }
          }
        }
      }
    });
  }
});

describe("sliceFrame", () => {
  it("covers the whole cut", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const frame = sliceFrame(AXIS_ALIGNED, plane, 512);
    expect(frame.spanX).toBe(plane.size[0]);
    expect(frame.spanY).toBe(plane.size[1]);
  });

  it("samples at half the finest voxel spacing", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const frame = sliceFrame(AXIS_ALIGNED, plane, 512);
    expect(frame.width).toBe(16);
    expect(frame.height).toBe(12);
  });

  it("keeps the aspect ratio when it hits the size limit", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const frame = sliceFrame(AXIS_ALIGNED, plane, 4);
    expect(frame.width).toBe(4);
    expect(frame.height).toBe(3);
  });

  it("does not move when the user pans, because it ignores the pane", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const panned = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0], [12, -3]);
    expect(sliceFrame(AXIS_ALIGNED, plane, 512).spanX).toBe(
      sliceFrame(AXIS_ALIGNED, panned, 512).spanX,
    );
  });
});

describe("paneFrame", () => {
  it("uses one grid pixel per screen pixel", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const frame = paneFrame(plane, 640, 480, 1);
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(480);
  });

  it("shows the same point that the renderer shows", () => {
    // The renderer maps a pane pixel to the patient with the same rule. This
    // repeats that rule from the outside, so a drift would fail here.
    const plane = standardPlane(AXIS_ALIGNED, "coronal", [1, 2, 3], [5, -5]);
    const frame = paneFrame(plane, 300, 200, 1.5);
    const [width, height] = fitSpan(plane.size, 300, 200, 1.5);
    const s = 150 / 300 - 0.5;
    const t = 40 / 200 - 0.5;
    const expected = [
      plane.origin[0] + plane.u[0] * s * width + plane.v[0] * t * height,
      plane.origin[1] + plane.u[1] * s * width + plane.v[1] * t * height,
      plane.origin[2] + plane.u[2] * s * width + plane.v[2] * t * height,
    ];
    const actual = framePixelToPatient(frame, 150 - 0.5, 40 - 0.5);
    expect(actual[0]).toBeCloseTo(expected[0]!, 9);
    expect(actual[1]).toBeCloseTo(expected[1]!, 9);
    expect(actual[2]).toBeCloseTo(expected[2]!, 9);
  });
});

describe("voxelExtentAlong", () => {
  it("returns the spacing along an axis of the grid", () => {
    expect(voxelExtentAlong(AXIS_ALIGNED, [0, 0, 1])).toBeCloseTo(2, 12);
    expect(voxelExtentAlong(AXIS_ALIGNED, [1, 0, 0])).toBeCloseTo(1, 12);
  });

  it("returns the width of the voxel box across a diagonal", () => {
    const diagonal = normalize([1, 1, 0]);
    expect(voxelExtentAlong(AXIS_ALIGNED, diagonal)).toBeCloseTo(Math.SQRT2, 12);
  });

  it("ignores the length of the direction", () => {
    expect(voxelExtentAlong(AXIS_ALIGNED, [0, 0, 9])).toBeCloseTo(2, 12);
  });
});

describe("maskVolumeCubicMillimeters", () => {
  it("multiplies the pixel area by the count and the thickness", () => {
    const frame: MaskFrame = {
      width: 10,
      height: 10,
      origin: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      spanX: 20,
      spanY: 20,
    };
    const mask = emptyMask(10, 10);
    mask.data.fill(1, 0, 25);
    // 25 pixels, each 2 mm by 2 mm, over a 3 mm thick cut.
    expect(maskVolumeCubicMillimeters(frame, mask, 3)).toBeCloseTo(300, 9);
  });

  it("reports nothing for an empty mask", () => {
    const frame: MaskFrame = {
      width: 4,
      height: 4,
      origin: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      spanX: 4,
      spanY: 4,
    };
    expect(maskVolumeCubicMillimeters(frame, emptyMask(4, 4), 1)).toBe(0);
  });
});

describe("maskVoxelIndices", () => {
  it("finds the voxels under the set pixels", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const frame = sliceFrame(AXIS_ALIGNED, plane, 512);
    const mask = emptyMask(frame.width, frame.height);
    mask.data[2 * frame.width + 3] = 1;
    const indices = maskVoxelIndices(AXIS_ALIGNED, frame, mask);
    expect(indices.length).toBe(1);
    const voxel = frameToVoxel(AXIS_ALIGNED, frame, 3, 2);
    const [nx, ny] = AXIS_ALIGNED.dims;
    const expected =
      Math.round(voxel[2]) * nx * ny + Math.round(voxel[1]) * nx + Math.round(voxel[0]);
    expect(indices[0]).toBe(expected);
  });

  it("gives one index per voxel when many pixels share a voxel", () => {
    const plane = standardPlane(AXIS_ALIGNED, "axial", [0, 0, 0]);
    const frame = sliceFrame(AXIS_ALIGNED, plane, 512);
    const fine: MaskFrame = { ...frame, width: frame.width * 4, height: frame.height * 4 };
    const mask = emptyMask(fine.width, fine.height);
    mask.data.fill(1);
    const indices = maskVoxelIndices(AXIS_ALIGNED, fine, mask);
    expect(indices.length).toBe(AXIS_ALIGNED.dims[0] * AXIS_ALIGNED.dims[1]);
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b));
  });

  it("drops pixels that fall outside the grid", () => {
    const frame: MaskFrame = {
      width: 4,
      height: 4,
      origin: [500, 500, 500],
      u: [1, 0, 0],
      v: [0, 1, 0],
      spanX: 4,
      spanY: 4,
    };
    const mask = emptyMask(4, 4);
    mask.data.fill(1);
    expect(maskVoxelIndices(AXIS_ALIGNED, frame, mask).length).toBe(0);
  });
});

describe("resampleMask", () => {
  const from: MaskFrame = {
    width: 4,
    height: 4,
    origin: [0, 0, 0],
    u: [1, 0, 0],
    v: [0, 1, 0],
    spanX: 4,
    spanY: 4,
  };

  function rowsOf(mask: Mask): string[] {
    const rows: string[] = [];
    for (let y = 0; y < mask.height; y += 1) {
      let row = "";
      for (let x = 0; x < mask.width; x += 1)
        row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
      rows.push(row);
    }
    return rows;
  }

  it("returns the same picture when the frames match", () => {
    const mask = emptyMask(4, 4);
    mask.data[5] = 1;
    mask.data[6] = 1;
    expect(rowsOf(resampleMask(mask, from, from))).toEqual(rowsOf(mask));
  });

  it("scales the picture when the grid gets finer", () => {
    const mask = emptyMask(4, 4);
    mask.data[5] = 1;
    const finer: MaskFrame = { ...from, width: 8, height: 8 };
    expect(rowsOf(resampleMask(mask, from, finer))).toEqual([
      "........",
      "........",
      "..##....",
      "..##....",
      "........",
      "........",
      "........",
      "........",
    ]);
  });

  it("clears the pixels that the source frame does not cover", () => {
    const mask = emptyMask(4, 4);
    mask.data.fill(1);
    const wider: MaskFrame = { ...from, spanX: 8, spanY: 8 };
    expect(rowsOf(resampleMask(mask, from, wider))).toEqual(["....", ".##.", ".##.", "...."]);
  });

  it("follows the frame when the view pans", () => {
    const mask = emptyMask(4, 4);
    mask.data[0] = 1;
    const panned: MaskFrame = { ...from, origin: [-1, -1, 0] };
    expect(rowsOf(resampleMask(mask, from, panned))).toEqual(["....", ".#..", "....", "...."]);
  });
});

describe("sampleSliceGray", () => {
  const volume = makeVolume({
    dims: [2, 2, 1],
    spacing: [1, 1, 1],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    origin: [0, 0, 0],
    data: Uint16Array.from([0, 100, 200, 300]),
  });
  const frame: MaskFrame = {
    width: 2,
    height: 2,
    origin: [0.5, 0.5, 0],
    u: [1, 0, 0],
    v: [0, 1, 0],
    spanX: 2,
    spanY: 2,
  };

  it("spreads the window over the whole 8-bit range", () => {
    const gray = sampleSliceGray(volume, frame, { center: 150, width: 300 });
    expect([...gray]).toEqual([0, 85, 170, 255]);
  });

  it("clips values outside the window", () => {
    const gray = sampleSliceGray(volume, frame, { center: 150, width: 100 });
    expect([...gray]).toEqual([0, 0, 255, 255]);
  });

  it("reads black outside the grid", () => {
    const away: MaskFrame = { ...frame, origin: [90, 90, 0] };
    expect([...sampleSliceGray(volume, away, { center: 150, width: 300 })]).toEqual([0, 0, 0, 0]);
  });

  it("applies the rescale transform before the window", () => {
    // Stored 0, 100, 200 and 300 become -100, 100, 300 and 500.
    const rescaled: Volume = { ...volume, rescaleSlope: 2, rescaleIntercept: -100 };
    const gray = sampleSliceGray(rescaled, frame, { center: 200, width: 400 });
    expect([...gray]).toEqual([0, 64, 191, 255]);
  });
});
