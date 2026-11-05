import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  clampMinefieldDensity,
  MINEFIELD_DEPLETION_PER_HIT,
  MINEFIELD_RADIUS,
  MINEFIELD_WARSHIP_DAMAGE_PERCENT,
  minefieldHitChanceBasisPoints,
} from "@openfront/engine-lib/game/NavalDefense";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, isUnit, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { isConvoyHostile } from "./ConvoyExecution";

/**
 * Minefields: cheap naval defense laid on ocean water.
 *
 * The rules, kept small on purpose (numbers in engine-lib/game/NavalDefense.ts):
 * - A field covers a circle of MINEFIELD_RADIUS tiles around its center. Its
 *   density (an integer percent) is the unit's health.
 * - Each tick, every hostile warship, transport ship or troop convoy at sea
 *   that has moved to a new tile inside the field rolls once:
 *   MINEFIELD_HIT_CHANCE_BASIS_POINTS x density/100. Trade ships are never hit.
 * - A hit sinks a transport ship or convoy with all its troops, or costs a
 *   warship MINEFIELD_WARSHIP_DAMAGE_PERCENT of its max health.
 * - Every hit costs the field MINEFIELD_DEPLETION_PER_HIT density points; at
 *   0 it is gone.
 * - Fields can't be captured; they go when their owner is eliminated.
 * - Only the owner and their friends see a field (a client rendering filter;
 *   every client simulates it).
 */

/** Ship types mines and coastal batteries engage. Trade ships never. */
export const NAVAL_DEFENSE_TARGET_TYPES: readonly UnitType[] = [
  UnitType.Warship,
  UnitType.TransportShip,
  UnitType.Convoy,
];

/**
 * True when `defender`'s mines and coastal batteries engage `ship`: an active
 * warship, transport ship or troop convoy at sea whose owner is neither
 * `defender` nor friendly (allied or teammate) with them. A convoy is also
 * spared when `defender` is its recipient (see isConvoyHostile).
 */
export function isHostileShip(
  game: Game,
  defender: Player,
  ship: Unit,
): boolean {
  if (!ship.isActive()) return false;
  switch (ship.type()) {
    case UnitType.Convoy:
      return game.isWater(ship.tile()) && isConvoyHostile(ship, defender);
    case UnitType.Warship:
    case UnitType.TransportShip: {
      // A disconnected ally is still an ally, as for warships and convoys.
      const owner = ship.owner();
      return owner !== defender && !defender.isFriendly(owner, true);
    }
    default:
      return false;
  }
}

/** The translation key naming `type` in mine messages. */
function shipKey(type: UnitType): string {
  switch (type) {
    case UnitType.Warship:
      return "unit_type.warship";
    case UnitType.Convoy:
      return "unit_type.convoy";
    default:
      return "unit_type.boat";
  }
}

/** Where to lay a new field: the owner, the clicked tile and its density. */
export interface MinefieldOrder {
  owner: Player;
  tile: TileRef;
  density: number;
}

