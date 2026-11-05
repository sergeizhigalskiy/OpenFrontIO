import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { canalPlan, canalPrice } from "../game/Canal";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Digs one canal (rules in engine-lib/game/Canal.ts).
 *
 * init finds the path through the clicked tile, checks it and charges for it,
 * and places a Canal unit at the path's ends (under construction, which is
 * what the client draws). Every tick it checks that the builder still owns
 * every path tile; losing one cancels the dig with no refund. After the
 * construction time it relinquishes the path and queues its tiles for water
 * conversion through GameImpl.queueWaterConversion, which also rebuilds the
 * water graph and rail plans like a water nuke does.
 *
 * A path tile taken in the same tick it was relinquished stays land; the dig
 * then keeps flooding the tiles still held by the builder or by no one, for
 * up to FLOOD_RETRY_TICKS ticks, so the channel isn't left with a gap.
 */
const FLOOD_RETRY_TICKS = 10;

export class CanalExecution implements Execution {
  private active = true;
  private mg: Game;
  private canal: Unit | null = null;
  /** The land tiles to dig, from the plan made in init. */
  private tiles: TileRef[] = [];
  /** Construction ticks left; once flooding, flood retries left. */
  private ticksLeft = 0;
  /** True once the dig is done and its tiles are being turned to water. */
  private flooding = false;

  constructor(
    private player: Player,
    private tile: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (mg.config().isUnitDisabled(UnitType.Canal)) {
      this.active = false;
      return;
    }
    if (!mg.isValidRef(this.tile) || !this.player.isAlive()) {
      this.active = false;
      return;
    }
    const plan = canalPlan(mg, this.player, this.tile);
    if (!plan.ok) {
      console.warn(`cannot dig canal at ${this.tile}: ${plan.reason}`);
      this.active = false;
      return;
    }
    const path = plan.path;
    if (this.player.gold() < canalPrice(mg, this.player, path.length)) {
      this.active = false;
      return;
    }
    // buildUnit charges canalPrice for the path's length.
    this.canal = this.player.buildUnit(UnitType.Canal, path.start, {
      targetTile: path.end,
      length: path.length,
    });
    this.tiles = path.tiles;
    this.ticksLeft = mg.unitInfo(UnitType.Canal).constructionDuration ?? 0;
    if (this.ticksLeft > 0) this.canal.setUnderConstruction(true);
  }

  tick(ticks: number): void {
    if (this.flooding) {
      this.ticksLeft--;
      if (this.flood() === 0 || this.ticksLeft <= 0) this.active = false;
      return;
    }
    const canal = this.canal;
    if (canal === null || !canal.isActive()) {
      this.active = false;
      return;
    }
    for (const t of this.tiles) {
      if (this.mg.owner(t) !== this.player) {
        this.cancel(canal);
        return;
      }
    }
    if (this.ticksLeft > 0) {
      this.ticksLeft--;
      return;
    }
    canal.delete(false);
    this.canal = null;
    this.flooding = true;
    this.ticksLeft = FLOOD_RETRY_TICKS;
    this.flood();
    this.mg.displayMessage(
      "events_display.canal_complete",
      MessageType.CAPTURED_ENEMY_UNIT,
      this.player.id(),
    );
  }

  /**
   * Relinquishes and queues every path tile that is still land and held by
   * the builder or no one. Returns how many it queued.
   */
  private flood(): number {
    let queued = 0;
    for (const t of this.tiles) {
      if (!this.mg.isLand(t) || this.mg.isImpassable(t)) continue;
      const owner = this.mg.owner(t);
      if (owner.isPlayer()) {
        if (owner !== this.player) continue;
        owner.relinquish(t);
      }
      this.mg.queueWaterConversion(t, true);
      queued++;
    }
    return queued;
  }

  private cancel(canal: Unit): void {
    canal.delete(false);
    this.canal = null;
    this.active = false;
    this.mg.displayMessage(
      "events_display.canal_cancelled",
      MessageType.UNIT_DESTROYED,
      this.player.id(),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CanalExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      tile: this.tile,
      canal: w.unitOrNull(this.canal),
      tiles: Uint32Array.from(this.tiles),
      ticksLeft: this.ticksLeft,
      flooding: this.flooding,
    });
  }

  restoreSnapshot(s: CanalState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.tile = s.tile;
    this.canal = r.unitOrNull(s.canal);
    this.tiles = Array.from(s.tiles);
    this.ticksLeft = s.ticksLeft;
    this.flooding = s.flooding;
  }
}

const CanalStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  // Validated in init, so a pending dig may hold any number.
  tile: zInt(),
  canal: zRef().nullable(),
  tiles: zTiles(),
  ticksLeft: zInt(),
  flooding: z.boolean(),
});
type CanalState = z.infer<typeof CanalStateSchema>;

export const CanalExecutionSnapshot = execSnapshotType({
  name: "Canal",
  version: 1,
  schema: CanalStateSchema,
  cls: () => CanalExecution,
});
