import { describe, expect, it } from "vite-plus/test";
import { normalize } from "../geometry/vec3.ts";
import {
  anglesFor,
  cameraPosition,
  CUBE_FACES,
  CUBE_REGIONS,
  regionFacing,
  turn,
} from "./viewcube.ts";

describe("CUBE_REGIONS", () => {
  it("has 6 faces, 12 edges, and 8 corners", () => {
    expect(CUBE_REGIONS).toHaveLength(26);
    expect(CUBE_REGIONS.filter((r) => r.kind === "face")).toHaveLength(6);
    expect(CUBE_REGIONS.filter((r) => r.kind === "edge")).toHaveLength(12);
    expect(CUBE_REGIONS.filter((r) => r.kind === "corner")).toHaveLength(8);
  });

  it("labels each face with one anatomical letter", () => {
    expect(new Set(CUBE_FACES.map((face) => face.label))).toEqual(
      new Set(["R", "L", "A", "P", "S", "I"]),
    );
  });

  it("labels edges with two letters and corners with three", () => {
    for (const region of CUBE_REGIONS) {
      const expected = region.kind === "face" ? 1 : region.kind === "edge" ? 2 : 3;
      expect(region.label).toHaveLength(expected);
    }
  });

  it("spells out a face name in full", () => {
    expect(CUBE_FACES.find((face) => face.label === "S")?.title).toBe("Superior");
  });

  it("gives every region a unique identifier", () => {
    expect(new Set(CUBE_REGIONS.map((region) => region.id)).size).toBe(26);
  });
});

describe("anglesFor and cameraPosition", () => {
  it("round-trips every region direction", () => {
    for (const region of CUBE_REGIONS) {
      const wanted = normalize(region.direction);
      const placed = cameraPosition(anglesFor(region.direction), [0, 0, 0], 1);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(placed[axis]).toBeCloseTo(wanted[axis]!, 6);
      }
    }
  });

  it("puts the camera above the patient for the superior view", () => {
    expect(anglesFor([0, 0, 1]).elevation).toBeCloseTo(Math.PI / 2, 6);
  });

  it("puts the camera in front of the patient for the anterior view", () => {
    // Anterior is -y in DICOM patient coordinates.
    const placed = cameraPosition(anglesFor([0, -1, 0]), [0, 0, 0], 10);
    expect(placed[1]).toBeCloseTo(-10, 6);
    expect(placed[2]).toBeCloseTo(0, 6);
  });

  it("keeps the distance from the middle", () => {
    const placed = cameraPosition(anglesFor([1, 1, 1]), [5, 5, 5], 20);
    expect(Math.hypot(placed[0] - 5, placed[1] - 5, placed[2] - 5)).toBeCloseTo(20, 6);
  });
});

describe("regionFacing", () => {
  it.each(CUBE_FACES.map((face) => [face.label, face.direction] as const))(
    "finds the %s face from its own angles",
    (label, direction) => {
      expect(regionFacing(anglesFor(direction)).label).toBe(label);
    },
  );

  it("prefers a face over a corner when the camera is close to both", () => {
    // Slightly off the anterior face, but not enough to mean a corner.
    expect(regionFacing(anglesFor([0.1, -1, 0.1])).kind).toBe("face");
  });

  it("names a corner when the camera really is at one", () => {
    expect(regionFacing(anglesFor([1, 1, 1])).kind).toBe("corner");
  });
});

describe("turn", () => {
  it("turns a quarter of a circle to the right", () => {
    expect(turn({ azimuth: 0, elevation: 0 }, "right").azimuth).toBeCloseTo(Math.PI / 2, 6);
  });

  it("moves from anterior to left after one turn", () => {
    const anterior = anglesFor([0, -1, 0]);
    const placed = cameraPosition(turn(anterior, "right"), [0, 0, 0], 1);
    expect(placed[0]).toBeCloseTo(1, 6);
  });

  it("stops short of the pole so the view never flips", () => {
    let angles = { azimuth: 0, elevation: 0 };
    for (let i = 0; i < 5; i += 1) angles = turn(angles, "up");
    expect(angles.elevation).toBeLessThan(Math.PI / 2);
    expect(angles.elevation).toBeGreaterThan(0);
  });
});
