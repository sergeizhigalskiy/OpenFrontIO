import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  HORDE_BAND_ATTACK_INTERVAL_TICKS,
  HORDE_BAND_RETARGET_TICKS,
  HORDE_BAND_TARGET_SAMPLES,
  isHordeBand,
} from "@openfront/engine-lib/game/HordeNight";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  VersionedSchema,
  zInt,
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
 * that attacks the nearest non-horde player with everything it has, again
 * and again, and never allies. Land and boat attacks go through
 * TribeAttackBehavior with no reserve; a band that can't reach its target by
 * land yet marches through free land toward it (a spearhead on its nearest
 * border tile).
 */
export class HordeBandExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private attackBehavior: TribeAttackBehavior | null = null;
  // Which tick of each attack interval this band acts on.
  private attackTick: number;
  // The nearest non-horde player, looked up again every retarget interval.
  private target: Player | null = null;
  private retargetTick = 0;

  constructor(private band: Player) {
    this.random = new PseudoRandom(simpleHash(band.id()));
    this.attackTick = simpleHash(band.id()) % HORDE_BAND_ATTACK_INTERVAL_TICKS;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (ticks % HORDE_BAND_ATTACK_INTERVAL_TICKS !== this.attackTick) return;
    if (!this.band.isAlive()) {
      // The band's PlayerExecution clears up after it.
      this.active = false;
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

    if (
      this.target === null ||
      !this.target.isAlive() ||
      ticks >= this.retargetTick
    ) {
      this.target = this.nearestPlayer()?.player ?? null;
      this.retargetTick = ticks + HORDE_BAND_RETARGET_TICKS;
    }
    this.attack(this.attackBehavior, this.target);
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
   * The non-horde player closest to where the band landed, measured to a
   * sample of each player's border. Ties go to the earlier player.
   */
  nearestPlayer(): { player: Player; distance: number } | null {
    let best: { player: Player; distance: number } | null = null;
    for (const player of this.mg.players()) {
      if (!this.isPrey(player)) continue;
      const { distance } = this.closestTile(player);
      if (best === null || distance < best.distance) {
        best = { player, distance };
      }
    }
    return best;
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
});
type HordeBandState = z.infer<typeof HordeBandStateSchema>;

export const HordeBandExecutionSnapshot = execSnapshotType({
  name: "HordeBand",
  version: 1,
  schema: HordeBandStateSchema,
  cls: () => HordeBandExecution,
});
