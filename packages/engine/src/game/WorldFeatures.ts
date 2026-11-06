import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  ruinGoldReward,
  RuinReward,
  ruinTroopReward,
} from "@openfront/engine-lib/game/WorldFeatures";
import { Game, Player } from "./Game";

/**
 * World feature rules that run inside the game (numbers and the overview in
 * engine-lib/game/WorldFeatures.ts). Ruins and city-state flags live on the
 * game and its players, so nothing here needs a snapshot.
 */

/**
 * Gives `claimer` what the ruin on `tile` held. GameImpl.conquer calls it the
 * moment a human or nation takes the tile (claimsRuins), after removing the
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
  // A gold burst: a minute of the claimer's base income.
  const gold = ruinGoldReward(game.config().goldAdditionRate(claimer));
  claimer.addGold(gold, tile);
  ruinMessage(game, claimer, "events_display.ruins_found_gold", {
    gold: renderNumber(gold),
  });
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
 * the normal conquest gold (none: a city-state earns no gold).
 * GameImpl.conquerPlayer calls it; it pays once however often the conquest
 * is recorded.
 */
export function payCityStateBounty(
  game: Game,
  conqueror: Player,
  cityState: Player,
): void {
  if (conqueror === cityState || !cityState.takeCityStateBounty()) return;
  const gold = game.config().cityStateBountyGold(conqueror);
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