export class MinefieldExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  /** Null before init, or when the field could not be laid. */
  private field: Unit | null = null;
  /**
   * The tile each covered ship (hostile or not) was on inside the field at
   * the last check. A ship rolls only when its tile changed since then.
   */
  private shipTiles = new Map<Unit, TileRef>();
  /**
   * False until the field's first check: ships already inside a field when
   * it is laid are recorded without a roll, since they didn't enter it.
   */
  private primed = false;

  /** Lays a field from an order, or runs an existing field unit. */
  constructor(private input: MinefieldOrder | Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.field = this.input;
    } else {
      const { owner, tile } = this.input;
      const density = clampMinefieldDensity(this.input.density);
      const cost = mg.config().minefieldCost(mg, owner, density);
      const spawn = owner.canBuild(UnitType.Minefield, tile, null, cost);
      if (spawn === false) {
        console.warn(`${owner.name()} cannot lay a minefield at ${tile}`);
        this.active = false;
        return;
      }
      this.field = owner.buildUnit(UnitType.Minefield, spawn, { density });
    }
    // Seeded per field so fields laid on the same tick roll differently.
    this.random = new PseudoRandom(mg.ticks() + this.field.id() * 7919);
  }

  tick(ticks: number): void {
    const field = this.field;
    if (field === null || !field.isActive()) {
      this.active = false;
      return;
    }
    const owner = field.owner();
    if (!owner.isAlive()) {
      field.delete(false);
      this.active = false;
      return;
    }

    const radiusSquared = MINEFIELD_RADIUS * MINEFIELD_RADIUS;
    // Sorted by id so the rolls don't depend on the spatial index's order.
    const inside = this.mg
      .nearbyUnits(
        field.tile(),
        MINEFIELD_RADIUS + 1,
        NAVAL_DEFENSE_TARGET_TYPES,
      )
      .filter(
        ({ unit, distSquared }) =>
          distSquared <= radiusSquared && this.mg.isWater(unit.tile()),
      )
      .map(({ unit }) => unit)
      .sort((a, b) => a.id() - b.id());

    const seen = new Map<Unit, TileRef>();
    for (const ship of inside) {
      const tile = ship.tile();
      const entered = this.primed && this.shipTiles.get(ship) !== tile;
      seen.set(ship, tile);
      if (!entered || !isHostileShip(this.mg, owner, ship)) continue;
      const chance = minefieldHitChanceBasisPoints(field.health());
      if (this.random.nextInt(0, 10_000) >= chance) continue;
      this.hit(field, ship);
      if (!field.isActive()) break;
    }
    this.shipTiles = seen;
    this.primed = true;
    if (!field.isActive()) this.active = false;
  }

  private hit(field: Unit, ship: Unit): void {
    const owner = field.owner();
    const victim = ship.owner();
    const unit = shipKey(ship.type());

    if (ship.type() === UnitType.Warship) {
      const damage = Math.floor(
        (ship.maxHealth() * MINEFIELD_WARSHIP_DAMAGE_PERCENT) / 100,
      );
      ship.modifyHealth(-damage, owner);
    } else {
      // Sunk with every troop aboard.
      ship.delete(true, owner);
    }

    this.mg.displayMessage(
      "events_display.mine_hit",
      MessageType.UNIT_DESTROYED,
      victim.id(),
      undefined,
      { unit, name: owner.displayName() },
      undefined,
      owner.id(),
    );
    this.mg.displayMessage(
      "events_display.mine_struck",
      MessageType.CAPTURED_ENEMY_UNIT,
      owner.id(),
      undefined,
      { unit, name: victim.displayName() },
      undefined,
      victim.id(),
    );

    if (field.health() <= MINEFIELD_DEPLETION_PER_HIT) {
      // Spent: the last mines are gone.
      field.delete(false);
    } else {
      field.modifyHealth(-MINEFIELD_DEPLETION_PER_HIT);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return MinefieldExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            tile: this.input.tile,
            density: this.input.density,
          },
      active: this.active,
      initialized: this.mg !== undefined,
      random: this.random === undefined ? null : w.random(this.random),
      field: this.field === null ? null : w.unit(this.field),
      shipTiles: [...this.shipTiles].map(([unit, tile]) => ({
        unit: w.unit(unit),
        tile,
      })),
      primed: this.primed,
    });
  }

  restoreSnapshot(s: MinefieldState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : {
            owner: r.player(s.input.owner),
            tile: s.input.tile,
            density: s.input.density,
          };
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    if (s.random !== null) this.random = r.random(s.random);
    this.field = s.field === null ? null : r.unit(s.field);
    this.shipTiles = new Map(
      s.shipTiles.map(({ unit, tile }) => [r.unit(unit), tile]),
    );
    this.primed = s.primed;
  }
}

const MinefieldStateSchema = z.object({
  /** An existing field, or the order to lay one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    // Validated in init, so a pending order may hold any tile or density.
    z.object({ owner: zPlayerRef(), tile: zInt(), density: zInt() }),
  ]),
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom().nullable(),
  field: zRef().nullable(),
  /** In insertion order. */
  shipTiles: z.array(z.object({ unit: zRef(), tile: zTile() })),
  primed: z.boolean(),
});
type MinefieldState = z.infer<typeof MinefieldStateSchema>;

export const MinefieldExecutionSnapshot = execSnapshotType({
  name: "Minefield",
  version: 1,
  schema: MinefieldStateSchema,
  cls: () => MinefieldExecution,
});
