/**
 * ViewOrbit — the isometric camera's free orbit: its yaw (turn about the
 * vertical, any angle) and its elevation (tilt, from a low oblique angle to
 * nearly top-down), plus the short eased animation of a reset. Pure state,
 * no GL or DOM.
 *
 * The yaw is the compass azimuth of the ground direction pointing up the
 * screen. The default view is classic 2:1 isometric: yaw ISO_BASE_YAW_DEG
 * (north-west up, so the map's top-left corner, tile 0,0, is the top of the
 * diamond and north points up and to the right) at the default elevation
 * (mapView.isoElevationDeg). orbit() turns the camera by a delta: positive
 * yaw turns it to its left (the map turns counter-clockwise on screen),
 * positive elevation raises it toward top-down.
 *
 * MapRenderer owns one. The renderer reads it when it builds the frame's
 * camera and TransformHandler reads it (through MapViewSource) when it
 * picks, so a click mid-orbit still lands on the tile drawn under it.
 */

/** Yaw of the default view: north-west points up the screen. */
export const ISO_BASE_YAW_DEG = 315;
/** Elevation of the default view: 2:1 dimetric. */
export const DEFAULT_ELEVATION_DEG = 30;
/** Lowest camera elevation: a low oblique view across the land. */
export const MIN_ELEVATION_DEG = 20;
/** Highest camera elevation: nearly straight down. */
export const MAX_ELEVATION_DEG = 85;
/** How long a reset to the default view animates, ms. */
export const RESET_DURATION_MS = 380;

/** The orbit a camera pose takes (camera/MapViewSource.ts viewPose). */
export interface CameraOrbit {
  /** Compass azimuth pointing up the screen, degrees. */
  yawDeg: number;
  /** Camera elevation above the ground, degrees. */
  elevationDeg: number;
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function clampElevation(deg: number): number {
  return Math.min(MAX_ELEVATION_DEG, Math.max(MIN_ELEVATION_DEG, deg));
}

export class ViewOrbit {
  private yaw = ISO_BASE_YAW_DEG;
  private elevation: number;
  /** A reset in progress: from, to and start time; null when idle. */
  private anim: {
    fromYaw: number;
    toYaw: number;
    fromElevation: number;
    toElevation: number;
    startMs: number;
  } | null = null;

  constructor(
    private defaultElevation = DEFAULT_ELEVATION_DEG,
    private readonly durationMs = RESET_DURATION_MS,
  ) {
    this.elevation = clampElevation(defaultElevation);
  }

  /** The elevation reset() returns to (mapView.isoElevationDeg). */
  setDefaultElevation(deg: number): void {
    this.defaultElevation = deg;
  }

  /**
   * Turn the camera by `yawDeg` (positive: the camera turns left, the map
   * counter-clockwise on screen) and tilt it by `elevationDeg` (positive:
   * toward top-down), clamped to the elevation limits. Interrupts a reset.
   */
  orbit(yawDeg: number, elevationDeg: number): void {
    this.anim = null;
    this.yaw = wrap360(this.yaw + yawDeg);
    this.elevation = clampElevation(this.elevation + elevationDeg);
  }

  /** Set the view outright (no animation). */
  set(yawDeg: number, elevationDeg: number): void {
    this.anim = null;
    this.yaw = wrap360(yawDeg);
    this.elevation = clampElevation(elevationDeg);
  }

  /** Ease back to the default view, the short way round. */
  reset(nowMs: number): void {
    this.update(nowMs);
    // Shortest turn: a delta in (-180, 180].
    let d = wrap360(ISO_BASE_YAW_DEG - this.yaw);
    if (d > 180) d -= 360;
    this.anim = {
      fromYaw: this.yaw,
      toYaw: this.yaw + d,
      fromElevation: this.elevation,
      toElevation: clampElevation(this.defaultElevation),
      startMs: nowMs,
    };
  }

  /** Advance a reset to `nowMs`. */
  update(nowMs: number): void {
    const a = this.anim;
    if (a === null) return;
    const t =
      this.durationMs > 0
        ? Math.min(1, Math.max(0, (nowMs - a.startMs) / this.durationMs))
        : 1;
    if (t >= 1) {
      this.yaw = wrap360(a.toYaw);
      this.elevation = a.toElevation;
      this.anim = null;
      return;
    }
    // Smootherstep: starts and stops gently.
    const e = t * t * t * (t * (t * 6 - 15) + 10);
    this.yaw = wrap360(a.fromYaw + (a.toYaw - a.fromYaw) * e);
    this.elevation = a.fromElevation + (a.toElevation - a.fromElevation) * e;
  }

  /** The current yaw (as of the last update), degrees [0, 360). */
  yawDeg(): number {
    return this.yaw;
  }

  /** The current elevation above the ground, degrees. */
  elevationDeg(): number {
    return this.elevation;
  }

  /** The current orbit, for a camera pose. */
  current(): CameraOrbit {
    return { yawDeg: this.yaw, elevationDeg: this.elevation };
  }

  /** True while a reset is still animating. */
  animating(): boolean {
    return this.anim !== null;
  }
}
