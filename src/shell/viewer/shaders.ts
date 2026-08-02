/**
 * The GLSL that draws the volume.
 *
 * Both shaders sample one 3D texture. The plane shader reads a single point per
 * pixel, which makes any cut angle cost the same. The volume shader walks a ray
 * through the same texture and adds up what it passes.
 *
 * A second texture holds the partner sequence, when the study has one. The
 * classifier needs a T1 value and a fat-saturated value at the same point in
 * the patient, and the two series sit on different grids. The shader crosses
 * between them through patient millimeters, which is the one thing they share.
 */
import { tissueGlsl } from "../../core/tissue/glsl.ts";
import { structureGlsl } from "../../core/tissue/structureGlsl.ts";

/** Shared code: sampling, the window transform, and the tissue classifier. */
const COMMON = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler3D uVolume;
uniform vec3 uDims;
uniform float uStoredScale;
uniform float uStoredBias;
uniform float uSlope;
uniform float uIntercept;
uniform float uWindowCenter;
uniform float uWindowWidth;
uniform float uInvert;
uniform float uTissueMix;

// The partner sequence. When the study holds no partner, uHasCompanion is 0 and
// this texture is the active one, so the sampler is always complete.
uniform sampler3D uCompanion;
uniform vec3 uCompanionDims;
uniform mat4 uPatientToCompanion;
uniform float uHasCompanion;
// Which of the two the active series is. The classifier needs them in order.
uniform float uActiveIsT1;
uniform float uActiveIsFatSat;
// Where tissue sits in each series, as a fraction of the stored range. The
// classifier compares two sequences that share no unit, so each one is put on
// its own percentile scale first.
uniform vec2 uSignalRange;
uniform vec2 uCompanionRange;

${tissueGlsl()}
${structureGlsl()}

// Texture coordinates for a voxel index. A voxel center sits at index + 0.5.
vec3 voxelToTexture(vec3 voxel) {
  return (voxel + 0.5) / uDims;
}

bool insideVolume(vec3 voxel) {
  return all(greaterThanEqual(voxel, vec3(-0.5))) &&
         all(lessThanEqual(voxel, uDims - 0.5));
}

// Put a raw texture read onto the percentile scale of its own series. Without
// this every value is divided by the brightest voxel in the volume, which is
// noise, and all the tissue lands near zero and reads as bone.
float toSignal(float raw, vec2 range) {
  return clamp((raw - range.x) / max(range.y - range.x, 1e-6), 0.0, 1.0);
}

// The texture as stored: 0 is the darkest voxel of the volume and 1 the
// brightest. Brightness and contrast are built from this, because the scale and
// bias that recover the scanner's own numbers are defined against it.
float sampleRaw(vec3 voxel) {
  return texture(uVolume, voxelToTexture(voxel)).r;
}

// Signal on its own percentile scale. This is what the classifier compares,
// because the two sequences have no common unit: MRI signal is not calibrated
// the way a CT Hounsfield number is.
float sampleNormalized(vec3 voxel) {
  return toSignal(sampleRaw(voxel), uSignalRange);
}

// The value the scanner recorded, after the rescale transform.
float sampleValue(vec3 voxel) {
  return (sampleRaw(voxel) * uStoredScale + uStoredBias) * uSlope + uIntercept;
}

// Read the partner sequence at a point in the patient. Returns false where the
// partner did not cover that point, which happens at the edges, because the two
// series were prescribed over slightly different boxes.
bool sampleCompanion(vec3 patient, out float value) {
  vec3 voxel = (uPatientToCompanion * vec4(patient, 1.0)).xyz;
  value = toSignal(texture(uCompanion, (voxel + 0.5) / uCompanionDims).r, uCompanionRange);
  return all(greaterThanEqual(voxel, vec3(-0.5))) &&
         all(lessThanEqual(voxel, uCompanionDims - 0.5));
}

// Map a value onto 0..1 with the window that the user set.
float applyWindow(float value) {
  float low = uWindowCenter - 0.5 * uWindowWidth;
  float gray = clamp((value - low) / max(uWindowWidth, 1e-6), 0.0, 1.0);
  return mix(gray, 1.0 - gray, uInvert);
}

