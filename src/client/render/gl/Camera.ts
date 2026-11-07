/**
 * 2D camera: pan/zoom → column-major mat3 for WebGL2 vertex shaders.
 *
 * Pure viewport math — no DOM event listeners. Input handling lives
 * in GameView, which calls panBy / zoomAtScreen / etc.
 *
 * Coordinate system:
 *   World: (0,0) top-left, (mapWidth, mapHeight) bottom-right, +Y down.
 *   Clip:  (-1,-1) bottom-left, (1,1) top-right.
 *
 * The mat3 maps world → clip:
 *   sx = zoom * 2 / canvasWidth
 *   sy = zoom * -2 / canvasHeight   (Y flip)
 *   tx = -offsetX * sx
 *   ty = -offsetY * sy
 *
 * getMatrix() stays the flat 2D matrix (passes use it for zoom-based sizing
 * on the CPU). What shaders draw with is getFrame(): the 3D view-projection
 * for the current view mode (camera/MapViewSource.ts viewPose).
 */

import {
  computeCameraFrame,
  createCameraFrame,
  type CameraFrame,
} from "./camera/CameraMath";
import { viewPose, type MapViewParams } from "./camera/MapViewSource";
import type { CameraOrbit } from "./camera/ViewOrbit";
import { renderDpr } from "./utils/Dpr";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 20;
const DBLCLICK_MIN_ZOOM = 0.7;
const DBLCLICK_MAX_ZOOM = 3;

export class Camera {
  offsetX: number;
  offsetY: number;
  zoom: number;

  private mapW: number;
  private mapH: number;
  private canvasW = 1;
  private canvasH = 1;
  private mat = new Float32Array(9);
  private dirty = true;
  private view: MapViewParams = {
    mode: "flat",
    tiltDeg: 0,
    fovDeg: 40,
  };
  private orbit: CameraOrbit = { yawDeg: 0, elevationDeg: 30 };
  private frame: CameraFrame = createCameraFrame();
  private frameDirty = true;
  /** True until fitMap() has been called with valid canvas dimensions. */
  private needsInitialFit = true;

  constructor(mapWidth: number, mapHeight: number) {
    this.mapW = mapWidth;
    this.mapH = mapHeight;
    this.offsetX = mapWidth / 2;
    this.offsetY = mapHeight / 2;
    this.zoom = 1;
  }

  /** Update canvas pixel dimensions. Triggers initial fitMap on first call. */
  resize(cssWidth: number, cssHeight: number): void {
    const dpr = renderDpr();
    this.canvasW = Math.round(cssWidth * dpr);
    this.canvasH = Math.round(cssHeight * dpr);
    if (this.needsInitialFit) {
      this.fitMap();
    }
    this.dirty = true;
    this.frameDirty = true;
  }

  /** Fit the map into the viewport (~90% fill). */
  fitMap(): void {
    this.offsetX = this.mapW / 2;
    this.offsetY = this.mapH / 2;
    const sx = this.canvasW / this.mapW;
    const sy = this.canvasH / this.mapH;
    this.zoom = Math.min(sx, sy) * 0.9;
    this.dirty = true;
    this.frameDirty = true;
    this.needsInitialFit = false;
  }

  /** Center the camera on a bounding box with padding (1.4 ≈ 71% fill). */
  focusBBox(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    padding = 1.4,
  ): void {
    this.offsetX = (minX + maxX + 1) / 2;
    this.offsetY = (minY + maxY + 1) / 2;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const sx = this.canvasW / bboxW;
    const sy = this.canvasH / bboxH;
    this.zoom = Math.max(
      DBLCLICK_MIN_ZOOM,
      Math.min(DBLCLICK_MAX_ZOOM, Math.min(sx, sy) / padding),
    );
    this.clampOffset();
    this.dirty = true;
    this.frameDirty = true;
  }

  /** Set the camera center to a world position. */
  panTo(worldX: number, worldY: number): void {
    this.offsetX = worldX;
    this.offsetY = worldY;
    this.clampOffset();
    this.dirty = true;
    this.frameDirty = true;
  }

