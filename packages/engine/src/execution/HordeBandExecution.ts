import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_BAND_ATTACK_INTERVAL_TICKS,
  HORDE_BAND_CLEANUP_TICKS,
  HORDE_BAND_RETARGET_TICKS,
  HORDE_BAND_TARGET_SAMPLES,
  hordeBandSpent,
  isHordeBand,
  isHordeDefender,
} from "@openfront/engine-lib/game/HordeNight";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  VersionedSchema,
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AttackExecution } from "./AttackExecution";
import { TribeAttackBehavior } from "./TribeAttackBehavior";
import {
  razeNextStructure,
  refuseAllianceRequests,
} from "./utils/HostileFaction";

/**
 * A Horde Night band (see engine-lib/game/HordeNight.ts): a tribe-like bot
 * that attacks the defender its wave was sent at with everything it has,
 * again and again, and never allies. Once that defender falls it goes for
 * the nearest other defender. Land and boat attacks go through
 * TribeAttackBehavior with no reserve; a band that can't reach its target by
 * land yet marches through free land toward it (a spearhead on its nearest
 * border tile). HORDE_BAND_CLEANUP_TICKS after landing, a band holding under
 * HORDE_BAND_CLEANUP_PERCENT of its landing troops disbands and frees its
 * land.
 */
