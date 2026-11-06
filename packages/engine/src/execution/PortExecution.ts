import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  BLOCKADE_CHECK_INTERVAL,
  BLOCKADE_TRADE_SHIP_RATE_DIVISOR,
} from "@openfront/engine-lib/game/TradeRoutes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zRandom,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { portBlockader, refreshPortBlockade } from "../game/PortBlockade";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { TradeShipExecution } from "./TradeShipExecution";
import { TrainStationExecution } from "./TrainStationExecution";

export class PortExecution implements Execution {
  private active = true;
  private mg: Game;
  private port: Unit;
  private random: PseudoRandom;
  private checkOffset: number;
  private tradeShipSpawnRejections = 0;
  // Whether a warship at war blockaded the port at the last check.
  private blockaded = false;

  constructor(port: Unit) {
    this.port = port;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
    this.checkOffset = mg.ticks() % 10;
  }

  tick(ticks: number): void {
    if (this.mg === null || this.random === null || this.checkOffset === null) {
      throw new Error("Not initialized");
    }

    if (!this.port.isActive()) {
      this.active = false;
      return;
    }

    if (this.port.isUnderConstruction()) {
      return;
    }

    if (!this.port.hasTrainStation()) {
      this.createStation();
    }

    if ((this.mg.ticks() + this.checkOffset) % BLOCKADE_CHECK_INTERVAL === 0) {
      this.blockaded = refreshPortBlockade(this.mg, this.port, this.blockaded);
    }

    // Only check every 10 ticks for performance.
    if ((this.mg.ticks() + this.checkOffset) % 10 !== 0) {
      return;
    }

    // A blockaded port tries on one check in BLOCKADE_TRADE_SHIP_RATE_DIVISOR,
    // so it launches trade ships at that fraction of its rate (TradeRoutes).
    if (
      this.blockaded &&
      Math.floor((this.mg.ticks() + this.checkOffset) / 10) %
        BLOCKADE_TRADE_SHIP_RATE_DIVISOR !==
        0
    ) {
      return;
    }

    if (!this.shouldSpawnTradeShip()) {
      return;
    }

    const ports = this.tradingPorts();

    if (ports.length === 0) {
      return;
    }

    const port = this.random.randElement(ports);
    this.mg.addExecution(
      new TradeShipExecution(this.port.owner(), this.port, port),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  shouldSpawnTradeShip(): boolean {
    const numTradeShips = this.mg.unitCount(UnitType.TradeShip);
    const portLevels = this.port!.owner().unitCount(UnitType.Port);
    for (let i = 0; i < this.port!.level(); i++) {
      const spawnRate = this.mg
        .config()
        .tradeShipSpawnRate(
          this.tradeShipSpawnRejections,
          numTradeShips,
          portLevels,
        );
      if (this.random.chance(spawnRate)) {
        this.tradeShipSpawnRejections = 0;
        return true;
      }
      this.tradeShipSpawnRejections++;
    }
    return false;
  }

  createStation(): void {
    const nearbyFactory = this.mg.hasUnitNearby(
      this.port.tile()!,
      this.mg.config().trainStationMaxRange(),
      UnitType.Factory,
    );
    if (nearbyFactory) {
      this.mg.addExecution(new TrainStationExecution(this.port));
    }
  }

  // It's a probability list, so if an element appears twice it's because it's
  // twice more likely to be picked later.
  tradingPorts(): Unit[] {
    const sourceComponents = new Set<number>();
    for (const neighbor of this.mg.neighbors(this.port!.tile())) {
      if (!this.mg.isWater(neighbor)) continue;
      const comp = this.mg.getWaterComponent(neighbor);
      if (comp !== null) sourceComponents.add(comp);
    }
    const ports = this.mg
      .players()
      .filter((p) => p !== this.port!.owner() && p.canTrade(this.port!.owner()))
      .flatMap((p) => p.units(UnitType.Port))
      .filter((p) => {
        for (const comp of sourceComponents) {
          if (this.mg.hasWaterComponent(p.tile(), comp)) return true;
        }
        return false;
      })
      // Nobody picks a blockaded port as a destination.
      .filter((p) => portBlockader(this.mg, p) === null)
      .sort((p1, p2) => {
        return (
          this.mg.manhattanDist(this.port!.tile(), p1.tile()) -
          this.mg.manhattanDist(this.port!.tile(), p2.tile())
        );
      });

    const weightedPorts: Unit[] = [];

    for (const [i, otherPort] of ports.entries()) {
      const expanded = new Array(otherPort.level()).fill(otherPort);
      weightedPorts.push(...expanded);
      const tooClose =
        this.mg.manhattanDist(this.port!.tile(), otherPort.tile()) <
        this.mg.config().tradeShipShortRangeDebuff();
      const closeBonus =
        i < this.mg.config().proximityBonusPortsNb(ports.length);
      if (!tooClose && closeBonus) {
        // If the port is close, but not too close, add it again
        // to increase the chances of trading with it.
        weightedPorts.push(...expanded);
      }
      if (!tooClose && this.port!.owner().isFriendly(otherPort.owner())) {
        weightedPorts.push(...expanded);
      }
    }
    return weightedPorts;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    const initialized = this.mg !== undefined;
    return PortExecutionSnapshot.write({
      active: this.active,
      port: w.unit(this.port),
      init: initialized
        ? { random: w.random(this.random), checkOffset: this.checkOffset }
        : null,
      tradeShipSpawnRejections: this.tradeShipSpawnRejections,
      blockaded: this.blockaded,
    });
  }

  restoreSnapshot(s: PortState, r: SnapshotReader): void {
    this.active = s.active;
    this.port = r.unit(s.port);
    if (s.init !== null) {
      this.mg = r.game;
      this.random = r.random(s.init.random);
      this.checkOffset = s.init.checkOffset;
    }
    this.tradeShipSpawnRejections = s.tradeShipSpawnRejections;
    this.blockaded = s.blockaded;
  }
}

const PortStateSchema = z.object({
  active: z.boolean(),
  port: zRef(),
  // Set by init.
  init: z.object({ random: zRandom(), checkOffset: zInt() }).nullable(),
  tradeShipSpawnRejections: zInt(),
  blockaded: z.boolean(),
});
type PortState = z.infer<typeof PortStateSchema>;

export const PortExecutionSnapshot = execSnapshotType({
  name: "Port",
  // v2 added blockaded (naval blockades, see PortBlockade.ts).
  version: 2,
  migrations: {
    1: (d) => ({ ...(d as Record<string, unknown>), blockaded: false }),
  },
  schema: PortStateSchema,
  cls: () => PortExecution,
});
