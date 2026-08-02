/**
 * Small vector and matrix helpers.
 *
 * The core keeps its own types so it stays free of three.js. The shell converts
 * to three.js types at the boundary.
 */

export type Vec3 = readonly [number, number, number];

/** A 4x4 matrix in column-major order, the layout that WebGL and three.js use. */
export type Mat4 = readonly number[] & { length: 16 };

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(subtract(a, b));
}

/** Return the unit vector. A zero vector is returned unchanged. */
export function normalize(v: Vec3): Vec3 {
  const size = length(v);
  return size === 0 ? v : scale(v, 1 / size);
}

export function isFinite3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/**
 * Build a column-major 4x4 from three axis vectors and a translation.
 *
 * Each axis already carries its scale, so the result maps voxel indices to
 * patient millimeters in one step.
 */
export function affineFromAxes(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): Mat4 {
  return [
    x[0],
    x[1],
    x[2],
    0,
    y[0],
    y[1],
    y[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    origin[0],
    origin[1],
    origin[2],
    1,
  ] as unknown as Mat4;
}

export function applyAffine(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
  ];
}

/**
 * Invert an affine matrix whose last row is `0 0 0 1`.
 *
 * @throws {RangeError} if the upper 3x3 block is singular.
 */
export function invertAffine(m: Mat4): Mat4 {
  const a = m[0]!,
    b = m[4]!,
    c = m[8]!;
  const d = m[1]!,
    e = m[5]!,
    f = m[9]!;
  const g = m[2]!,
    h = m[6]!,
    i = m[10]!;

  const cofactor0 = e * i - f * h;
  const cofactor1 = f * g - d * i;
  const cofactor2 = d * h - e * g;
  const determinant = a * cofactor0 + b * cofactor1 + c * cofactor2;
  if (determinant === 0 || !Number.isFinite(determinant)) {
    throw new RangeError("matrix is singular and cannot be inverted");
  }
  const s = 1 / determinant;

  const n0 = cofactor0 * s;
  const n1 = (c * h - b * i) * s;
  const n2 = (b * f - c * e) * s;
  const n3 = cofactor1 * s;
  const n4 = (a * i - c * g) * s;
  const n5 = (c * d - a * f) * s;
  const n6 = cofactor2 * s;
  const n7 = (b * g - a * h) * s;
  const n8 = (a * e - b * d) * s;

  const t: Vec3 = [m[12]!, m[13]!, m[14]!];
  return [
    n0,
    n3,
    n6,
    0,
    n1,
    n4,
    n7,
    0,
    n2,
    n5,
    n8,
    0,
    -(n0 * t[0] + n1 * t[1] + n2 * t[2]),
    -(n3 * t[0] + n4 * t[1] + n5 * t[2]),
    -(n6 * t[0] + n7 * t[1] + n8 * t[2]),
    1,
  ] as unknown as Mat4;
}
