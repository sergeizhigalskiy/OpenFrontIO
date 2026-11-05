import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { resourceSiteHolderID } from "@openfront/engine-lib/game/ResourceSites";
import { Game, Player } from "../../game/Game";
import { resourceSitesOf } from "../ResourceSiteExecution";

/**
 * Nations value targets holding resource sites (engine-lib/game/
 * ResourceSites.ts) a bit more: when they rank their enemies by troops,
 * weakest first, a target counts as weaker by MINE_TARGET_DISCOUNT_PERCENT
 * per site it holds (up to MINE_TARGET_MAX_SITES sites, any kind, held as
 * resourceSiteHolderID says), scaled by difficulty. Easy nations don't care. With no sites this is exactly the
 * troop count, so games without resource sites rank as before.
 */

/** Percent off a target's troops per site it holds, by difficulty. */
export const MINE_TARGET_DISCOUNT_PERCENT: Readonly<
  Record<Difficulty, number>
> = {
  [Difficulty.Easy]: 0,
  [Difficulty.Medium]: 5,
  [Difficulty.Hard]: 10,
  [Difficulty.Impossible]: 15,
};
/** Sites counted per target, at most. */
export const MINE_TARGET_MAX_SITES = 3;

/** The troop count nations rank `target` by. */
export function mineWeightedTroops(game: Game, target: Player): number {
  const troops = target.troops();
  const sites = resourceSitesOf(game);
  if (sites.length === 0) return troops;
  const discount =
    MINE_TARGET_DISCOUNT_PERCENT[game.config().gameConfig().difficulty];
  if (discount === 0) return troops;
  const smallID = target.smallID();
  const map = game.map();
  let held = 0;
  for (const s of sites) {
    if (resourceSiteHolderID(map, s) === smallID) held++;
  }
  if (held === 0) return troops;
  held = Math.min(held, MINE_TARGET_MAX_SITES);
  return (troops * (100 - discount * held)) / 100;
}
