import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import { canalPlan, canalPrice } from "../../game/Canal";
import { Game, Player } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";

/**
 * Hard and Impossible nations dig a canal (engine-lib/game/Canal.ts) across
 * a neck of their own land, which joins two of their own coasts, once they
 * can easily afford it. Easier nations never do. Stateless and draws nothing
 * from the PRNG, so it needs no snapshot: once a minute (staggered by
 * player) the nation tries a fixed sample of its shore tiles, and the
 * shortest canal among them wins.
 */

/** A nation digs only while it holds this many times the canal's price. */
export const NATION_CANAL_AFFORD_MULTIPLE = 3n;
/** Canals one nation digs in a game, at most. */
export const NATION_CANAL_MAX = 2;
/** Border tiles looked at per search (the shore ones among them are tried). */
export const NATION_CANAL_SAMPLES = 64;
/** A nation searches during the first CHECK_WINDOW ticks of every period. */
export const NATION_CANAL_CHECK_TICKS = 600;
/** Hard and Impossible attack ticks come at most this far apart. */
const NATION_CANAL_CHECK_WINDOW = 60;

/** Whether `player`'s once-a-minute canal search window is open now. */
export function canalSearchDue(game: Game, player: Player): boolean {
  const phase =
    (game.ticks() + player.smallID() * 101) % NATION_CANAL_CHECK_TICKS;
  return phase < NATION_CANAL_CHECK_WINDOW;
}

/** Called on the nation's attack ticks. */
export function considerCanal(game: Game, player: Player): void {
  const { difficulty } = game.config().gameConfig();
  if (difficulty !== Difficulty.Hard && difficulty !== Difficulty.Impossible) {
    return;
  }
  if (game.config().isUnitDisabled(UnitType.Canal) || !player.isAlive()) {
    return;
  }
  if (!canalSearchDue(game, player)) return;
  // One dig at a time, and only a couple per game.
  if (player.units(UnitType.Canal).length > 0) return;
  if (player.unitsConstructed(UnitType.Canal) >= NATION_CANAL_MAX) return;
  // Even the shortest canal must be easily affordable before searching.
  if (
    player.gold() <
    canalPrice(game, player, 1) * NATION_CANAL_AFFORD_MULTIPLE
  ) {
    return;
  }

  // Every stride-th border tile that is shore, in the set's (deterministic)
  // order, starting at an offset that moves each search.
  const border = player.borderTiles();
  const stride = Math.max(1, Math.floor(border.size / NATION_CANAL_SAMPLES));
  const offset = Math.floor(game.ticks() / NATION_CANAL_CHECK_TICKS) % stride;
  const shore: TileRef[] = [];
  let i = 0;
  border.forEach((t) => {
    if (shore.length >= NATION_CANAL_SAMPLES) return;
    if (i++ % stride === offset && game.isShore(t)) shore.push(t);
  });

  let best: { tile: TileRef; length: number } | null = null;
  for (const tile of shore) {
    const plan = canalPlan(game, player, tile);
    if (!plan.ok) continue;
    if (best === null || plan.path.length < best.length) {
      best = { tile, length: plan.path.length };
    }
  }
  if (best === null) return;
  const price = canalPrice(game, player, best.length);
  if (player.gold() < price * NATION_CANAL_AFFORD_MULTIPLE) return;
  game.addExecution(
    new ConstructionExecution(player, UnitType.Canal, best.tile),
  );
}
