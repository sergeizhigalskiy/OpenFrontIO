import { TileRef } from "@openfront/engine-api/game/GameMap";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  RUIN_MIN_SPACING,
  RUIN_MIN_SPAWN_DISTANCE,
  RUIN_PLACEMENT_TRIES_PER_RUIN,
  RUIN_REWARD_KINDS,
  RuinReward,
  ruinCount,
} from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zRandom } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  cityStateZones,
  mineZones,
  overlapsZone,
  volcanoZones,
} from "../game/StartPlacements";
import { resourceSitesOf } from "./ResourceSiteExecution";
import { volcanoSitesOf } from "./VolcanoExecution";

/** Seed offset from the game id, apart from the other game-seeded PRNGs. */
const RUINS_SEED_OFFSET = 4;

/**
 * Places the ruins (engine-lib/game/WorldFeatures.ts) on the first tick after
 * the spawn phase ends, then retires. GameRunner adds it when the setting is
 * on; GameImpl.conquer hands out the loot.
 */
export class RuinsExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;

  constructor(gameID: GameID) {
    this.random = new PseudoRandom(simpleHash(gameID) + RUINS_SEED_OFFSET);
  }

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    if (this.mg.inSpawnPhase()) return;
    this.mg.addRuins(placeRuins(this.mg, this.random));
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return RuinsExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      random: w.random(this.random),
    });
  }

  restoreSnapshot(s: RuinsState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.random = r.random(s.random);
  }
}

/**
 * Where the ruins go and what each holds, from `random` alone: up to
 * ruinCount() random tiles of unclaimed, passable land, each at least
 * RUIN_MIN_SPAWN_DISTANCE from every spawn tile (and from the spawn cell of
 * a nation still waiting to spawn) and RUIN_MIN_SPACING from each other. A
 * crowded map gets fewer.
 */
export function placeRuins(
  game: Game,
  random: PseudoRandom,
): { tile: TileRef; reward: RuinReward }[] {
  const target = ruinCount(game.numLandTiles());
  const spawns: TileRef[] = [];
  for (const p of game.allPlayers()) {
    const t = p.spawnTile();
    if (t !== undefined) spawns.push(t);
  }
  for (const n of game.nations()) {
    const cell = n.spawnCell;
    if (cell === undefined || !game.isValidCoord(cell.x, cell.y)) continue;
    if (game.hasPlayer(n.playerInfo.id)) {
      if (game.player(n.playerInfo.id).hasSpawned()) continue;
    }
    spawns.push(game.ref(cell.x, cell.y));
  }

  // City-states, volcanoes and mines came first (StartPlacements).
  const taken = [
    ...cityStateZones(game),
    ...volcanoZones(volcanoSitesOf(game)),
    ...mineZones(resourceSitesOf(game)),
  ];
  const spawnDist2 = RUIN_MIN_SPAWN_DISTANCE * RUIN_MIN_SPAWN_DISTANCE;
  const spacing2 = RUIN_MIN_SPACING * RUIN_MIN_SPACING;
  const ruins: { tile: TileRef; reward: RuinReward }[] = [];
  const tries = target * RUIN_PLACEMENT_TRIES_PER_RUIN;
  for (let i = 0; i < tries && ruins.length < target; i++) {
    const tile = game.ref(
      random.nextInt(0, game.width()),
      random.nextInt(0, game.height()),
    );
    if (
      !game.isLand(tile) ||
      game.isImpassable(tile) ||
      game.hasOwner(tile) ||
      spawns.some((s) => game.euclideanDistSquared(s, tile) < spawnDist2) ||
      ruins.some((r) => game.euclideanDistSquared(r.tile, tile) < spacing2) ||
      overlapsZone(game, taken, tile)
    ) {
      continue;
    }
    ruins.push({
      tile,
      reward: random.nextInt(0, RUIN_REWARD_KINDS) as RuinReward,
    });
  }
  return ruins;
}

const RuinsStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom(),
});
type RuinsState = z.infer<typeof RuinsStateSchema>;

export const RuinsExecutionSnapshot = execSnapshotType({
  name: "Ruins",
  version: 1,
  schema: RuinsStateSchema,
  cls: () => RuinsExecution,
});
