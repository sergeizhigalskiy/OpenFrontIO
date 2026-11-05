import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  CITY_STATE_CITY_LEVEL,
  CITY_STATE_RADIUS,
} from "@openfront/engine-lib/game/WorldFeatures";
import { zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import {
  PlayerInfoSchema,
  playerInfoData,
  readPlayerInfo,
} from "../snapshot/CommonSchemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { CityExecution } from "./CityExecution";
import { DefensePostExecution } from "./DefensePostExecution";
import { PlayerExecution } from "./PlayerExecution";

/**
 * A city-state's defense post sits about this many tiles from its city,
 * inside its land.
 */
const DEFENSE_POST_OFFSET = 4;

/**
 * Founds one neutral city-state (engine-lib/game/WorldFeatures.ts) on its
 * first tick, in the spawn phase so players see it while they pick a spawn:
 * the disc of free land around `center`, a level-2 city on the center, a
 * defense post inside the land, and a full garrison. It gets a
 * PlayerExecution (troops and gold grow as a tribe's do) but no
 * TribeExecution, so it never expands, attacks or deletes its buildings.
 */
export class CityStateExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(
    private playerInfo: PlayerInfo,
    private center: TileRef,
  ) {}

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    this.active = false;
    const mg = this.mg;
    if (mg.hasPlayer(this.playerInfo.id)) return;
    const land = cityStateDisc(mg, this.center);
    if (!land.includes(this.center)) {
      console.warn(
        `CityStateExecution: ${this.playerInfo.name}'s center is taken`,
      );
      return;
    }

    const player = mg.addPlayer(this.playerInfo);
    player.markCityState();
    for (const tile of land) player.conquer(tile);
    player.setSpawnTile(this.center);
    mg.addExecution(new PlayerExecution(player));

    if (!mg.config().isUnitDisabled(UnitType.City)) {
      const city = player.grantUnit(UnitType.City, this.center, {});
      for (let level = 1; level < CITY_STATE_CITY_LEVEL; level++) {
        city.increaseLevel();
      }
      mg.addExecution(new CityExecution(city));
    }
    if (!mg.config().isUnitDisabled(UnitType.DefensePost)) {
      const post = player.grantUnit(
        UnitType.DefensePost,
        defensePostTile(mg, player, this.center),
        {},
      );
      mg.addExecution(new DefensePostExecution(post));
    }

    // The dense garrison: Config.maxTroops gives city-states a multiple of a
    // tribe's cap, and they start full.
    player.setTroops(mg.config().maxTroops(player));
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CityStateExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      playerInfo: playerInfoData(this.playerInfo),
      center: this.center,
    });
  }

  restoreSnapshot(s: CityStateState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.playerInfo = readPlayerInfo(s.playerInfo, r);
    this.center = s.center;
  }
}

/**
 * The free, passable land tiles within CITY_STATE_RADIUS (euclidean) of
 * `center`, in row order.
 */
export function cityStateDisc(game: Game, center: TileRef): TileRef[] {
  const cx = game.x(center);
  const cy = game.y(center);
  const r = CITY_STATE_RADIUS;
  const tiles: TileRef[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!game.isValidCoord(x, y)) continue;
      const tile = game.ref(x, y);
      if (
        game.isLand(tile) &&
        !game.isImpassable(tile) &&
        !game.hasOwner(tile)
      ) {
        tiles.push(tile);
      }
    }
  }
  return tiles;
}

/**
 * The tile of `player`'s land nearest DEFENSE_POST_OFFSET tiles from its
 * city (ties to the lowest ref), so the post sits between city and border.
 */
function defensePostTile(game: Game, player: Player, center: TileRef): TileRef {
  const want = DEFENSE_POST_OFFSET * DEFENSE_POST_OFFSET;
  let best = center;
  let bestScore = Infinity;
  for (const tile of player.tiles()) {
    const score = Math.abs(game.euclideanDistSquared(tile, center) - want);
    if (score < bestScore || (score === bestScore && tile < best)) {
      best = tile;
      bestScore = score;
    }
  }
  return best;
}

const CityStateStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  playerInfo: PlayerInfoSchema,
  center: zTile(),
});
type CityStateState = z.infer<typeof CityStateStateSchema>;

export const CityStateExecutionSnapshot = execSnapshotType({
  name: "CityState",
  version: 1,
  schema: CityStateStateSchema,
  cls: () => CityStateExecution,
});
