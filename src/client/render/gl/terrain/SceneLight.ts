/**
 * SceneLight — where the sun is for the current view. Pure functions, no GL.
 *
 * The sun always shines from the top-left of the screen, the direction the
 * eye assumes light comes from: lit from below, mountains read as valleys.
 * So in the isometric view the sun turns with the camera (its azimuth is the
 * view's yaw less 45 degrees); in the other views it stays at the configured
 * mapView.lightAzimuthDeg (north-west by default, the top-left there too).
 *
 * The relief bake (ReliefBake.ts) casts shadows toward the four isometric
 * azimuths (ISO_SUN_AZIMUTHS, one per rotation, into the RGBA of its shadow
 * texture) plus the other views' azimuth; shadowWeights() blends the right
 * channels, two of them while a rotation animates.
 */

import { ISO_BASE_YAW_DEG } from "../camera/ViewRotation";
import type { MapViewMode } from "../GraphicsOverrides";

/** Sun azimuth for isometric rotation k (0-3): the top-left of the screen. */
export const ISO_SUN_AZIMUTHS = [0, 1, 2, 3].map(
  (k) => (((ISO_BASE_YAW_DEG - 45 + 90 * k) % 360) + 360) % 360,
) as [number, number, number, number];

/** Sun azimuth, degrees: the top-left of the screen for this view. */
export function sunAzimuthDeg(
  mode: MapViewMode,
  yawDeg: number,
  flatAzimuthDeg: number,
): number {
  if (mode !== "isometric") return flatAzimuthDeg;
  return (((yawDeg - 45) % 360) + 360) % 360;
}

export interface ShadowWeights {
  /** Weights of the shadow texture's RGBA (the isometric azimuths). */
  iso: [number, number, number, number];
  /** Weight of the other views' shadow channel. */
  flat: number;
}

/**
 * How to blend the baked shadow channels for a sun azimuth: the flat
 * channel outside the isometric view, else the two isometric azimuths
 * either side of it.
 */
export function shadowWeights(
  mode: MapViewMode,
  sunAzDeg: number,
): ShadowWeights {
  if (mode !== "isometric") return { iso: [0, 0, 0, 0], flat: 1 };
  const u = ((((sunAzDeg - ISO_SUN_AZIMUTHS[0]) % 360) + 360) % 360) / 90;
  const k0 = Math.floor(u) % 4;
  const f = u - Math.floor(u);
  const iso: [number, number, number, number] = [0, 0, 0, 0];
  iso[k0] += 1 - f;
  iso[(k0 + 1) % 4] += f;
  return { iso, flat: 0 };
}
