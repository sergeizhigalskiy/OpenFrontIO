import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MINEFIELD_DEFAULT_DENSITY,
  Tick,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { UnitTypeSchema } from "../snapshot/CommonSchemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AirbaseExecution } from "./AirbaseExecution";
import { AirMissionExecution } from "./AirMissionExecution";
import { CanalExecution } from "./CanalExecution";
import { CityExecution } from "./CityExecution";
import { CoastalBatteryExecution } from "./CoastalBatteryExecution";
import { DefensePostExecution } from "./DefensePostExecution";
import { DroneSwarmExecution } from "./DroneExecution";
import { FactoryExecution } from "./FactoryExecution";
import { FlakGunExecution } from "./FlakGunExecution";
import { MinefieldExecution } from "./MinefieldExecution";
import { MirvExecution } from "./MIRVExecution";
import { MissileSiloExecution } from "./MissileSiloExecution";
import { NukeExecution } from "./NukeExecution";
import { PortExecution } from "./PortExecution";
import { SAMLauncherExecution } from "./SAMLauncherExecution";
import { WarshipExecution } from "./WarshipExecution";

export class ConstructionExecution implements Execution {
  private structure: Unit | null = null;
  private active: boolean = true;
  private mg: Game;

  private ticksUntilComplete: Tick;

  constructor(
    private player: Player,
    private constructionType: UnitType,
    private tile: TileRef,
    private rocketDirectionUp?: boolean,
    private amount?: number,
    /** Minefields only: the density (integer percent) to lay it with. */
    private density?: number,
    /** Airdrops only: the troops to drop (capped by AirMissionExecution). */
    private troops?: number,
    /** Drones only: the swarm size (clamped by DroneSwarmExecution). */
    private count?: number,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (this.mg.config().isUnitDisabled(this.constructionType)) {
      console.warn(
        `cannot build construction ${this.constructionType} because it is disabled`,
      );
      this.active = false;
      return;
    }

    if (!this.mg.isValidRef(this.tile)) {
      console.warn(`cannot build construction invalid tile ${this.tile}`);
      this.active = false;
      return;
    }
  }

  tick(ticks: number): void {
    if (this.structure === null) {
      const info = this.mg.unitInfo(this.constructionType);
      // For non-structure units (nukes/warship), charge once and delegate to specialized executions.
      const isStructure = this.isStructure(this.constructionType);
      if (!isStructure) {
        // Defer validation and gold deduction to the specific execution
        this.completeConstruction();
        this.active = false;
        return;
      }

      // Structures: build real unit and mark under construction
      const spawnTile = this.player.canBuild(this.constructionType, this.tile);
      if (spawnTile === false) {
        console.warn(`cannot build ${this.constructionType}`);
        this.active = false;
        return;
      }
      this.structure = this.player.buildUnit(
        this.constructionType,
        spawnTile,
        {},
      );
      const duration = info.constructionDuration ?? 0;
      if (duration > 0) {
        this.structure.setUnderConstruction(true);
        this.ticksUntilComplete = duration;
        return;
      }
      // No construction time
      this.completeConstruction();
      this.active = false;
      return;
    }

    if (!this.structure.isActive()) {
      this.active = false;
      return;
    }

    if (this.player !== this.structure.owner()) {
      this.player = this.structure.owner();
    }

    if (this.ticksUntilComplete === 0) {
      this.player = this.structure.owner();
      this.completeConstruction();
      this.active = false;
      return;
    }
    this.ticksUntilComplete--;
  }