// Name the tissue at one point, from both sequences where both reach it.
vec4 tissueAt(vec3 voxel, vec3 patient) {
  // The series on screen is named "own" because GLSL ES 3.0 reserves the
  // obvious name for it, and rejects it with a syntax error.
  float own = sampleNormalized(voxel);
  float other;
  if (uHasCompanion > 0.5 && sampleCompanion(patient, other)) {
    float t1 = uActiveIsT1 > 0.5 ? own : other;
    float fatsat = uActiveIsT1 > 0.5 ? other : own;
    return classifyTissue(t1, fatsat);
  }
  return classifyTissueSingle(own, uActiveIsFatSat > 0.5);
}

vec3 shade(float gray, vec3 voxel, vec3 patient) {
  if (uTissueMix <= 0.0) return vec3(gray);
  vec4 tissue = tissueAt(voxel, patient);

  // Where the CPU named a dark structure, its answer wins. The signal rule
  // could only say "dark" there, and this says which dark thing. Everywhere
  // else the label is silent and the signal answer stands.
  vec4 structure = structureAt(patient);
  if (structure.a > 0.0) tissue = structure;

  // The hue names the tissue and the brightness keeps the anatomy readable. A
  // flat color hides the texture that makes the image worth looking at.
  vec3 colored = tissue.rgb * (0.35 + 0.65 * gray);
  // Confidence falls to zero at a band edge, and there the pixel stays gray.
  // A voxel that could belong to either class must not be painted as one.
  return mix(vec3(gray), colored, tissue.a * uTissueMix);
}
`;

export const PLANE_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Draw one cut through the volume.
 *
 * The plane is given in patient millimeters, so an oblique cut needs no
 * resampling step on the CPU. The shader walks straight from a screen pixel to
 * a point in the patient, then to a voxel.
 */
export const PLANE_FRAGMENT = /* glsl */ `
${COMMON}

uniform mat4 uPatientToVoxel;
uniform vec3 uPlaneOrigin;
uniform vec3 uPlaneU;
uniform vec3 uPlaneV;
uniform vec2 uPlaneSize;
uniform float uThickness;
uniform float uSlabSteps;
uniform vec2 uCursorOffset;
uniform vec2 uCrosshair;

in vec2 vUv;
out vec4 outColor;