export class HordeBandExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private attackBehavior: TribeAttackBehavior | null = null;
  // Which tick of each attack interval this band acts on.
  private attackTick: number;
  // Who it attacks: its defender while that lives, then the nearest one,
  // looked up again every retarget interval.
  private target: Player | null = null;
  private retargetTick = 0;
  // The tick it landed (set on init), for the cleanup.
  private landedTick = -1;

  /**
   * `defender` is who the band's wave was sent at (null: the nearest
   * defender); `landingTroops` what it landed with.
   */
  constructor(
    private band: Player,
    private defender: Player | null = null,
    private landingTroops = 0,
  ) {
    this.random = new PseudoRandom(simpleHash(band.id()));
    this.attackTick = simpleHash(band.id()) % HORDE_BAND_ATTACK_INTERVAL_TICKS;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (this.landedTick < 0) this.landedTick = ticks;
  }

  tick(ticks: number): void {
    if (ticks % HORDE_BAND_ATTACK_INTERVAL_TICKS !== this.attackTick) return;
    if (!this.band.isAlive()) {
      // The band's PlayerExecution clears up after it.
      this.active = false;
      return;
    }
    if (
      ticks - this.landedTick >= HORDE_BAND_CLEANUP_TICKS &&
      hordeBandSpent(this.strength(), this.landingTroops)
    ) {
      this.disband();
      return;
    }
    // No reserve: every troop goes into the attack.
    this.attackBehavior ??= new TribeAttackBehavior(
      this.random,
      this.mg,
      this.band,
      0,
      0,
      0,
    );
    refuseAllianceRequests(this.band);
    razeNextStructure(this.mg, this.band);

    if (this.defender !== null && this.defender.isAlive()) {
      this.target = this.defender;
    } else if (
      this.target === null ||
      !this.target.isAlive() ||
      this.target === this.defender ||
      ticks >= this.retargetTick
    ) {
      this.target = this.nearestPlayer()?.player ?? null;
      this.retargetTick = ticks + HORDE_BAND_RETARGET_TICKS;
    }
    this.attack(this.attackBehavior, this.target);
  }

  /** The band's troops at home, in its attacks and on its boats. */
  strength(): number {
    let troops = this.band.troops();
    for (const attack of this.band.outgoingAttacks()) troops += attack.troops();
    for (const boat of this.band.units(UnitType.TransportShip)) {
      troops += boat.troops();
    }
    return troops;
  }

  // Bled out: the band and its attacks go, and its land is free again.
  private disband(): void {
    for (const attack of this.band.outgoingAttacks()) attack.delete();
    for (const boat of this.band.units(UnitType.TransportShip)) {
      boat.delete(false);
    }
    this.band.removeTroops(this.band.troops());
    for (const tile of Array.from(this.band.tiles())) {
      this.band.relinquish(tile);
    }
    this.active = false;
  }

  private attack(behavior: TribeAttackBehavior, target: Player | null): void {
    const terraNullius = this.mg.terraNullius();
    if (target === null) {
      behavior.sendAttack(terraNullius, true);
      return;
    }
    if (this.band.sharesBorderWith(target)) {
      behavior.sendAttack(target, true);
      return;
    }
    // Not there yet: march through free land toward the target.
    if (this.band.nearby().some((n) => !n.isPlayer())) {
      const troops = this.band.troops();
      if (troops >= 1) {
        this.mg.addExecution(
          new AttackExecution(
            troops,
            this.band,
            terraNullius.id(),
            null,
            true,
            this.closestTile(target).tile,
          ),
        );
      }
      return;
    }
    // Walled in by someone else on the way: go through them, or sail.
    for (const neighbor of this.band.nearby()) {
      if (neighbor.isPlayer() && this.isPrey(neighbor)) {
        behavior.sendAttack(neighbor, true);
        return;
      }
    }
    behavior.sendAttack(target, true);
  }

  private isPrey(player: Player): boolean {
    return (
      player !== this.band &&
      !isHordeBand(player) &&
      !this.band.isFriendly(player)
    );
  }

  /**
   * The defender closest to where the band landed, measured to a sample of
   * each one's border. Ties go to the earlier player.
   */
  nearestPlayer(): { player: Player; distance: number } | null {
    let best: { player: Player; distance: number } | null = null;
    for (const player of this.mg.players()) {
      if (!isHordeDefender(player) || !this.isPrey(player)) continue;
      const { distance } = this.closestTile(player);
      if (best === null || distance < best.distance) {
        best = { player, distance };
      }
    }
    return best;
  }

  /** The defender the band's wave was sent at, or null. */
  assignedDefender(): Player | null {
    return this.defender;
  }

  // The sampled border tile of `player` closest to the band's landing tile.
  private closestTile(player: Player): {
    tile: TileRef | null;
    distance: number;
  } {
    const from = this.band.spawnTile();
    const border = player.borderTiles();
    const step = Math.max(
      1,
      Math.ceil(border.size / HORDE_BAND_TARGET_SAMPLES),
    );
    let tile: TileRef | null = null;
    let distance = Number.MAX_SAFE_INTEGER;
    let i = 0;
    border.forEach((t) => {
      if (i++ % step !== 0) return;
      const d = from === undefined ? 0 : this.mg.manhattanDist(from, t);
      if (d < distance) {
        distance = d;
        tile = t;
      }
    });
    return { tile, distance };
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return HordeBandExecutionSnapshot.write({
      active: this.active,
      band: w.player(this.band),
      random: w.random(this.random),
      initialized: this.mg !== undefined,
      attackBehavior: this.attackBehavior?.snapshot(w) ?? null,
      attackTick: this.attackTick,
      target: this.target === null ? null : w.player(this.target),
      retargetTick: this.retargetTick,
      defender: this.defender === null ? null : w.player(this.defender),
      landingTroops: this.landingTroops,
      landedTick: this.landedTick,
    });
  }

  restoreSnapshot(s: HordeBandState, r: SnapshotReader): void {
    this.active = s.active;
    this.band = r.player(s.band);
    // One PRNG shared with the attack behavior, as in a live game.
    this.random = r.random(s.random);
    if (s.initialized) this.mg = r.game;
    if (s.attackBehavior === null) {
      this.attackBehavior = null;
    } else {
      const attack = Object.create(
        TribeAttackBehavior.prototype,
      ) as TribeAttackBehavior;
      attack.restoreSnapshot(s.attackBehavior, r, this.random, this.band);
      this.attackBehavior = attack;
    }
    this.attackTick = s.attackTick;
    this.target = s.target === null ? null : r.player(s.target);
    this.retargetTick = s.retargetTick;
    this.defender = s.defender === null ? null : r.player(s.defender);
    this.landingTroops = s.landingTroops;
    this.landedTick = s.landedTick;
  }
}

const HordeBandStateSchema = z.object({
  active: z.boolean(),
  band: zPlayerRef(),
  random: zRandom(),
  initialized: z.boolean(),
  attackBehavior: VersionedSchema.nullable(),
  attackTick: zInt(),
  target: zPlayerRef().nullable(),
  retargetTick: zInt(),
  defender: zPlayerRef().nullable(),
  landingTroops: zNum(),
  landedTick: zInt(),
});
type HordeBandState = z.infer<typeof HordeBandStateSchema>;

export const HordeBandExecutionSnapshot = execSnapshotType({
  name: "HordeBand",
  version: 2,
  schema: HordeBandStateSchema,
  // v2: bands go for the defender their wave was sent at, and disband once
  // spent. An older band had none, and never disbands.
  migrations: {
    1: (d) => ({
      ...(d as Record<string, unknown>),
      defender: null,
      landingTroops: 0,
      landedTick: 0,
    }),
  },
  cls: () => HordeBandExecution,
});
