/**
 * The CAD-style view cube.
 *
 * It sits in a corner of the 3D view and turns with the camera. Click a face,
 * an edge, or a corner to jump to that view. Drag it to turn freely.
 *
 * Labels are drawn to a canvas and used as textures. The HTML-in-Canvas
 * proposal would put real DOM on the faces, but it ships in one engine behind a
 * flag. See `docs/research/html-in-canvas.md`.
 */
import {
  BoxGeometry,
  CanvasTexture,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from "three";
import {
  anglesFor,
  cameraPosition,
  CUBE_REGIONS,
  type CameraAngles,
  type CubeRegion,
} from "../../core/view/viewcube.ts";
import type { Viewport } from "./VolumeScene.ts";

const SIZE = 128;

/**
 * Face order of a three.js box: +X, -X, +Y, -Y, +Z, -Z.
 *
 * In DICOM patient coordinates that is Left, Right, Posterior, Anterior,
 * Superior, Inferior.
 */
const FACE_ORDER = ["L", "R", "P", "A", "S", "I"] as const;

/**
 * Quarter turns to apply to each face label, clockwise.
 *
 * A box in three.js lays its faces out for a Y-up world, and patient
 * coordinates are Z-up. Without a turn, four of the six labels read sideways or
 * upside down.
 *
 * The texture axes of each face come from the box builder. Written as
 * (right, up) in patient coordinates they are:
 *
 *     +X Left       (-Z, +Y)      -X Right     (+Z, +Y)
 *     +Y Posterior  (+X, -Z)      -Y Anterior  (+X, +Z)
 *     +Z Superior   (+X, +Y)      -Z Inferior  (-X, +Y)
 *
 * Superior points up on the four side faces. On the top and bottom faces,
 * Posterior points away from a reader who stands in front of the patient.
 */
const FACE_TURNS: Record<string, number> = {
  L: -1,
  R: 1,
  P: 2,
  A: 0,
  S: 0,
  I: 2,
};

const FACE_NAMES: Record<string, string> = {
  L: "LEFT",
  R: "RIGHT",
  P: "POST",
  A: "ANT",
  S: "SUP",
  I: "INF",
};

function faceTexture(code: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("cannot draw the view cube labels");

  context.fillStyle = "#161a22";
  context.fillRect(0, 0, SIZE, SIZE);
  context.strokeStyle = "#39414f";
  context.lineWidth = 4;
  context.strokeRect(2, 2, SIZE - 4, SIZE - 4);

  context.translate(SIZE / 2, SIZE / 2);
  context.rotate(((FACE_TURNS[code] ?? 0) * Math.PI) / 2);
  context.translate(-SIZE / 2, -SIZE / 2);

  context.fillStyle = "#dbe3f0";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "600 52px ui-sans-serif, system-ui, sans-serif";
  context.fillText(code, SIZE / 2, SIZE / 2 - 8);

  context.fillStyle = "#7d8798";
  context.font = "500 18px ui-sans-serif, system-ui, sans-serif";
  context.fillText(FACE_NAMES[code] ?? "", SIZE / 2, SIZE / 2 + 32);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Which of the 26 regions a point on the cube surface belongs to. */
function regionAt(local: Vector3): CubeRegion | undefined {
  const EDGE = 0.34;
  const step = (value: number): number => (value > EDGE ? 1 : value < -EDGE ? -1 : 0);
  const id = `${step(local.x)},${step(local.y)},${step(local.z)}`;
  return CUBE_REGIONS.find((region) => region.id === id);
}

export class ViewCube {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-0.9, 0.9, 0.9, -0.9, 0.01, 20);
  private readonly mesh: Mesh;
  private readonly outline: LineSegments;
  private readonly highlight: Mesh;
  private readonly raycaster = new Raycaster();
  private readonly textures: CanvasTexture[];

  constructor() {
    const geometry = new BoxGeometry(1, 1, 1);
    this.textures = FACE_ORDER.map(faceTexture);
    this.mesh = new Mesh(
      geometry,
      this.textures.map((map) => new MeshBasicMaterial({ map })),
    );
    this.scene.add(this.mesh);

    this.outline = new LineSegments(
      new EdgesGeometry(geometry),
      new LineBasicMaterial({ color: 0x4a5568 }),
    );
    this.scene.add(this.outline);

    // A small marker that sits on the region under the pointer, so the reader
    // sees which of the 26 targets a click will take.
    this.highlight = new Mesh(
      new BoxGeometry(0.34, 0.34, 0.34),
      new MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.camera.up.set(0, 0, 1);
  }

  /** Point the cube camera the same way as the main camera. */
  private aim(angles: CameraAngles): void {
    const at = cameraPosition(angles, [0, 0, 0], 4);
    this.camera.position.set(at[0], at[1], at[2]);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  draw(renderer: WebGLRenderer, view: Viewport, angles: CameraAngles, hovered?: CubeRegion): void {
    this.aim(angles);
    this.highlight.visible = hovered !== undefined;
    if (hovered) {
      const [x, y, z] = hovered.direction;
      this.highlight.position.set(x * 0.42, y * 0.42, z * 0.42);
    }

    const canvasHeight = renderer.domElement.clientHeight;
    renderer.setViewport(view.x, canvasHeight - view.y - view.height, view.width, view.height);
    renderer.setScissor(view.x, canvasHeight - view.y - view.height, view.width, view.height);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  /**
   * The region under a pointer.
   *
   * @param x Position inside the cube viewport, from its left edge.
   * @param y Position inside the cube viewport, from its top edge.
   */
  pick(x: number, y: number, view: Viewport, angles: CameraAngles): CubeRegion | undefined {
    this.aim(angles);
    const point = new Vector2(
      (x / Math.max(view.width, 1)) * 2 - 1,
      -((y / Math.max(view.height, 1)) * 2 - 1),
    );
    if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return undefined;

    this.raycaster.setFromCamera(point, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit) return undefined;
    return regionAt(this.mesh.worldToLocal(hit.point.clone()));
  }

  /** The angles a region means, for snapping the main camera. */
  static anglesOf(region: CubeRegion): CameraAngles {
    return anglesFor(region.direction);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const material of this.mesh.material as MeshBasicMaterial[]) material.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as LineBasicMaterial).dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as MeshBasicMaterial).dispose();
  }
}