void main() {
  // Texture coordinate v rises upward, and the v axis points down the screen,
  // so the second term is subtracted. Without this the image is upside down and
  // every edge label lies.
  vec3 patient = uPlaneOrigin
    + uPlaneU * ((vUv.x - 0.5) * uPlaneSize.x)
    + uPlaneV * ((0.5 - vUv.y) * uPlaneSize.y);

  vec3 normal = normalize(cross(uPlaneU, uPlaneV));
  float best = -3.4e38;
  float found = 0.0;
  // The classifier needs the place the brightest value came from, not only the
  // value, because it has to read the partner sequence at that same place.
  vec3 bestVoxel = vec3(0.0);
  vec3 bestPatient = patient;

  // A slab thicker than one voxel keeps the brightest value it crosses. This is
  // maximum intensity projection, and it makes a vessel visible in one image.
  for (float step = 0.0; step < 64.0; step += 1.0) {
    if (step >= uSlabSteps) break;
    float offset = uSlabSteps <= 1.0
      ? 0.0
      : (step / (uSlabSteps - 1.0) - 0.5) * uThickness;
    vec3 point = patient + normal * offset;
    vec3 voxel = (uPatientToVoxel * vec4(point, 1.0)).xyz;
    if (!insideVolume(voxel)) continue;
    float value = sampleValue(voxel);
    if (value > best) {
      best = value;
      bestVoxel = voxel;
      bestPatient = point;
    }
    found = 1.0;
  }

  if (found < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 color = shade(applyWindow(best), bestVoxel, bestPatient);

  // The crosshair marks the point that the other two cuts pass through.
  if (uCrosshair.x > 0.5) {
    vec2 here = vec2((vUv.x - 0.5) * uPlaneSize.x, (0.5 - vUv.y) * uPlaneSize.y);
    vec2 fromCursor = abs(here - uCursorOffset);
    float lineWidth = uCrosshair.y;
    float gap = lineWidth * 6.0;
    bool onLine =
      (fromCursor.x < lineWidth && fromCursor.y > gap) ||
      (fromCursor.y < lineWidth && fromCursor.x > gap);
    bool onRing =
      abs(length(fromCursor) - gap) < lineWidth;
    if (onLine || onRing) color = mix(color, vec3(0.42, 0.78, 1.0), 0.75);
  }

  outColor = vec4(color, 1.0);
}
`;

export const VOLUME_VERTEX = /* glsl */ `
out vec3 vPatient;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPatient = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Walk a ray through the volume and add up what it crosses.
 *
 * The ray runs in voxel space, where the volume is an axis-aligned box. That
 * makes the entry and exit points a plain slab test, whatever angle the patient
 * lies at.
 */
export const VOLUME_FRAGMENT = /* glsl */ `
${COMMON}

uniform mat4 uPatientToVoxel;
uniform mat4 uVoxelToPatient;
uniform vec3 uCameraPatient;
uniform float uStepScale;
uniform float uOpacity;
uniform vec4 uClipPlanes[3];
uniform float uClipEnabled[3];
uniform float uLightStrength;
uniform float uThreshold;
uniform float uEdgeBoost;

in vec3 vPatient;
out vec4 outColor;

// Distance range where a ray stays inside the box from vec3(-0.5) to uDims-0.5.
bool boxRange(vec3 origin, vec3 direction, out float tNear, out float tFar) {
  vec3 low = vec3(-0.5);
  vec3 high = uDims - 0.5;
  vec3 inverse = 1.0 / direction;
  vec3 a = (low - origin) * inverse;
  vec3 b = (high - origin) * inverse;
  vec3 first = min(a, b);
  vec3 last = max(a, b);
  tNear = max(max(first.x, first.y), first.z);
  tFar = min(min(last.x, last.y), last.z);
  return tFar > max(tNear, 0.0);
}

// Central differences on the windowed value. The direction is a surface normal,
// which makes the render read as a shape instead of a fog. The length says how
// fast the signal changes, which separates a boundary from the inside of a
// muscle.
vec4 gradientAt(vec3 voxel) {
  vec2 d = vec2(1.0, 0.0);
  vec3 g = vec3(
    applyWindow(sampleValue(voxel + d.xyy)) - applyWindow(sampleValue(voxel - d.xyy)),
    applyWindow(sampleValue(voxel + d.yxy)) - applyWindow(sampleValue(voxel - d.yxy)),
    applyWindow(sampleValue(voxel + d.yyx)) - applyWindow(sampleValue(voxel - d.yyx))
  );
  float size = length(g);
  return vec4(size > 1e-5 ? g / size : vec3(0.0, 0.0, 1.0), size);
}

bool clipped(vec3 patient) {
  for (int i = 0; i < 3; i += 1) {
    if (uClipEnabled[i] > 0.5 &&
        dot(uClipPlanes[i].xyz, patient) + uClipPlanes[i].w > 0.0) {
      return true;
    }
  }
  return false;
}

void main() {
  vec3 originVoxel = (uPatientToVoxel * vec4(uCameraPatient, 1.0)).xyz;
  vec3 targetVoxel = (uPatientToVoxel * vec4(vPatient, 1.0)).xyz;
  vec3 direction = normalize(targetVoxel - originVoxel);

  float tNear;
  float tFar;
  if (!boxRange(originVoxel, direction, tNear, tFar)) discard;
  tNear = max(tNear, 0.0);

  float step = uStepScale;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  for (int i = 0; i < 1024; i += 1) {
    float t = tNear + float(i) * step;
    if (t > tFar || alpha > 0.995) break;

    vec3 voxel = originVoxel + direction * t;
    vec3 patient = (uVoxelToPatient * vec4(voxel, 1.0)).xyz;
    if (clipped(patient)) continue;

    float gray = applyWindow(sampleValue(voxel));
    // Everything below the threshold is air, noise, or skin. Skipping it is what
    // lets the eye reach the joint instead of stopping at the surface.
    if (gray <= uThreshold) continue;

    vec4 gradient = gradientAt(voxel);

    // Levoy's rule: a boundary is more opaque than the inside of a tissue. This
    // is what turns a solid block into a structure you can see into.
    float above = (gray - uThreshold) / max(1.0 - uThreshold, 1e-4);
    float boundary = mix(1.0, clamp(gradient.w * 12.0, 0.0, 1.0), uEdgeBoost);
    float sampleAlpha = clamp(above * above * boundary * uOpacity * step, 0.0, 1.0);
    if (sampleAlpha <= 0.0005) continue;

    vec3 sampleColor = shade(gray, voxel, patient);
    float lambert = abs(dot(gradient.xyz, -direction));
    sampleColor *= mix(1.0, 0.35 + 0.65 * lambert, uLightStrength);

    color += (1.0 - alpha) * sampleAlpha * sampleColor;
    alpha += (1.0 - alpha) * sampleAlpha;
  }

  if (alpha < 0.01) discard;
  outColor = vec4(color / max(alpha, 1e-4), alpha);
}
`;
