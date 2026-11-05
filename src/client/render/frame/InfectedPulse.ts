import type { Colord } from "colord";

/**
 * The plague's Infected territory breathes: its sickly green fill brightens
 * and dims over this period. Render-only, from wall-clock time.
 */
export const INFECTED_PULSE_PERIOD_MS = 2_400;
/** How far the fill lightens and darkens at the peaks (colord amount). */
export const INFECTED_PULSE_AMPLITUDE = 0.06;

/** The Infected's fill at `nowMs`: `base` lightened or darkened a little. */
export function infectedPulseColor(base: Colord, nowMs: number): Colord {
  const phase = Math.sin((2 * Math.PI * nowMs) / INFECTED_PULSE_PERIOD_MS);
  return phase >= 0
    ? base.lighten(phase * INFECTED_PULSE_AMPLITUDE)
    : base.darken(-phase * INFECTED_PULSE_AMPLITUDE);
}
