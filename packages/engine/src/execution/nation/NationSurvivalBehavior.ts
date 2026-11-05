import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { isHordeBand } from "@openfront/engine-lib/game/HordeNight";
import { INFECTED_PLAYER_ID } from "@openfront/engine-lib/game/Plague";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { assertNever } from "@openfront/engine-lib/Util";
import { Game, Player } from "../../game/Game";
import { AttackExecution } from "../AttackExecution";

/**
 * How nations play the survival lobby modes, run first in
 * NationAttackBehavior.chooseAttack and scaled by difficulty like the rest of
 * their targeting:
 *  - Horde Night: fellow defenders are teammates, so they are never
 *    attacked. A nation bordering a horde band fights it before anything
 *    else: the band attacking it hardest, else the weakest.
 *  - Plague: The Infected is the top threat once it borders the nation.
 *    Heavily infected-bordered, a nation commits more troops to it and
 *    attacks nobody else, so it keeps its infected front short; Hard and
 *    Impossible spearhead into small infected pockets so they get walled in
 *    and annexed (PlayerExecution's pocket annexation).
 * Stateless, so nothing to snapshot. With both modes off it returns at once
 * without touching the PRNG.
 */

/** A pocket is infected land of at most this many tiles, cut off from the rest. */
export const NATION_PLAGUE_POCKET_MAX_TILES = 400;
// Bounds the pocket search: infected tiles next to us flooded per decision.
const POCKET_SEARCH_STARTS = 32;

export interface SurvivalTuning {
  /** One in this many decisions puts the threat first (1: always). */
  firstChance: number;
  /**
   * Keeps the reserve ratio home (Easy, Medium), or only the expand ratio:
   * Hard and Impossible answer at once, as they do with retaliation.
   */
  keepsReserve: boolean;
  /** Saves up for a horde band it can't afford to fight yet, attacking nothing else. */
  holdsForHorde: boolean;
  /** Border tiles shared with The Infected at which the nation is heavily infected-bordered. */
  heavyInfectedBorder: number;
  /** Spearheads its plague attacks into small infected pockets. */
  annexesPockets: boolean;
}

export function survivalTuning(difficulty: Difficulty): SurvivalTuning {
  switch (difficulty) {
    case Difficulty.Easy:
      return {
        firstChance: 2,
        keepsReserve: true,
        holdsForHorde: false,
        heavyInfectedBorder: Infinity,
        annexesPockets: false,
      };
    case Difficulty.Medium:
      return {
        firstChance: 1,
        keepsReserve: true,
        holdsForHorde: true,
        heavyInfectedBorder: 300,
        annexesPockets: false,
      };
    case Difficulty.Hard:
      return {
        firstChance: 1,
        keepsReserve: false,
        holdsForHorde: true,
        heavyInfectedBorder: 200,
        annexesPockets: true,
      };
    case Difficulty.Impossible:
      return {
        firstChance: 1,
        keepsReserve: false,
        holdsForHorde: true,
        heavyInfectedBorder: 100,
        annexesPockets: true,
      };
    default:
      assertNever(difficulty);
  }
}

// Reusable neighbor buffers; the simulation is single-threaded.
const NEIGHBORS: TileRef[] = [0, 0, 0, 0];
const FLOOD_NEIGHBORS: TileRef[] = [0, 0, 0, 0];

/**
 * Fights the survival mode's threat. True when chooseAttack should stop
 * here: an attack went out, or the nation holds its troops for the threat.
 */
export function fightSurvivalThreat(
  game: Game,
  player: Player,
  random: PseudoRandom,
  reserveRatio: number,
  expandRatio: number,
): boolean {
  const config = game.config();
  const horde = config.hordeNightConfig().enabled;
  const plague = config.plague();
  if (!horde && !plague) return false;
  const tuning = survivalTuning(config.gameConfig().difficulty);
  const maxTroops = config.maxTroops(player);
  const spare = (keepsReserve: boolean) =>
    player.troops() - maxTroops * (keepsReserve ? reserveRatio : expandRatio);

  if (horde) {
    const band = hordeTarget(player);
    if (band !== null && putsThreatFirst(tuning, random)) {
      if (attack(game, player, band, spare(tuning.keepsReserve), null)) {
        return true;
      }
      if (tuning.holdsForHorde) return true;
    }
  }

  if (plague && game.hasPlayer(INFECTED_PLAYER_ID)) {
    const infected = game.player(INFECTED_PLAYER_ID);
    if (!infected.isAlive()) return false;
    const shared = sharedBorderTiles(game, player, infected);
    if (shared === 0) return false;
    const heavy = shared >= tuning.heavyInfectedBorder;
    if (!heavy && !putsThreatFirst(tuning, random)) return false;
    const focus = tuning.annexesPockets
      ? smallestPocketTile(game, player, infected)
      : null;
    // Heavily bordered, it commits all but the expand ratio.
    const troops = spare(tuning.keepsReserve && !heavy);
    if (attack(game, player, infected, troops, focus)) return true;
    // Heavily bordered, it attacks nobody else.
    return heavy;
  }
  return false;
}

