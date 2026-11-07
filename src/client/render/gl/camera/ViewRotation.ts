/**
 * ViewRotation — the isometric view's quarter turns, and the short eased
 * animation between them. Pure state, no GL or DOM.
 *
 * The yaw is the compass azimuth of the ground direction pointing up the
 * screen. At rest it is ISO_BASE_YAW_DEG + 90·k: the map stands turned 45
 * degrees, so tiles read as diamonds. The first rotation puts north-west up,
 * so the map's top-left corner (tile 0, 0) is the top of the diamond and
 * north points up and to the right, the classic isometric layout. rotate(+1) turns the camera a quarter
 * turn to its left around the screen centre, so the map turns
 * counter-clockwise on screen; rotate(-1) the other way.
 *
 * MapRenderer owns one. The renderer reads yawDeg() when it builds the
 * frame's camera and TransformHandler reads it (through MapViewSource) when
 * it picks, so a click mid-animation still lands on the tile drawn under it.
 */

/** Yaw of the first resting rotation: north-west points up the screen. */
export const ISO_BASE_YAW_DEG = 315;
/** How long a quarter turn animates, ms. */
export const ROTATE_DURATION_MS = 320;

export class ViewRotation {
  /** Resting quarter turns, unwrapped (any integer). */
  private quarter = 0;
  private fromYaw = ISO_BASE_YAW_DEG;
  private toYaw = ISO_BASE_YAW_DEG;
  private startMs = 0;
  private yaw = ISO_BASE_YAW_DEG;

  constructor(private readonly durationMs = ROTATE_DURATION_MS) {}

  /** The resting rotation being turned to, 0-3. */
  quarterTurns(): number {
    return ((this.quarter % 4) + 4) % 4;
  }

  /**
   * Start a quarter turn: +1 turns the camera left (map counter-clockwise),
   * -1 right. Chained presses add up; the animation restarts from wherever
   * the view is now.
   */
  rotate(direction: 1 | -1, nowMs: number): void {
    this.update(nowMs);
    this.fromYaw = this.yaw;
    this.quarter += direction;
    this.toYaw = ISO_BASE_YAW_DEG + 90 * this.quarter;
    this.startMs = nowMs;
  }

  /** Jump straight to a resting rotation (0-3), no animation. */
  set(quarterTurns: number): void {
    this.quarter = quarterTurns;
    this.toYaw = ISO_BASE_YAW_DEG + 90 * quarterTurns;
    this.fromYaw = this.toYaw;
    this.yaw = this.toYaw;
  }

  /** Advance the animation to `nowMs`; returns the yaw, degrees [0, 360). */
  update(nowMs: number): number {
    if (this.yaw !== this.toYaw) {
      const t =
        this.durationMs > 0
          ? Math.min(1, Math.max(0, (nowMs - this.startMs) / this.durationMs))
          : 1;
      // Smootherstep: starts and stops gently.
      const e = t * t * t * (t * (t * 6 - 15) + 10);
      this.yaw =
        t >= 1 ? this.toYaw : this.fromYaw + (this.toYaw - this.fromYaw) * e;
    }
    return this.yawDeg();
  }

  /** The current yaw (as of the last update), degrees [0, 360). */
  yawDeg(): number {
    return ((this.yaw % 360) + 360) % 360;
  }

  /** True while a turn is still animating at `nowMs`. */
  animating(nowMs: number): boolean {
    return this.yaw !== this.toYaw && nowMs - this.startMs < this.durationMs;
  }
}
