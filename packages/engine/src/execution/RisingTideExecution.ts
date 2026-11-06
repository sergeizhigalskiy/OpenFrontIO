import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Structures,
  TrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  RISING_TIDE_FIRST_WAVE_TICKS,
  RISING_TIDE_WARNING_TICKS,
  RISING_TIDE_WAVE_INTERVAL_TICKS,
  risingTideTroopsLost,
  risingTideWaveBudget,
  risingTideWaveTiles,
} from "@openfront/engine-lib/game/RisingTide";
import { troopsLostWithLand } from "@openfront/engine-lib/game/Volcanoes";
import { zInt, zTiles } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

// Each game's rising tide, so nations can see the tiles about to flood.
const tides = new WeakMap<Game, RisingTideExecution>();

/** True during a wave's warning when `tile` is one the wave floods. */
export function isNextToFlood(game: Game, tile: TileRef): boolean {
  return tides.get(game)?.floodsNext(tile) ?? false;
}

/**
 * Rising tide (game mode; numbers in engine-lib/game/RisingTide.ts).
 *
 * After the spawn phase plus RISING_TIDE_FIRST_WAVE_TICKS, a wave floods every
 * RISING_TIDE_WAVE_INTERVAL_TICKS. RISING_TIDE_WARNING_TICKS before each wave
 * the tiles it will flood are picked (the lowest land next to the ocean, see
 * risingTideWaveTiles) and shown. When it floods, their owners lose them; the
 * troops on them fall back to the owner's remaining land, as far as its troop
 * cap allows (risingTideTroopsLost). The structures, convoys and train
 * engines on them are destroyed, and they turn to water through the same
 * queue water nukes use. The tide stops once the land left is
 * RISING_TIDE_STOP_PERCENT of the original.
 *
 * Floods rebuild the water graph in the same tick (WaterManager.queueTile), so
 * no ship routes on a stale graph and snapshots taken around a wave restore
 * exactly (snapshot/README.md, "Known gaps").
 */
export class RisingTideExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  /** Land tiles when the tide started. */
  private originalLand = 0;
  /** Tick the next wave floods; null once the tide has stopped. */
  private nextWaveTick: number | null = null;
  /** The tiles the next wave floods, while its warning is up. */
  private warningTiles: TileRef[] = [];
  /** warningTiles as a set, for nations' lookups. */
  private warningSet = new Set<TileRef>();
  private wave = 0;

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.originalLand = mg.numLandTiles();
    this.nextWaveTick =
      ticks -
      Math.round(mg.elapsedGameSeconds() * 10) +
      RISING_TIDE_FIRST_WAVE_TICKS;
    tides.set(mg, this);
    this.emit();
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (this.nextWaveTick === null) {
      this.active = false;
      return;
    }
    if (this.warningTiles.length === 0) {
      if (ticks < this.nextWaveTick - RISING_TIDE_WARNING_TICKS) return;
      const budget = risingTideWaveBudget(this.originalLand, mg.numLandTiles());
      const tiles = risingTideWaveTiles(mg.map(), budget);
      if (tiles.length === 0) {
        this.stop();
        return;
      }
      // A full warning even when the tide started late.
      this.nextWaveTick = Math.max(
        this.nextWaveTick,
        ticks + RISING_TIDE_WARNING_TICKS,
      );
      this.setWarning(tiles);
      this.emit();
      return;
    }
    if (ticks < this.nextWaveTick) return;
    const flooded = this.flood(mg, this.warningTiles);
    this.wave++;
    this.setWarning([]);
    // The tiles turn to water at the end of this tick, so count them now.
    const landAfter = mg.numLandTiles() - flooded;
    if (risingTideWaveBudget(this.originalLand, landAfter) > 0) {
      this.nextWaveTick += RISING_TIDE_WAVE_INTERVAL_TICKS;
      this.emit();
    } else {
      this.stop();
    }
  }

  floodsNext(tile: TileRef): boolean {
    return this.warningSet.has(tile);
  }

  /** Floods `tiles` and returns how many turned to water. */
  private flood(mg: Game, tiles: readonly TileRef[]): number {
    const tilesBefore = new Map<Player, number>();
    const tilesLost = new Map<Player, number>();
    const flooded = new Set<TileRef>();
    for (const tile of tiles) {
      // Nukes may have taken some since the warning.
      if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
      const owner = mg.owner(tile);
      if (owner.isPlayer()) {
        if (!tilesBefore.has(owner)) {
          tilesBefore.set(owner, owner.numTilesOwned());
        }
        // Water can't be owned: setWater throws on an owned tile.
        owner.relinquish(tile);
        tilesLost.set(owner, (tilesLost.get(owner) ?? 0) + 1);
      }
      flooded.add(tile);
    }
    // What stands on the land goes under with it. Ships and aircraft are on
    // water or in the air, so they are untouched. A train goes when its engine
    // is caught: TrainExecution then removes its cars, which must not be
    // deleted one by one as it keeps moving them.
    for (const unit of mg.units()) {
      if (!unit.isActive() || !flooded.has(unit.tile())) continue;
      const type = unit.type();
      if (
        Structures.has(type) ||
        type === UnitType.Convoy ||
        (type === UnitType.Train && unit.trainType() === TrainType.Engine)
      ) {
        unit.delete(true);
      }
    }
    for (const [player, lost] of tilesLost) {
      player.removeTroops(
        risingTideTroopsLost(
          player.troops(),
          troopsLostWithLand(player.troops(), tilesBefore.get(player)!, lost),
          mg.config().maxTroops(player),
        ),
      );
    }
    for (const tile of flooded) mg.queueWaterConversion(tile, true, true);
    return flooded.size;
  }

  private setWarning(tiles: TileRef[]): void {
    this.warningTiles = tiles;
    this.warningSet = new Set(tiles);
  }

  private stop(): void {
    this.nextWaveTick = null;
    this.setWarning([]);
    this.emit();
    this.active = false;
  }

  private emit(): void {
    this.mg?.addUpdate({
      type: GameUpdateType.Cataclysm,
      kind: "tide",
      nextWaveTick: this.nextWaveTick,
      warningTiles: [...this.warningTiles],
      wave: this.wave,
      originalLand: this.originalLand,
    });
  }

  viewResync(): void {
    this.emit();
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return RisingTideExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      originalLand: this.originalLand,
      nextWaveTick: this.nextWaveTick,
      warningTiles: w.tiles(this.warningTiles),
      wave: this.wave,
    });
  }

  restoreSnapshot(s: RisingTideState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.originalLand = s.originalLand;
    this.nextWaveTick = s.nextWaveTick;
    this.warningTiles = Array.from(s.warningTiles);
    this.warningSet = new Set(this.warningTiles);
    this.wave = s.wave;
    if (s.initialized) tides.set(r.game, this);
  }
}

const RisingTideStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  originalLand: zInt(),
  nextWaveTick: zInt().nullable(),
  // In flood order.
  warningTiles: zTiles(),
  wave: zInt(),
});
type RisingTideState = z.infer<typeof RisingTideStateSchema>;

export const RisingTideExecutionSnapshot = execSnapshotType({
  name: "RisingTide",
  version: 1,
  schema: RisingTideStateSchema,
  cls: () => RisingTideExecution,
});
