import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  CITY_STATE_CONQUEST_GOLD,
  RUIN_GOLD_REWARD,
  RuinReward,
  ruinTroopReward,
} from "@openfront/engine-lib/game/WorldFeatures";
import { DefensePostExecution } from "../execution/DefensePostExecution";
import { Game, Player } from "./Game";

/**
 * World feature rules that run inside the game (numbers and the overview in
 * engine-lib/game/WorldFeatures.ts). Ruins and city-state flags live on the
 * game and its players, so nothing here needs a snapshot.
 */

/**
 * Gives `claimer` what the ruin on `tile` held. GameImpl.conquer calls it the
 * moment `claimer` takes the tile from unclaimed land, after removing the
 * ruin.
 */
export function claimRuin(
  game: Game,
  claimer: Player,
  tile: TileRef,
  reward: RuinReward,
): void {
  if (reward === RuinReward.Troops) {
    const troops = ruinTroopReward(
      claimer.troops(),
      game.config().maxTroops(claimer),
    );
    claimer.addTroops(troops);
    game.addUpdate({
      type: GameUpdateType.BonusEvent,
      player: claimer.id(),
      tile,
      gold: 0,
      troops,
    });
    ruinMessage(game, claimer, "events_display.ruins_found_troops", {
      troops: renderTroops(troops),
    });
    return;
  }
  if (
    reward === RuinReward.DefensePost &&
    canGrantDefensePost(game, claimer, tile)
  ) {
    const post = claimer.grantUnit(UnitType.DefensePost, tile, {});
    game.addExecution(new DefensePostExecution(post));
    ruinMessage(game, claimer, "events_display.ruins_found_defense_post");
    return;
  }
  // A gold burst, and the fallback for a defense post that can't go here.
  const gold = BigInt(RUIN_GOLD_REWARD);
  claimer.addGold(gold, tile);
  ruinMessage(game, claimer, "events_display.ruins_found_gold", {
    gold: renderNumber(gold),
  });
}

/**
 * Whether a structure may legally stand on `tile` for `player`: the defense
 * post isn't disabled, `player` owns the tile, and no structure (finished or
 * not) is closer than the minimum structure spacing. The same spacing rule
 * as building one, for this exact tile and without the price.
 */
export function canGrantDefensePost(
  game: Game,
  player: Player,
  tile: TileRef,
): boolean {
  if (game.config().isUnitDisabled(UnitType.DefensePost)) return false;
  if (
    game.owner(tile) !== player ||
    !game.isLand(tile) ||
    game.isImpassable(tile)
  ) {
    return false;
  }
  const minDist = game.config().structureMinDist();
  const minDistSquared = minDist * minDist;
  return !game
    .nearbyUnits(tile, minDist, Structures.types, undefined, true)
    .some(
      ({ unit }) =>
        game.euclideanDistSquared(unit.tile(), tile) < minDistSquared,
    );
}

function ruinMessage(
  game: Game,
  claimer: Player,
  key: string,
  params?: Record<string, string>,
): void {
  game.displayMessage(
    key,
    MessageType.CONQUERED_PLAYER,
    claimer.id(),
    undefined,
    params,
  );
}

/**
 * Pays the city-state bounty to whoever eliminates `cityState`, on top of
 * the normal conquest gold. GameImpl.conquerPlayer calls it; it pays once
 * however often the conquest is recorded.
 */
export function payCityStateBounty(
  game: Game,
  conqueror: Player,
  cityState: Player,
): void {
  if (conqueror === cityState || !cityState.takeCityStateBounty()) return;
  const gold = BigInt(CITY_STATE_CONQUEST_GOLD);
  conqueror.addGold(gold);
  game.stats().goldWar(conqueror, cityState, gold);
  game.displayMessage(
    "events_display.city_state_conquered",
    MessageType.CONQUERED_PLAYER,
    conqueror.id(),
    gold,
    { name: cityState.displayName(), gold: renderNumber(gold) },
    undefined,
    cityState.id(),
  );
}
