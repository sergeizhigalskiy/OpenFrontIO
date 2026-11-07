/**
 * The zoom cull for name plates (name, troops, flag, status icons).
 *
 * A plate whose line height on screen falls under the cull threshold is
 * hidden, so a zoomed-out map isn't buried in unreadable labels. Some
 * players must stay findable at any zoom instead:
 *   - a targeted player, boosted to the threshold (the smallest size that
 *     survives it)
 *   - a small player (SmallPlayerGlowPass's set), boosted to
 *     SMALL_LABEL_SIZE times the threshold, so the name and troop count of
 *     a remnant you're hunting read from across the map
 * A hovered plate is never culled.
 *
 * The shaders (shaders/name/name.vert.glsl, icon.vert.glsl,
 * status-icon.vert.glsl) do this per vertex with SMALL_LABEL_SIZE injected
 * as a define; NamePass.hitTestNamePlate uses this function so its bounds
 * match what is drawn.
 */

/** A small player's plate never shows smaller than this × the cull size. */
export const SMALL_LABEL_SIZE = 1.8;

export interface NameplateFlags {
  target: boolean;
  small: boolean;
  highlighted: boolean;
}

/**
 * Whether a plate whose line is `screenSize` clip units tall shows against
 * `cullThreshold`, and the factor its size is multiplied by.
 */
export function nameplateCull(
  screenSize: number,
  cullThreshold: number,
  flags: NameplateFlags,
): { visible: boolean; boost: number } {
  const floor = flags.small
    ? cullThreshold * SMALL_LABEL_SIZE
    : flags.target
      ? cullThreshold
      : 0;
  if (floor > 0 && screenSize < floor) {
    return { visible: true, boost: floor / Math.max(screenSize, 1e-9) };
  }
  return {
    visible: screenSize >= cullThreshold || flags.highlighted,
    boost: 1,
  };
}
