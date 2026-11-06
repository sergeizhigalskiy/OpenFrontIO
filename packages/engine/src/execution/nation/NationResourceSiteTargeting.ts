import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { resourceSiteHolderID } from "@openfront/engine-lib/game/ResourceSites";
import { Game, Player } from "../../game/Game";
import { resourceSitesOf } from "../ResourceSiteExecution";

/**
 * Nations value targets holding resource sites (engine-lib/game/
 * ResourceSites.ts) a bit more: when they rank their enemies, cheapest
 * first, a target counts as cheaper by MINE_TARGET_DISCOUNT_PERCENT per site
 * it holds (up to MINE_TARGET_MAX_SITES sites, any kind, held as
 * resourceSiteHolderID says), scaled by the ranking nation's difficulty.
 * Easy nations don't care. With no sites the factor is 1, so games without
 * resource sites rank as before.
 */

/** Percent off a target's rank per site it holds, by difficulty. */
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

/** The percent of `target`'s rank `player` keeps for the sites it holds (100 for none). */
function minePercent(game: Game, player: Player, target: Player): number {
  const sites = resourceSitesOf(game);
  if (sites.length === 0) return 100;
  const discount =
    MINE_TARGET_DISCOUNT_PERCENT[game.config().difficultyFor(player)];
  if (discount === 0) return 100;
  const smallID = target.smallID();
  const map = game.map();
  let held = 0;
  for (const s of sites) {
    if (resourceSiteHolderID(map, s) === smallID) held++;
  }
  held = Math.min(held, MINE_TARGET_MAX_SITES);
  return 100 - discount * held;
}

/** The troop count `player` ranks `target` by: its troops, discounted for its sites. */
export function mineWeightedTroops(
  game: Game,
  player: Player,
  target: Player,
): number {
  const troops = target.troops();
  const percent = minePercent(game, player, target);
  return percent === 100 ? troops : (troops * percent) / 100;
}