  private completeConstruction() {
    if (this.structure) {
      this.structure.setUnderConstruction(false);
    }
    const player = this.player;
    switch (this.constructionType) {
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb: {
        const count = this.amount ?? 1;
        for (let i = 0; i < count; i++) {
          // NukeExecution staggers same-tick launches per silo itself.
          this.mg.addExecution(
            new NukeExecution(
              this.constructionType,
              player,
              this.tile,
              null,
              -1,
              0,
              this.rocketDirectionUp,
            ),
          );
        }
        break;
      }
      case UnitType.MIRV:
        this.mg.addExecution(new MirvExecution(player, this.tile));
        break;
      case UnitType.Warship:
        this.mg.addExecution(
          new WarshipExecution({ owner: player, patrolTile: this.tile }),
        );
        break;
      case UnitType.Minefield:
        // Laid at once; MinefieldExecution validates and charges for it.
        this.mg.addExecution(
          new MinefieldExecution({
            owner: player,
            tile: this.tile,
            density: this.density ?? MINEFIELD_DEFAULT_DENSITY,
          }),
        );
        break;
      case UnitType.CoastalBattery:
        this.mg.addExecution(new CoastalBatteryExecution(this.structure!));
        break;
      case UnitType.Airbase:
        this.mg.addExecution(new AirbaseExecution(this.structure!));
        break;
      case UnitType.FlakGun:
        this.mg.addExecution(new FlakGunExecution(this.structure!));
        break;
      case UnitType.Drone:
        // The swarm validates and charges each drone as it takes off.
        this.mg.addExecution(
          new DroneSwarmExecution(player, this.tile, this.count ?? 1),
        );
        break;
      case UnitType.Airstrike:
      case UnitType.Airdrop:
      case UnitType.CruiseMissile:
      case UnitType.BallisticMissile:
      case UnitType.ClusterMissile:
        // AirMissionExecution validates and charges at takeoff.
        this.mg.addExecution(
          new AirMissionExecution(
            this.constructionType,
            player,
            this.tile,
            this.constructionType === UnitType.Airdrop
              ? (this.troops ?? null)
              : null,
          ),
        );
        break;
      case UnitType.Port:
        this.mg.addExecution(new PortExecution(this.structure!));
        break;
      case UnitType.MissileSilo:
        this.mg.addExecution(new MissileSiloExecution(this.structure!));
        break;
      case UnitType.DefensePost:
        this.mg.addExecution(new DefensePostExecution(this.structure!));
        break;
      case UnitType.SAMLauncher:
        this.mg.addExecution(
          new SAMLauncherExecution(player, null, this.structure!),
        );
        break;
      case UnitType.City:
        this.mg.addExecution(new CityExecution(this.structure!));
        break;
      case UnitType.Factory:
        this.mg.addExecution(new FactoryExecution(this.structure!));
        break;
      case UnitType.Canal:
        // CanalExecution finds the path, validates and charges for it.
        this.mg.addExecution(new CanalExecution(player, this.tile));
        break;
      default:
        console.warn(
          `unit type ${this.constructionType} cannot be constructed`,
        );
        break;
    }
  }

  private isStructure(type: UnitType): boolean {
    switch (type) {
      case UnitType.Port:
      case UnitType.MissileSilo:
      case UnitType.DefensePost:
      case UnitType.SAMLauncher:
      case UnitType.City:
      case UnitType.Factory:
      case UnitType.CoastalBattery:
      case UnitType.Airbase:
      case UnitType.FlakGun:
        return true;
      default:
        return false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ConstructionExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      constructionType: this.constructionType,
      tile: this.tile,
      rocketDirectionUp: this.rocketDirectionUp,
      amount: this.amount,
      density: this.density,
      troops: this.troops,
      count: this.count,
      structure: w.unitOrNull(this.structure),
      ticksUntilComplete: this.ticksUntilComplete,
    });
  }

  restoreSnapshot(s: ConstructionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.constructionType = s.constructionType;
    this.tile = s.tile;
    this.rocketDirectionUp = s.rocketDirectionUp;
    this.amount = s.amount;
    this.density = s.density;
    this.troops = s.troops;
    this.count = s.count;
    this.structure = r.unitOrNull(s.structure);
    this.ticksUntilComplete = s.ticksUntilComplete as Tick;
  }
}

const ConstructionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  constructionType: UnitTypeSchema,
  // Validated in init, so a pending execution may hold any number.
  tile: zInt(),
  rocketDirectionUp: z.boolean().optional(),
  amount: zInt().optional(),
  /** Added in v2 (minefields); absent for every other construction. */
  density: zInt().optional(),
  /** Added in v3 (airdrops); absent for every other construction. */
  troops: zNum().optional(),
  /** Added in v3 (drone swarms); absent for every other construction. */
  count: zInt().optional(),
  structure: zRef().nullable(),
  // Unset until a structure with a build time is placed.
  ticksUntilComplete: zInt().optional(),
});
type ConstructionState = z.infer<typeof ConstructionStateSchema>;

export const ConstructionExecutionSnapshot = execSnapshotType({
  name: "Construction",
  version: 3,
  schema: ConstructionStateSchema,
  // v2 added the optional minefield density and v3 the optional airdrop
  // troops and drone swarm count; older records never had them.
  migrations: { 1: (d) => d, 2: (d) => d },
  cls: () => ConstructionExecution,
});
