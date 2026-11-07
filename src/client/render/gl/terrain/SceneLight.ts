/**
 * SceneLight — where the sun is for the current view. Pure functions, no GL.
 *
 * The sun always shines from the top-left of the screen, the direction the
 * eye assumes light comes from: lit from below, mountains read as valleys.
 * So in the isometric view the sun turns with the orbiting camera (its
 * azimuth is the view's yaw less 45 degrees); in the other views it stays
 * at the configured mapView.lightAzimuthDeg (north-west by default, the
 * top-left there too).
 *
 * The relief bake (ReliefBake.ts) casts shadows toward eight sun azimuths,
 * every 45 degrees (SHADOW_AZIMUTHS: the RGBA of its two shadow textures);
 * shadowWeights() blends the two either side of the sun, so any orbit angle
 * reads a shadow at most 22.5 degrees off, and the default view's sun is
 * one of them exactly.
 */

import { ISO_BASE_YAW_DEG } from "../camera/ViewOrbit";
import type { MapViewMode } from "../GraphicsOverrides";

/** The baked sun azimuths, degrees: texture A's RGBA, then texture B's. */
export const SHADOW_AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/** The default isometric view's sun azimuth: the top-left of the screen. */
export const ISO_DEFAULT_SUN_DEG =
  (((ISO_BASE_YAW_DEG - 45) % 360) + 360) % 360;

/** Sun azimuth, degrees: the top-left of the screen for this view. */
export function sunAzimuthDeg(
  mode: MapViewMode,
  yawDeg: number,
  flatAzimuthDeg: number,
): number {
  if (mode !== "isometric") return flatAzimuthDeg;
  return (((yawDeg - 45) % 360) + 360) % 360;
}

export type Vec4 = [number, number, number, number];

export interface ShadowWeights {
  /** Weights of shadow texture A (azimuths 0, 45, 90, 135). */
  a: Vec4;
  /** Weights of shadow texture B (azimuths 180, 225, 270, 315). */
  b: Vec4;
}

/** How to blend the baked shadows for a sun azimuth (degrees). */
export function shadowWeights(sunAzDeg: number): ShadowWeights {
  const u = (((sunAzDeg % 360) + 360) % 360) / 45;
  const k0 = Math.floor(u) % 8;
  const k1 = (k0 + 1) % 8;
  const f = u - Math.floor(u);
  const w = [0, 0, 0, 0, 0, 0, 0, 0];
  w[k0] += 1 - f;
  w[k1] += f;
  return { a: [w[0], w[1], w[2], w[3]], b: [w[4], w[5], w[6], w[7]] };
}
