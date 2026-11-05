import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  defensePostRange,
  SIEGE_CAMP_RANGE,
} from "@openfront/engine-lib/game/Siege";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Attack, Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { isCataclysmHazard } from "./NationCataclysm";

/**
 * A nation builds a siege camp when the front of one of its land attacks
 * faces an enemy defense post that no friendly camp reduces yet. Stateless:
 * the only state it touches is the nation's PRNG, which the nation
 * execution snapshots, and it draws from it only once a camp would help.
 */

/** Percent chance per attack tick to build a camp once one would help, keyed by difficulty. */
export const NATION_SIEGE_CAMP_CHANCE: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0,
  [Difficulty.Medium]: 20,
  [Difficulty.Hard]: 40,
  [Difficulty.Impossible]: 70,
};

/** Gold a nation needs, in multiples of the camp's price, keyed by difficulty. */
export const NATION_SIEGE_CAMP_GOLD_FACTOR: Record<Difficulty, number> = {
  [Difficulty.Easy]: Infinity,
  [Difficulty.Medium]: 3,
  [Difficulty.Hard]: 2,
  [Difficulty.Impossible]: 1.5,
};

/** Most siege camps a nation owns at once. */
export const NATION_MAX_SIEGE_CAMPS = 2;

/** Enemy posts looked at per attack, lowest id first, to keep the scan cheap. */
const POSTS_CHECKED_PER_ATTACK = 8;

/** Called on the nation's attack ticks; true when it ordered a camp. */
export function considerSiegeCamp(
  game: Game,
  player: Player,
  random: PseudoRandom,
): boolean {
  const config = game.config();
  if (config.isUnitDisabled(UnitType.SiegeCamp) || !player.isAlive()) {
    return false;
  }
  const { difficulty } = config.gameConfig();
  const chance = NATION_SIEGE_CAMP_CHANCE[difficulty];
  if (chance === 0) return false;
  if (player.units(UnitType.SiegeCamp).length >= NATION_MAX_SIEGE_CAMPS) {
    return false;
  }
  const cost = game.unitInfo(UnitType.SiegeCamp).cost(game, player);
  if (
    Number(player.gold()) <
    Number(cost) * NATION_SIEGE_CAMP_GOLD_FACTOR[difficulty]
  ) {
    return false;
  }

  for (const attack of player.outgoingAttacks()) {
    const target = attack.target();
    // Land attacks only: a boat landing has no front to camp behind yet.
    if (!attack.isActive() || attack.sourceTile() !== null) continue;
    if (!target.isPlayer()) continue;
    const posts = target
      .units(UnitType.DefensePost)
      .filter((p) => p.isActive() && !p.isUnderConstruction())
      .sort((a, b) => a.id() - b.id())
      .slice(0, POSTS_CHECKED_PER_ATTACK);
    for (const post of posts) {
      const front = frontTileNearest(game, attack, post);
      if (front === null) continue;
      if (friendlyCampNear(game, player, post.tile())) continue;
      // A camp would help: roll once for this tick.
      if (random.nextInt(0, 100) >= chance) return false;
      const tile = campTile(game, player, front, post);
      if (tile === null) continue;
      game.addExecution(
        new ConstructionExecution(player, UnitType.SiegeCamp, tile),
      );
      return true;
    }
  }
  return false;
}

/**
 * The tile of `attack`'s front nearest to `post` among those the post
 * covers, or null when it covers none.
 */
function frontTileNearest(
  game: Game,
  attack: Attack,
  post: Unit,
): TileRef | null {
  const range = defensePostRange(post.level());
  let best: TileRef | null = null;
  let bestDist = range * range;
  const postTile = post.tile();
  for (const t of attack.borderTiles()) {
    const d = game.euclideanDistSquared(t, postTile);
    if (d < bestDist || (best === null && d === bestDist)) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** True when a camp of this nation or a friend (built or not) reduces `post`. */
function friendlyCampNear(game: Game, player: Player, post: TileRef): boolean {
  return game.anyUnitNearby(
    post,
    SIEGE_CAMP_RANGE,
    [UnitType.SiegeCamp],
    (camp) => camp.owner() === player || player.isFriendly(camp.owner(), true),
    undefined,
    true,
  );
}

/**
 * Where a camp next to the front tile `front` would go, if it would be in
 * range of `post`: the build is aimed at the nation's own land beside it.
 */
function campTile(
  game: Game,
  player: Player,
  front: TileRef,
  post: Unit,
): TileRef | null {
  const rangeSquared = SIEGE_CAMP_RANGE * SIEGE_CAMP_RANGE;
  for (const n of game.neighbors(front)) {
    if (game.owner(n) !== player) continue;
    const spawn = player.canBuild(UnitType.SiegeCamp, n);
    if (spawn === false) return null;
    // Like every nation build: not where a volcano is about to erupt or the
    // tide is about to flood (NationCataclysm).
    if (isCataclysmHazard(game, spawn)) return null;
    return game.euclideanDistSquared(spawn, post.tile()) <= rangeSquared
      ? n
      : null;
  }
  return null;
}