  /** Shift the camera center by a world-space delta (used for drag panning). */
  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clampOffset();
    this.dirty = true;
    this.frameDirty = true;
  }

  /** Restore camera state, skipping the initial fitMap. */
  setCameraState(x: number, y: number, z: number): void {
    this.offsetX = x;
    this.offsetY = y;
    this.zoom = z;
    this.needsInitialFit = false;
    this.dirty = true;
    this.frameDirty = true;
  }

  /** Multiply zoom by a factor (centered on current view). */
  zoomBy(factor: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    this.clampOffset();
    this.dirty = true;
    this.frameDirty = true;
  }

  /** Set absolute zoom level. */
  zoomTo(level: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level));
    this.clampOffset();
    this.dirty = true;
    this.frameDirty = true;
  }

  /**
   * Zoom by a factor while keeping a screen point fixed in world space.
   * Used for wheel-zoom: the world position under the cursor stays put.
   */
  zoomAtScreen(factor: number, screenX: number, screenY: number): void {
    const worldBefore = this.screenToWorld(screenX, screenY);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    const worldAfter = this.screenToWorld(screenX, screenY);
    this.offsetX += worldBefore.x - worldAfter.x;
    this.offsetY += worldBefore.y - worldAfter.y;
    this.clampOffset();
    this.dirty = true;
    this.frameDirty = true;
  }

  /**
   * Set the view mode's projection (camera/MapViewSource.ts viewPose): the
   * mode, its tilt and field of view, and the isometric camera's orbit.
   */
  setProjection(view: MapViewParams, orbit: CameraOrbit): void {
    const v = this.view;
    if (
      view.mode === v.mode &&
      view.tiltDeg === v.tiltDeg &&
      view.fovDeg === v.fovDeg &&
      orbit.yawDeg === this.orbit.yawDeg &&
      orbit.elevationDeg === this.orbit.elevationDeg
    ) {
      return;
    }
    v.mode = view.mode;
    v.tiltDeg = view.tiltDeg;
    v.fovDeg = view.fovDeg;
    this.orbit = { yawDeg: orbit.yawDeg, elevationDeg: orbit.elevationDeg };
    this.frameDirty = true;
  }

  /** The 3D camera frame shaders draw with (see camera/CameraMath.ts). */
  getFrame(): CameraFrame {
    if (this.frameDirty) {
      computeCameraFrame(
        viewPose(
          this.view,
          this.orbit,
          this.offsetX,
          this.offsetY,
          this.zoom,
          this.canvasW,
          this.canvasH,
        ),
        this.frame,
      );
      this.frameDirty = false;
    }
    return this.frame;
  }

  /** Return the column-major mat3 camera matrix (world → clip). */
  getMatrix(): Float32Array {
    if (this.dirty) {
      const sx = (this.zoom * 2) / this.canvasW;
      const sy = (this.zoom * -2) / this.canvasH; // Y flip
      const tx = -this.offsetX * sx;
      const ty = -this.offsetY * sy;
      const m = this.mat;
      m[0] = sx;
      m[1] = 0;
      m[2] = 0;
      m[3] = 0;
      m[4] = sy;
      m[5] = 0;
      m[6] = tx;
      m[7] = ty;
      m[8] = 1;
      this.dirty = false;
    }
    return this.mat;
  }

  /** Convert screen pixel position to world coordinates. */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const dpr = renderDpr();
    const ndcX = ((screenX * dpr) / this.canvasW) * 2 - 1;
    const ndcY = -(((screenY * dpr) / this.canvasH) * 2 - 1);
    const sx = (this.zoom * 2) / this.canvasW;
    const sy = (this.zoom * -2) / this.canvasH;
    return {
      x: (ndcX - -this.offsetX * sx) / sx,
      y: (ndcY - -this.offsetY * sy) / sy,
    };
  }

  /** Convert world coordinates to screen pixel position (CSS pixels). */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const dpr = renderDpr();
    return {
      x: (this.zoom * (worldX - this.offsetX)) / dpr + this.canvasW / (2 * dpr),
      y: (this.zoom * (worldY - this.offsetY)) / dpr + this.canvasH / (2 * dpr),
    };
  }

  private clampOffset(): void {
    const halfVpW = this.canvasW / (2 * this.zoom);
    const halfVpH = this.canvasH / (2 * this.zoom);
    this.offsetX = Math.max(
      -halfVpW,
      Math.min(this.mapW + halfVpW, this.offsetX),
    );
    this.offsetY = Math.max(
      -halfVpH,
      Math.min(this.mapH + halfVpH, this.offsetY),
    );
  }
}
