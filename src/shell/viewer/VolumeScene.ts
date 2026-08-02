/**
 * The renderer.
 *
 * One WebGL context draws every pane. A browser allows only a handful of
 * contexts, and four separate canvases would waste them. Each pane is a
 * scissored viewport instead.
 */
import {
  BoxGeometry,
  BackSide,
  Camera,
  DoubleSide,
  GLSL3,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import {
  clipEquation,
  cursorInPlane,
  patientBounds,
  standardPlane,
  type Bounds,
  type CutPlane,
  type PlaneId,
} from "../../core/view/planes.ts";
import type { Vec3 } from "../../core/geometry/vec3.ts";
import { readSequenceKind, type SequencePair } from "../../core/tissue/sequence.ts";
import { PLANE_FRAGMENT, PLANE_VERTEX, VOLUME_FRAGMENT, VOLUME_VERTEX } from "./shaders.ts";
import { createVolumeTexture, type VolumeTexture } from "./volumeTexture.ts";
import type { Volume } from "../../core/volume/build.ts";
import { ViewCube } from "./ViewCube.ts";
import type { CubeRegion } from "../../core/view/viewcube.ts";

export interface Viewport {
  /** Left edge, in CSS pixels from the left of the canvas. */
  readonly x: number;
  /** Top edge, in CSS pixels from the top of the canvas. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OrbitState {
  /** Rotation about the superior axis, in radians. */
  readonly azimuth: number;
  /** Rotation above the axial plane, in radians. */
  readonly elevation: number;
  /** Camera distance as a multiple of the volume diagonal. */
  readonly zoom: number;
}

export interface ViewerState {
  readonly cursor: Vec3;
  readonly windowCenter: number;
  readonly windowWidth: number;
  readonly tissueMix: number;
  readonly slabThickness: number;
  readonly paneZoom: number;
  /** Shift of each cut inside its own plane, in millimeters. */
  readonly pan: Readonly<Record<PlaneId, readonly [number, number]>>;
  readonly orbit: OrbitState;
  readonly clip: Readonly<Record<PlaneId, boolean>>;
  readonly clipFlip: Readonly<Record<PlaneId, boolean>>;
  readonly opacity: number;
  readonly lightStrength: number;
  /** Windowed brightness below which the 3D view treats a voxel as empty. */
  readonly threshold: number;
  /** How much the 3D view favours boundaries over the inside of a tissue. */
  readonly edgeBoost: number;
  readonly showCrosshair: boolean;
  readonly invert: boolean;
}

/** The uniforms that name tissue. Both materials carry the same set. */
const TISSUE_UNIFORMS = () => ({
  uCompanion: { value: null },
  uCompanionDims: { value: new Vector3(1, 1, 1) },
  uPatientToCompanion: { value: new Matrix4() },
  uHasCompanion: { value: 0 },
  uActiveIsT1: { value: 0 },
  uActiveIsFatSat: { value: 0 },
  uSignalRange: { value: new Vector2(0, 1) },
  uCompanionRange: { value: new Vector2(0, 1) },
});

const PLANE_UNIFORMS = () => ({
  ...TISSUE_UNIFORMS(),
  uVolume: { value: null },
  uDims: { value: new Vector3() },
  uStoredScale: { value: 1 },
  uStoredBias: { value: 0 },
  uSlope: { value: 1 },
  uIntercept: { value: 0 },
  uWindowCenter: { value: 0 },
  uWindowWidth: { value: 1 },
  uInvert: { value: 0 },
  uTissueMix: { value: 0 },
  uPatientToVoxel: { value: new Matrix4() },
  uPlaneOrigin: { value: new Vector3() },
  uPlaneU: { value: new Vector3() },
  uPlaneV: { value: new Vector3() },
  uPlaneSize: { value: new Vector2() },
  uThickness: { value: 0 },
  uSlabSteps: { value: 1 },
  uCursorOffset: { value: new Vector2() },
  uCrosshair: { value: new Vector2(1, 0.2) },
});

const VOLUME_UNIFORMS = () => ({
  ...TISSUE_UNIFORMS(),
  uVolume: { value: null },
  uDims: { value: new Vector3() },
  uStoredScale: { value: 1 },
  uStoredBias: { value: 0 },
  uSlope: { value: 1 },
  uIntercept: { value: 0 },
  uWindowCenter: { value: 0 },
  uWindowWidth: { value: 1 },
  uInvert: { value: 0 },
  uTissueMix: { value: 0 },
  uPatientToVoxel: { value: new Matrix4() },
  uVoxelToPatient: { value: new Matrix4() },
  uCameraPatient: { value: new Vector3() },
  uStepScale: { value: 1 },
  uOpacity: { value: 1 },
  uClipPlanes: { value: [new Vector4(), new Vector4(), new Vector4()] },
  uClipEnabled: { value: [0, 0, 0] },
  uLightStrength: { value: 0.6 },
  uThreshold: { value: 0.2 },
  uEdgeBoost: { value: 0.7 },
});

const CUBE_SIZE = 132;
const CUBE_MARGIN = 12;

/** Where the view cube sits inside the 3D pane: the top right corner. */
export function cubeViewport(pane: Viewport): Viewport {
  const size = Math.min(CUBE_SIZE, Math.floor(Math.min(pane.width, pane.height) * 0.4));
  return {
    x: pane.x + pane.width - size - CUBE_MARGIN,
    y: pane.y + CUBE_MARGIN,
    width: size,
    height: size,
  };
}

/** Turn the column-major array from the core into a three.js matrix. */
function toMatrix4(values: readonly number[]): Matrix4 {
  return new Matrix4().fromArray(values as number[]);
}

export class VolumeScene {
  readonly renderer: WebGLRenderer;
  private readonly planeScene = new Scene();
  private readonly planeCamera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
  private readonly planeMesh: Mesh;
  private readonly planeMaterial: ShaderMaterial;

  private readonly volumeScene = new Scene();
  private readonly volumeCamera = new PerspectiveCamera(45, 1, 0.1, 5000);
  private readonly volumeMesh: Mesh;
  private readonly volumeMaterial: ShaderMaterial;

  private texture?: VolumeTexture;
  private bounds?: Bounds;
  readonly cube = new ViewCube();

  /**
   * Uploaded volumes, by series.
   *
   * Switching between the T1 and the fat-saturated series swaps which one is
   * active and which one is the partner. Both stay on the GPU across that swap,
   * so the switch costs nothing. Nothing else is kept: a volume can be hundreds
   * of megabytes, and two is the most that any one view needs.
   */
  private readonly uploaded = new Map<string, VolumeTexture>();

  private textureFor(volume: Volume): VolumeTexture {
    const key = volume.seriesInstanceUid;
    const existing = this.uploaded.get(key);
    if (existing) return existing;
    const created = createVolumeTexture(volume);
    this.uploaded.set(key, created);
    return created;
  }

  private evictExcept(keep: readonly string[]): void {
    for (const [key, texture] of this.uploaded) {
      if (keep.includes(key)) continue;
      texture.dispose();
      this.uploaded.delete(key);
    }
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x07080b, 1);
    this.renderer.autoClear = false;

    this.planeMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: PLANE_VERTEX,
      fragmentShader: PLANE_FRAGMENT,
      uniforms: PLANE_UNIFORMS(),
      side: DoubleSide,
    });
    this.planeMesh = new Mesh(new PlaneGeometry(1, 1), this.planeMaterial);
    this.planeScene.add(this.planeMesh);

    this.volumeMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VOLUME_VERTEX,
      fragmentShader: VOLUME_FRAGMENT,
      uniforms: VOLUME_UNIFORMS(),
      transparent: true,
      depthWrite: false,
      // Draw the far faces so the ray always starts at the camera side.
      side: BackSide,
    });
    this.volumeMesh = new Mesh(new BoxGeometry(1, 1, 1), this.volumeMaterial);
    this.volumeMesh.matrixAutoUpdate = false;
    this.volumeScene.add(this.volumeMesh);
  }

  get hasVolume(): boolean {
    return this.texture !== undefined;
  }

  /**
   * Show a series, and name tissue from its partner when the study has one.
   *
   * Without a partner the viewer still colors, from one sequence, and says so.
   * One sequence cannot separate fat from fluid, and the classifier reports
   * that by halving its confidence, which fades the color toward gray.
   */
  setVolume(volume: Volume, pair?: SequencePair): void {
    this.texture = this.textureFor(volume);
    this.bounds = patientBounds(volume);

    const activeIsT1 = pair?.t1.seriesInstanceUid === volume.seriesInstanceUid;
    const partner = pair ? (activeIsT1 ? pair.fatsat : pair.t1) : undefined;
    // With no partner the active texture is bound in its place. A sampler that
    // is never read still has to be complete, or the driver warns on every draw.
    const companion = partner ? this.textureFor(partner) : this.texture;
    this.evictExcept([volume.seriesInstanceUid, companion.volume.seriesInstanceUid]);

    const dims = new Vector3(volume.dims[0], volume.dims[1], volume.dims[2]);
    const patientToVoxel = toMatrix4(this.texture.patientToVoxel);
    const voxelToPatient = toMatrix4(volume.voxelToPatient);

    const activeKind = readSequenceKind(volume.description);
    const companionDims = new Vector3(...companion.volume.dims);
    const patientToCompanion = toMatrix4(companion.patientToVoxel);
    const ownRange = this.texture.signalRange;
    const companionRange = companion.signalRange;

    for (const material of [this.planeMaterial, this.volumeMaterial]) {
      const u = material.uniforms;
      u.uVolume!.value = this.texture.texture;
      (u.uDims!.value as Vector3).copy(dims);
      u.uStoredScale!.value = this.texture.storedScale;
      u.uStoredBias!.value = this.texture.storedBias;
      u.uSlope!.value = volume.rescaleSlope;
      u.uIntercept!.value = volume.rescaleIntercept;
      (u.uPatientToVoxel!.value as Matrix4).copy(patientToVoxel);

      u.uCompanion!.value = companion.texture;
      (u.uCompanionDims!.value as Vector3).copy(companionDims);
      (u.uPatientToCompanion!.value as Matrix4).copy(patientToCompanion);
      u.uHasCompanion!.value = partner ? 1 : 0;
      u.uActiveIsT1!.value = activeKind === "t1" ? 1 : 0;
      u.uActiveIsFatSat!.value = activeKind === "fatsat" ? 1 : 0;
      (u.uSignalRange!.value as Vector2).set(ownRange.low, ownRange.high);
      (u.uCompanionRange!.value as Vector2).set(companionRange.low, companionRange.high);
      material.needsUpdate = true;
    }
    (this.volumeMaterial.uniforms.uVoxelToPatient!.value as Matrix4).copy(voxelToPatient);

    // Map the unit cube onto the voxel box, then into patient space.
    const box = new Matrix4()
      .makeTranslation((dims.x - 1) / 2, (dims.y - 1) / 2, (dims.z - 1) / 2)
      .multiply(new Matrix4().makeScale(dims.x, dims.y, dims.z));
    this.volumeMesh.matrix.copy(voxelToPatient).multiply(box);
    this.volumeMesh.matrixWorldNeedsUpdate = true;
  }

  get volumeBounds(): Bounds | undefined {
    return this.bounds;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  clear(): void {
    this.renderer.setScissorTest(false);
    this.renderer.clear(true, true, true);
  }

  /** Set the region of the canvas that the next draw writes to. */
  private useViewport(view: Viewport): void {
    const height = this.renderer.domElement.clientHeight;
    const bottom = height - view.y - view.height;
    this.renderer.setViewport(view.x, bottom, view.width, view.height);
    this.renderer.setScissor(view.x, bottom, view.width, view.height);
    this.renderer.setScissorTest(true);
  }

  private applyShared(material: ShaderMaterial, state: ViewerState): void {
    const u = material.uniforms;
    u.uWindowCenter!.value = state.windowCenter;
    u.uWindowWidth!.value = Math.max(state.windowWidth, 1e-3);
    u.uTissueMix!.value = state.tissueMix;
    u.uInvert!.value = state.invert ? 1 : 0;
  }

  /**
   * Draw one cut.
   *
   * The plane is fitted to the viewport so a millimeter is the same length
   * across and down. Without that the anatomy looks stretched.
   */
  drawPlane(view: Viewport, plane: CutPlane, state: ViewerState): void {
    if (!this.texture) return;
    this.useViewport(view);

    const aspect = view.width / Math.max(view.height, 1);
    const planeAspect = plane.size[0] / Math.max(plane.size[1], 1e-6);
    const fitted: [number, number] =
      planeAspect > aspect
        ? [plane.size[0], plane.size[0] / aspect]
        : [plane.size[1] * aspect, plane.size[1]];

    const u = this.planeMaterial.uniforms;
    this.applyShared(this.planeMaterial, state);
    (u.uPlaneOrigin!.value as Vector3).set(...plane.origin);
    (u.uPlaneU!.value as Vector3).set(...plane.u);
    (u.uPlaneV!.value as Vector3).set(...plane.v);
    (u.uPlaneSize!.value as Vector2).set(fitted[0] / state.paneZoom, fitted[1] / state.paneZoom);
    u.uThickness!.value = state.slabThickness;
    u.uSlabSteps!.value = state.slabThickness > 0.01 ? 16 : 1;

    const offset = cursorInPlane(plane, state.cursor);
    (u.uCursorOffset!.value as Vector2).set(offset.x * plane.size[0], offset.y * plane.size[1]);
    // A line two pixels wide, whatever the zoom.
    (u.uCrosshair!.value as Vector2).set(
      state.showCrosshair ? 1 : 0,
      (fitted[0] / state.paneZoom / Math.max(view.width, 1)) * 1.5,
    );

    this.renderer.render(this.planeScene, this.planeCamera);
  }

  /** Place the orbit camera and draw the raymarched view. */
  drawVolume(
    view: Viewport,
    state: ViewerState,
    planes: readonly CutPlane[],
    hoveredCubeRegion?: CubeRegion,
  ): void {
    if (!this.texture || !this.bounds) return;
    this.useViewport(view);

    const { center, diagonal } = this.bounds;
    const distance = diagonal * state.orbit.zoom;
    const { azimuth, elevation } = state.orbit;
    const position = new Vector3(
      center[0] + distance * Math.cos(elevation) * Math.sin(azimuth),
      center[1] - distance * Math.cos(elevation) * Math.cos(azimuth),
      center[2] + distance * Math.sin(elevation),
    );

    this.volumeCamera.aspect = view.width / Math.max(view.height, 1);
    this.volumeCamera.near = Math.max(distance - diagonal, 0.01);
    this.volumeCamera.far = distance + diagonal * 2;
    // DICOM +z is Superior, so it is the up direction, not three.js's default y.
    this.volumeCamera.up.set(0, 0, 1);
    this.volumeCamera.position.copy(position);
    this.volumeCamera.lookAt(center[0], center[1], center[2]);
    this.volumeCamera.updateProjectionMatrix();

    const u = this.volumeMaterial.uniforms;
    this.applyShared(this.volumeMaterial, state);
    (u.uCameraPatient!.value as Vector3).copy(position);
    u.uOpacity!.value = state.opacity;
    u.uLightStrength!.value = state.lightStrength;
    u.uThreshold!.value = state.threshold;
    u.uEdgeBoost!.value = state.edgeBoost;

    // One step per voxel keeps detail without wasting fill rate.
    const smallestSpacing = Math.min(...this.texture.volume.spacing);
    const longestSide = Math.max(...this.texture.volume.dims);
    u.uStepScale!.value = Math.max(0.25, longestSide / 512) * (smallestSpacing > 0 ? 1 : 1);

    const equations = u.uClipPlanes!.value as Vector4[];
    const enabled = u.uClipEnabled!.value as number[];
    planes.forEach((plane, index) => {
      if (index > 2) return;
      const active = state.clip[plane.id];
      enabled[index] = active ? 1 : 0;
      if (active) {
        equations[index]!.set(...clipEquation(plane, state.clipFlip[plane.id]));
      }
    });

    this.renderer.render(this.volumeScene, this.volumeCamera as Camera);
    this.cube.draw(this.renderer, cubeViewport(view), state.orbit, hoveredCubeRegion);
  }

  /** The cut planes for the current cursor and pan. */
  planesFor(volume: Volume, state: ViewerState): CutPlane[] {
    return (["axial", "coronal", "sagittal"] as const).map((id) =>
      standardPlane(volume, id, state.cursor, state.pan[id]),
    );
  }

  dispose(): void {
    this.cube.dispose();
    this.evictExcept([]);
    this.texture = undefined;
    this.planeMesh.geometry.dispose();
    this.planeMaterial.dispose();
    this.volumeMesh.geometry.dispose();
    this.volumeMaterial.dispose();
    this.renderer.dispose();
  }
}
