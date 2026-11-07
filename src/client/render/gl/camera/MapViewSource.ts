/**
 * MapViewSource — what screen-to-tile picking needs to know about the view:
 * the live view mode, the isometric view's turn and, in the 3D modes, the
 * terrain height under a point. MapRenderer provides one; TransformHandler
 * consumes it.
 *
 * viewPose() is the one place a view mode becomes a camera pose. The
 * renderer and the picking code both call it, so what is drawn and what is
 * clicked come from the same projection in every mode and rotation.
 */

import type { MapViewMode } from "../GraphicsOverrides";
import {
  computeCameraFrame,
  intersectRayPlane,
  ndcToRay,
  pixelToNdc,
  type CameraPose,
  type Ray,
} from "./CameraMath";

/** The view settings a camera pose depends on (the mapView slice). */
export interface MapViewParams {
  mode: MapViewMode;
  /** Tilt from straight down, degrees (tilt and terrain3d). */
  tiltDeg: number;
  /** Vertical field of view, degrees (tilt and terrain3d). */
  fovDeg: number;
  /** Isometric camera elevation above the ground, degrees. */
  isoElevationDeg: number;
}

export interface MapViewSource {
  /** Live view settings (the renderer's mapView slice). */
  view(): MapViewParams;
  /**
   * The isometric view's current turn: compass azimuth of the ground
   * direction pointing up the screen, degrees (315 + 90·k at rest, in
   * between while a rotation animates). Ignored by the other modes.
   */
  yawDeg(): number;
  /** Terrain height in world tiles at (x, y); 0 when the ground is flat. */
  heightAt(x: number, y: number): number;
  /** Upper bound of heightAt anywhere on the map (0 when flat). */
  maxHeight(): number;
}

/** Modes drawn over the 3D height mesh (heights, upright labels). */
export function hasRelief(mode: MapViewMode): boolean {
  return mode === "terrain3d" || mode === "isometric";
}

/**
 * The camera pose for a view mode: flat top-down, the tilted perspective
 * camera (tilt, terrain3d), or the turned orthographic isometric camera.
 */
export function viewPose(
  view: MapViewParams,
  yawDeg: number,
  centerX: number,
  centerY: number,
  zoom: number,
  viewW: number,
  viewH: number,
): CameraPose {
  const pose: CameraPose = {
    centerX,
    centerY,
    zoom,
    viewW,
    viewH,
    tiltDeg: 0,
    fovDeg: view.fovDeg,
  };
  if (view.mode === "isometric") {
    pose.tiltDeg = 90 - view.isoElevationDeg;
    pose.yawDeg = yawDeg;
    pose.orthographic = true;
  } else if (view.mode !== "flat") {
    pose.tiltDeg = view.tiltDeg;
  }
  return pose;
}

/**
 * Where a view ray meets the ground: the flat plane z = 0, or the terrain
 * surface when `terrain` reports relief (raycastHeightfield).
 */
export function pickGround(
  ray: Ray,
  terrain: Pick<MapViewSource, "heightAt" | "maxHeight"> | null,
): { x: number; y: number } | null {
  const maxHeight = terrain?.maxHeight() ?? 0;
  if (terrain === null || maxHeight <= 0) {
    const hit = intersectRayPlane(ray, 0);
    return hit === null ? null : { x: hit.x, y: hit.y };
  }
  const hit = raycastHeightfield(
    ray,
    (x, y) => terrain.heightAt(x, y),
    maxHeight,
  );
  return hit === null ? null : { x: hit.x, y: hit.y };
}

/** Horizontal march step, tiles. Fine enough for the smoothed relief. */
const MARCH_STEP = 0.25;
const BISECT_STEPS = 12;

/**
 * First point where a downward ray meets the surface z = heightAt(x, y),
 * which lies in [0, maxHeight]. Marches from where the ray enters the slab
 * below maxHeight, then bisects the crossing. The ray always meets the
 * surface by the time it reaches z = 0, so a downward ray always hits.
 */
export function raycastHeightfield(
  ray: Ray,
  heightAt: (x: number, y: number) => number,
  maxHeight: number,
  step = MARCH_STEP,
): { x: number; y: number; t: number } | null {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  if (dz >= 0) return null;
  const tTop = Math.max(0, (maxHeight - oz) / dz);
  const tBottom = (0 - oz) / dz;
  if (tBottom < 0) return null;
  const above = (t: number) => oz + dz * t - heightAt(ox + dx * t, oy + dy * t);
  const horiz = Math.hypot(dx, dy);
  const dt = horiz > 1e-9 ? step / horiz : tBottom - tTop;
  let t0 = tTop;
  if (above(t0) <= 0) return point(ray, t0);
  for (;;) {
    const t1 = Math.min(tBottom, t0 + dt);
    if (above(t1) <= 0) {
      // Bisect the crossing in [t0, t1].
      let lo = t0;
      let hi = t1;
      for (let i = 0; i < BISECT_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (above(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return point(ray, hi);
    }
    if (t1 >= tBottom) return point(ray, tBottom);
    t0 = t1;
  }
}

function point(ray: Ray, t: number): { x: number; y: number; t: number } {
  return {
    x: ray.origin[0] + ray.dir[0] * t,
    y: ray.origin[1] + ray.dir[1] * t,
    t,
  };
}

/**
 * Pick the ground under a pixel for a camera given by its focus and zoom
 * (pixels per tile), when the view is tilted or turned. Null in flat mode,
 * so callers keep their own 2D math there.
 */
export function pickTilted(
  source: MapViewSource,
  camera: { x: number; y: number; zoom: number },
  px: number,
  py: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } | null {
  const view = source.view();
  if (view.mode === "flat") return null;
  const frame = computeCameraFrame(
    viewPose(
      view,
      source.yawDeg(),
      camera.x,
      camera.y,
      camera.zoom,
      viewW,
      viewH,
    ),
  );
  const [nx, ny] = pixelToNdc(frame, px, py);
  return pickGround(
    ndcToRay(frame, nx, ny),
    hasRelief(view.mode) ? source : null,
  );
}
