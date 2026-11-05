import { TileRef } from "@openfront/engine-api/game/GameMap";
import { canalPlanFor, findCanalPath } from "@openfront/engine-lib/game/Canal";
import type { CanalMarker } from "../../render/gl/passes/CanalPass";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * The canal's build-menu helpers (rules in engine-lib/game/Canal.ts): why it
 * can't be dug on a tile, and the ghost path drawn under the cursor.
 */

/** Why the local player can't dig a canal through `tile`, or null. */
export function canalBlockedText(game: GameView, tile: TileRef): string | null {
  const me = game.myPlayer();
  if (me === null || !game.isValidRef(tile)) return null;
  const plan = canalPlanFor(game, me, tile);
  return plan.ok ? null : translateText(`canal.${plan.reason}`);
}

/** Colors for a ghost path the player can and can't dig. */
const GHOST_OK = { r: 0.3, g: 0.9, b: 0.4 };
const GHOST_BLOCKED = { r: 0.95, g: 0.25, b: 0.2 };

/**
 * The canal through `tile` as a ghost to draw, green when the engine says
 * the local player can dig it now (`canBuild`, from its buildables answer)
 * and red when not, or null when the tile is no neck at all.
 */
export function canalGhostMarker(
  game: GameView,
  tile: TileRef,
  canBuild: boolean,
): CanalMarker | null {
  if (!game.isValidRef(tile)) return null;
  const found = findCanalPath(game, tile);
  if (!found.ok) return null;
  const { path } = found;
  const sx = game.x(path.start);
  const sy = game.y(path.start);
  const ex = game.x(path.end);
  const ey = game.y(path.end);
  const xMajor = Math.abs(ex - sx) >= Math.abs(ey - sy);
  const c = canBuild ? GHOST_OK : GHOST_BLOCKED;
  return {
    startX: sx,
    startY: sy,
    endX: ex,
    endY: ey,
    offsetX: xMajor ? 0 : 1,
    offsetY: xMajor ? 1 : 0,
    ...c,
    progress: 0,
  };
}
