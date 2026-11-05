import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  CAPITAL_GOLD_LOSS_PERCENT,
  CAPITAL_PENALTY_COOLDOWN_TICKS,
  CAPITAL_TROOP_LOSS_PERCENT,
  capitalRallyTroops,
} from "@openfront/engine-lib/game/ConventionalWar";
import { Game, Player } from "./Game";

/**
 * Conventional war capitals (numbers in engine-lib/game/ConventionalWar.ts).
 *
 * Every player but a tribe has a capital: their spawn tile, for the whole
 * game, whoever holds it.
 * - When an enemy conquers it, the owner loses CAPITAL_TROOP_LOSS_PERCENT of
 *   their troops and CAPITAL_GOLD_LOSS_PERCENT of their gold, which goes to
 *   the conqueror. The penalty hits a player at most once per
 *   CAPITAL_PENALTY_COOLDOWN_TICKS, so a capital changing hands back and
 *   forth can't chain it.
 * - The first time they retake it from whoever holds it, they rally:
 *   CAPITAL_RALLY_PCT of their max troops, never past the max. Once per game.
 * - While a player holds enemy capitals, their gold income rises by
 *   CAPITAL_HOLD_GOLD_BONUS_PCT per capital, up to
 *   CAPITAL_HOLD_GOLD_BONUS_MAX_PCT (heldEnemyCapitals, PlayerExecution).
 *
 * The state is on the player (capitalPenaltyTick, capitalRallyUsed), so
 * nothing here needs a snapshot of its own.
 */

/** Whether `player`'s capital tile is held by anyone else (or nobody). */
export function capitalLost(game: Game, player: Player): boolean {
  const capital = player.capitalTile();
  return capital !== undefined && game.owner(capital) !== player;
}

/** Called when `conqueror` takes `loser`'s capital tile (GameImpl.conquer). */
export function onCapitalConquered(
  game: Game,
  loser: Player,
  conqueror: Player,
): void {
  if (conqueror === loser || conqueror.isFriendly(loser, true)) return;
  const now = game.ticks();
  const last = loser.capitalPenaltyTick();
  if (last !== null && now - last < CAPITAL_PENALTY_COOLDOWN_TICKS) {
    // Lost again inside the window: no penalty this time.
    game.displayMessage(
      "events_display.capital_lost_no_penalty",
      MessageType.ATTACK_FAILED,
      loser.id(),
      undefined,
      { name: conqueror.displayName() },
      undefined,
      conqueror.id(),
    );
    return;
  }
  loser.recordCapitalPenalty(now);

  const troops = loser.removeTroops(
    Math.floor((loser.troops() * CAPITAL_TROOP_LOSS_PERCENT) / 100),
  );
  const gold = loser.removeGold(
    (loser.gold() * BigInt(CAPITAL_GOLD_LOSS_PERCENT)) / 100n,
  );
  if (gold > 0n) conqueror.addGold(gold);

  game.displayMessage(
    "events_display.capital_lost",
    MessageType.ATTACK_FAILED,
    loser.id(),
    undefined,
    {
      name: conqueror.displayName(),
      troops: renderTroops(troops),
      gold: renderNumber(gold),
    },
    undefined,
    conqueror.id(),
  );
  game.displayMessage(
    "events_display.capital_captured",
    MessageType.CONQUERED_PLAYER,
    conqueror.id(),
    gold,
    { name: loser.displayName(), gold: renderNumber(gold) },
    undefined,
    loser.id(),
  );
}

/**
 * Called when `player` takes their own capital tile back from `holder`
 * (GameImpl.conquer): the rally, the first time, then just the message.
 */
export function onCapitalRetaken(
  game: Game,
  player: Player,
  holder: Player,
): void {
  if (holder === player) return;
  if (player.capitalRallyUsed()) {
    game.displayMessage(
      "events_display.capital_recaptured",
      MessageType.CAPTURED_ENEMY_UNIT,
      player.id(),
    );
    return;
  }
  player.useCapitalRally();
  const troops = capitalRallyTroops(
    player.troops(),
    game.config().maxTroops(player),
  );
  if (troops > 0) player.addTroops(troops);
  game.displayMessage(
    "events_display.capital_rally",
    MessageType.CAPTURED_ENEMY_UNIT,
    player.id(),
    undefined,
    { troops: renderTroops(troops) },
  );
}

/**
 * How many enemy capitals `player` holds: capital tiles of other living
 * players, tribes aside, that `player` owns and isn't friendly with. Zero
 * outside conventional war. PlayerExecution prices the gold bonus from it
 * every tick, so the prize ends the tick the tile is lost.
 */
export function heldEnemyCapitals(game: Game, player: Player): number {
  if (!game.config().conventionalWar()) return 0;
  const smallID = player.smallID();
  let held = 0;
  for (const other of game.allPlayers()) {
    // Cheapest test first: almost no capital is ours.
    const capital = other.spawnTile();
    if (capital === undefined || game.ownerID(capital) !== smallID) continue;
    if (other === player || other.type() === PlayerType.Bot) continue;
    if (!other.isAlive() || player.isFriendly(other, true)) continue;
    held++;
  }
  return held;
}