/**
 * The bordering horde band to fight: the one attacking us hardest, else the
 * one with the fewest troops. Null when no band borders us.
 */
export function hordeTarget(player: Player): Player | null {
  let attacker: Player | null = null;
  let attackerTroops = 0;
  for (const attack of player.incomingAttacks()) {
    const from = attack.attacker();
    if (isHordeBand(from) && attack.troops() > attackerTroops) {
      attacker = from;
      attackerTroops = attack.troops();
    }
  }
  if (attacker !== null && player.sharesBorderWith(attacker)) return attacker;
  let weakest: Player | null = null;
  for (const n of player.nearby()) {
    if (!n.isPlayer() || !isHordeBand(n) || player.isFriendly(n)) continue;
    if (weakest === null || n.troops() < weakest.troops()) weakest = n;
  }
  return weakest;
}

/** How many of `player`'s tiles touch `infected`'s land. */
export function sharedBorderTiles(
  game: Game,
  player: Player,
  infected: Player,
): number {
  const map = game.map();
  const id = infected.smallID();
  let shared = 0;
  player.borderTiles().forEach((tile) => {
    const n = map.neighbors4(tile, NEIGHBORS);
    for (let i = 0; i < n; i++) {
      if (map.ownerID(NEIGHBORS[i]) === id) {
        shared++;
        return;
      }
    }
  });
  return shared;
}

/**
 * An infected tile next to `player` in the smallest infected pocket it
 * borders (a piece of infected land of at most
 * NATION_PLAGUE_POCKET_MAX_TILES), or null if it borders none.
 */
export function smallestPocketTile(
  game: Game,
  player: Player,
  infected: Player,
): TileRef | null {
  const map = game.map();
  const id = infected.smallID();
  const seen = new Set<TileRef>();
  let best = null as { size: number; tile: TileRef } | null;
  let starts = 0;
  player.borderTiles().forEach((tile) => {
    if (starts >= POCKET_SEARCH_STARTS) return;
    const n = map.neighbors4(tile, NEIGHBORS);
    for (let i = 0; i < n; i++) {
      const start = NEIGHBORS[i];
      if (map.ownerID(start) !== id || seen.has(start)) continue;
      starts++;
      // Flood the piece, giving up past the pocket size.
      const stack = [start];
      seen.add(start);
      let size = 0;
      while (stack.length > 0 && size <= NATION_PLAGUE_POCKET_MAX_TILES) {
        const t = stack.pop()!;
        size++;
        const m = map.neighbors4(t, FLOOD_NEIGHBORS);
        for (let j = 0; j < m; j++) {
          const next = FLOOD_NEIGHBORS[j];
          if (map.ownerID(next) !== id || seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      const closed =
        stack.length === 0 && size <= NATION_PLAGUE_POCKET_MAX_TILES;
      if (closed && (best === null || size < best.size)) {
        best = { size, tile: start };
      }
    }
  });
  return best?.tile ?? null;
}

// Whether this decision puts the threat first (Easy: one in two).
function putsThreatFirst(
  tuning: SurvivalTuning,
  random: PseudoRandom,
): boolean {
  return tuning.firstChance === 1 || random.chance(tuning.firstChance);
}

// A land attack on `target` with `troops`, spearheaded at `focus` if given.
function attack(
  game: Game,
  player: Player,
  target: Player,
  troops: number,
  focus: TileRef | null,
): boolean {
  if (troops < 1 || !player.sharesBorderWith(target)) return false;
  game.addExecution(
    new AttackExecution(troops, player, target.id(), null, true, focus),
  );
  return true;
}
