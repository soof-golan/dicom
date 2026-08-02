/**
 * The GLSL that draws the volume.
 *
 * Both shaders sample one 3D texture. The plane shader reads a single point per
 * pixel, which makes any cut angle cost the same. The volume shader walks a ray
 * through the same texture and adds up what it passes.
 */

/** Shared code: sampling, the window transform, and the tissue palette. */
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

// Texture coordinates for a voxel index. A voxel center sits at index + 0.5.
vec3 voxelToTexture(vec3 voxel) {
  return (voxel + 0.5) / uDims;
}

bool insideVolume(vec3 voxel) {
  return all(greaterThanEqual(voxel, vec3(-0.5))) &&
         all(lessThanEqual(voxel, uDims - 0.5));
}

// The value the scanner recorded, after the rescale transform.
float sampleValue(vec3 voxel) {
  float normalized = texture(uVolume, voxelToTexture(voxel)).r;
  return (normalized * uStoredScale + uStoredBias) * uSlope + uIntercept;
}

// Map a value onto 0..1 with the window that the user set.
float applyWindow(float value) {
  float low = uWindowCenter - 0.5 * uWindowWidth;
  float gray = clamp((value - low) / max(uWindowWidth, 1e-6), 0.0, 1.0);
  return mix(gray, 1.0 - gray, uInvert);
}

// A perceptual ramp for tissue. Dark signal reads as bone or tendon, mid signal
// as muscle, bright signal as fluid or edema. The colors are the same ones the
// legend shows, so a reader learns them once.
vec3 tissueColor(float gray) {
  const vec3 cortex = vec3(0.29, 0.33, 0.44); // dark: cortical bone, tendon
  const vec3 muscle = vec3(0.62, 0.30, 0.29); // low mid: muscle
  const vec3 marrow = vec3(0.93, 0.84, 0.63); // high mid: fat and marrow
  const vec3 fluid = vec3(0.42, 0.85, 1.00); // bright: fluid, edema
  const vec3 hot = vec3(0.99, 0.98, 0.92); // brightest: free fluid

  if (gray < 0.25) return mix(vec3(0.05, 0.06, 0.09), cortex, gray / 0.25);
  if (gray < 0.50) return mix(cortex, muscle, (gray - 0.25) / 0.25);
  if (gray < 0.72) return mix(muscle, marrow, (gray - 0.50) / 0.22);
  if (gray < 0.88) return mix(marrow, fluid, (gray - 0.72) / 0.16);
  return mix(fluid, hot, (gray - 0.88) / 0.12);
}

vec3 shade(float gray) {
  return mix(vec3(gray), tissueColor(gray), uTissueMix);
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
    best = max(best, sampleValue(voxel));
    found = 1.0;
  }

  if (found < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = vec4(shade(applyWindow(best)), 1.0);
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

// Central differences give a surface normal, which is what makes the render
// read as a shape instead of a fog.
vec3 gradientAt(vec3 voxel) {
  vec2 d = vec2(1.0, 0.0);
  return normalize(vec3(
    sampleValue(voxel + d.xyy) - sampleValue(voxel - d.xyy),
    sampleValue(voxel + d.yxy) - sampleValue(voxel - d.yxy),
    sampleValue(voxel + d.yyx) - sampleValue(voxel - d.yyx)
  ) + 1e-6);
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
    if (gray <= 0.01) continue;

    // Opacity rises faster than brightness, so faint tissue stays see-through.
    float sampleAlpha = clamp(gray * gray * uOpacity * step, 0.0, 1.0);
    vec3 sampleColor = shade(gray);

    vec3 normal = gradientAt(voxel);
    vec3 toEye = -direction;
    float lambert = abs(dot(normal, toEye));
    sampleColor *= mix(1.0, 0.35 + 0.65 * lambert, uLightStrength);

    color += (1.0 - alpha) * sampleAlpha * sampleColor;
    alpha += (1.0 - alpha) * sampleAlpha;
  }

  if (alpha < 0.01) discard;
  outColor = vec4(color / max(alpha, 1e-4), alpha);
}
`;
