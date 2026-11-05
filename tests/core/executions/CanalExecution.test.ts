import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  CANAL_CONSTRUCTION_TICKS,
  CANAL_COST_PER_TILE,
  findCanalPath,
} from "@openfront/engine-lib/game/Canal";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
import {
  canalSearchDue,
  considerCanal,
} from "@openfront/engine/execution/nation/NationCanalBehavior";
import { TradeShipExecution } from "@openfront/engine/execution/TradeShipExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { canBuildTransportShip } from "@openfront/engine/game/TransportShipUtils";
import { snapshotGame } from "@openfront/engine/snapshot/GameSnapshot";
import {
  at,
  claim,
  digTwoLakes,
  tickUntilWaterRebuild,
} from "../../util/Canals";
import { setup } from "../../util/Setup";
import { diffSnapshots, roundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// Two lakes on `plains` with an 8-step neck of the builder's land (x 40..47)
// between them; the enemy holds the far shore of the east lake (x >= 68).
const NECK = { x: 44, y: 50 };

let game: Game;
let builder: Player;
let enemy: Player;

async function start(config: Partial<GameConfig> = {}): Promise<void> {
  game = await setup("plains", { disableNavMesh: false, ...config }, [
    new PlayerInfo("builder", PlayerType.Human, "client1", "builder_id"),
    new PlayerInfo("enemy", PlayerType.Human, "client2", "enemy_id"),
  ]);
  builder = game.player("builder_id");
  enemy = game.player("enemy_id");
  digTwoLakes(game);
  claim(game, builder, 0, 0, 47, 99);
  claim(game, enemy, 68, 0, 99, 99);
}

function neckTile(): TileRef {
  return at(game, NECK.x, NECK.y);
}

function canalPathTiles(): TileRef[] {
  const found = findCanalPath(game.map(), neckTile());
  if (!found.ok) throw new Error(`no canal path: ${found.reason}`);
  return found.path.tiles;
}

function digCanal(): void {
  game.addExecution(
    new ConstructionExecution(builder, UnitType.Canal, neckTile()),
  );
}

/** Ticks until no canal unit is left (done or cancelled). */
function tickUntilNoCanal(maxTicks: number): number {
  for (let i = 1; i <= maxTicks; i++) {
    game.executeNextTick();
    if (game.units(UnitType.Canal).length === 0 && i > 2) return i;
  }
  throw new Error("canal still digging");
}

/** Builds a finished canal through the neck and waits for the water graph. */
function finishedCanal(): TileRef[] {
  const tiles = canalPathTiles();
  digCanal();
  executeTicks(game, 4);
  for (const t of tiles) expect(game.isWater(t)).toBe(true);
  tickUntilWaterRebuild(game);
  return tiles;
}

/** Lets go of every builder tile on the neck, so their only shore is west. */
function leaveNeck(): void {
  for (const t of [...builder.tiles()]) {
    if (game.x(t) >= 40) builder.relinquish(t);
  }
}

/** Ticks while `unit` lives, recording its tiles. */
function follow(unit: Unit, maxTicks: number): TileRef[] {
  const tiles: TileRef[] = [];
  for (let i = 0; i < maxTicks && unit.isActive(); i++) {
    tiles.push(unit.tile());
    game.executeNextTick();
  }
  return tiles;
}

describe("digging a canal", () => {
  test("the build menu prices it per step and offers it only on a valid neck", async () => {
    await start();
    builder.addGold(10_000_000n);
    const [canal] = builder.buildableUnits(neckTile(), [UnitType.Canal]);
    expect(canal.cost).toBe(BigInt(CANAL_COST_PER_TILE * 8));
    expect(canal.canBuild).toBe(neckTile());
    // No neck far from the lakes.
    const [none] = builder.buildableUnits(at(game, 5, 5), [UnitType.Canal]);
    expect(none.canBuild).toBe(false);
  });

  test("a second click on a canal being dug doesn't pay for it twice", async () => {
    await start();
    builder.addGold(10_000_000n);
    digCanal();
    executeTicks(game, 2);
    const gold = builder.gold();
    digCanal();
    executeTicks(game, 2);
    expect(builder.units(UnitType.Canal)).toHaveLength(1);
    expect(builder.gold()).toBe(gold);
    expect(builder.canBuild(UnitType.Canal, neckTile())).toBe(false);
  });

  test("can't be dug without the gold for its whole length", async () => {
    await start();
    builder.addGold(BigInt(CANAL_COST_PER_TILE * 8 - 1) - builder.gold());
    expect(builder.canBuild(UnitType.Canal, neckTile())).toBe(false);
    builder.addGold(1n);
    expect(builder.canBuild(UnitType.Canal, neckTile())).toBe(neckTile());
  });

  test("charges the price, digs for 60 s, then turns the path into water", async () => {
    await start({ waterNukes: false });
    builder.addGold(5_000_000n);
    const before = builder.gold();
    const tiles = canalPathTiles();
    digCanal();
    executeTicks(game, 2);

    const [canal] = builder.units(UnitType.Canal);
    expect(canal).toBeDefined();
    expect(canal.isUnderConstruction()).toBe(true);
    expect(builder.gold()).toBeLessThanOrEqual(
      before - BigInt(CANAL_COST_PER_TILE * 8) + 1_000n,
    );
    expect(builder.gold()).toBeGreaterThanOrEqual(
      before - BigInt(CANAL_COST_PER_TILE * 8),
    );

    executeTicks(game, CANAL_CONSTRUCTION_TICKS - 10);
    for (const t of tiles) expect(game.isLand(t)).toBe(true);
    expect(builder.units(UnitType.Canal)).toHaveLength(1);

    executeTicks(game, 20);
    expect(builder.units(UnitType.Canal)).toHaveLength(0);
    // Water even without water nukes, and nobody owns it.
    for (const t of tiles) {
      expect(game.isWater(t)).toBe(true);
      expect(game.hasOwner(t)).toBe(false);
      expect(game.hasFallout(t)).toBe(false);
    }
  });

  test("is cancelled with no refund when the builder loses a path tile", async () => {
    await start();
    builder.addGold(5_000_000n);
    const tiles = canalPathTiles();
    digCanal();
    executeTicks(game, 2);
    expect(builder.units(UnitType.Canal)).toHaveLength(1);
    const afterCharge = builder.gold();

    executeTicks(game, 100);
    enemy.conquer(tiles[0]);
    executeTicks(game, 2);
    expect(builder.units(UnitType.Canal)).toHaveLength(0);
    // Passive income only: nothing came back.
    expect(builder.gold() - afterCharge).toBeLessThan(
      BigInt(CANAL_COST_PER_TILE),
    );
    executeTicks(game, CANAL_CONSTRUCTION_TICKS);
    for (const t of tiles.slice(1)) expect(game.isLand(t)).toBe(true);
  });

  test("ends on its own when it completes", async () => {
    await start({ instantBuild: true, infiniteGold: true });
    const tiles = canalPathTiles();
    digCanal();
    const ticks = tickUntilNoCanal(20);
    expect(ticks).toBeLessThan(20);
    executeTicks(game, 2);
    for (const t of tiles) expect(game.isWater(t)).toBe(true);
  });
});

describe("ships use the new water once the water graph is rebuilt", () => {
  test("a transport ship crosses to the far lake", async () => {
    await start({ instantBuild: true, infiniteGold: true });
    builder.setTroops(100_000);
    const dst = at(game, 68, 50);

    const tiles = finishedCanal();
    leaveNeck();
    expect(canBuildTransportShip(game, builder, dst)).not.toBe(false);

    game.addExecution(new TransportShipExecution(builder, dst, 10_000));
    executeTicks(game, 2);
    const [boat] = builder.units(UnitType.TransportShip);
    expect(boat).toBeDefined();
    expect(game.x(boat.tile())).toBeLessThan(40);
    const route = follow(boat, 400);
    const canal = new Set(tiles);
    expect(route.some((t) => canal.has(t))).toBe(true);
    expect(route.some((t) => game.x(t) >= 48)).toBe(true);
    expect(boat.isActive()).toBe(false);
  });

  test("without a canal no transport ship can make that trip", async () => {
    await start({ instantBuild: true, infiniteGold: true });
    builder.setTroops(100_000);
    leaveNeck();
    expect(canBuildTransportShip(game, builder, at(game, 68, 50))).toBe(false);
  });

  test("a trade ship sails through to a port on the far lake", async () => {
    await start({ instantBuild: true, infiniteGold: true });
    const tiles = finishedCanal();
    const westPort = builder.buildUnit(UnitType.Port, at(game, 19, 50), {});
    const eastPort = enemy.buildUnit(UnitType.Port, at(game, 68, 50), {});
    const exec = new TradeShipExecution(builder, westPort, eastPort);
    game.addExecution(exec);
    executeTicks(game, 2);
    const [ship] = builder.units(UnitType.TradeShip);
    expect(ship).toBeDefined();
    const route = follow(ship, 400);
    const canal = new Set(tiles);
    expect(route.some((t) => canal.has(t))).toBe(true);
    expect(ship.isActive()).toBe(false);
    expect(exec.isActive()).toBe(false);
    expect(builder.tradeGold()).toBeGreaterThan(0n);
  });

  test("a warship moves through into the far lake", async () => {
    await start({ instantBuild: true, infiniteGold: true });
    const tiles = finishedCanal();
    builder.buildUnit(UnitType.Port, at(game, 19, 50), {});
    game.addExecution(
      new WarshipExecution({ owner: builder, patrolTile: at(game, 25, 50) }),
    );
    executeTicks(game, 2);
    const [warship] = builder.units(UnitType.Warship);
    expect(warship).toBeDefined();

    game.addExecution(
      new MoveWarshipExecution(builder, [warship.id()], at(game, 60, 50)),
    );
    const canal = new Set(tiles);
    let crossed = false;
    for (let i = 0; i < 300 && game.x(warship.tile()) < 55; i++) {
      game.executeNextTick();
      if (canal.has(warship.tile())) crossed = true;
    }
    expect(crossed).toBe(true);
    expect(game.x(warship.tile())).toBeGreaterThanOrEqual(55);
  });

  test("without a canal the trade ship and warship stay in the west lake", async () => {
    await start({ instantBuild: true, infiniteGold: true });
    leaveNeck();
    tickUntilWaterRebuild(game);
    const westPort = builder.buildUnit(UnitType.Port, at(game, 19, 50), {});
    const eastPort = enemy.buildUnit(UnitType.Port, at(game, 68, 50), {});
    game.addExecution(new TradeShipExecution(builder, westPort, eastPort));
    game.addExecution(
      new WarshipExecution({ owner: builder, patrolTile: at(game, 25, 50) }),
    );
    executeTicks(game, 2);
    const [warship] = builder.units(UnitType.Warship);
    game.addExecution(
      new MoveWarshipExecution(builder, [warship.id()], at(game, 60, 50)),
    );
    let farthest = 0;
    for (let i = 0; i < 200; i++) {
      game.executeNextTick();
      for (const u of builder.units(UnitType.TradeShip, UnitType.Warship)) {
        farthest = Math.max(farthest, game.x(u.tile()));
      }
    }
    expect(farthest).toBeLessThan(40);
    expect(builder.tradeGold()).toBe(0n);
  });
});

/**
 * Snapshot -> restore -> snapshot is byte-identical and both games stay on
 * the same hash and bytes for `ticks` ticks. (Not expectSnapshotRoundTrip:
 * after water conversions the WaterManager's scratch buffers and a graph
 * awaiting its throttled rebuild differ by design, see its restoreSnapshot.)
 */
async function expectCanalRoundTrip(ticks: number): Promise<Game> {
  const { bytes, restored, again } = await roundTrip(game, "plains");
  expect(diffSnapshots(bytes, again)).toEqual([]);
  const hash = (g: Game) => (g as unknown as { hash(): number }).hash();
  for (let i = 0; i < ticks; i++) {
    game.executeNextTick();
    restored.executeNextTick();
    expect(hash(restored), `tick ${i + 1}`).toBe(hash(game));
  }
  expect(diffSnapshots(snapshotGame(game), snapshotGame(restored))).toEqual([]);
  return restored;
}

describe("canal snapshots", () => {
  test("a dig mid-construction and a pending one restore", async () => {
    await start({ infiniteGold: true });
    tickUntilWaterRebuild(game);
    digCanal();
    executeTicks(game, 50);
    expect(builder.units(UnitType.Canal)).toHaveLength(1);
    // Queued, not yet initialized (it will find the neck already dug into).
    digCanal();
    const restored = await expectCanalRoundTrip(30);
    expect(restored.units(UnitType.Canal)).toHaveLength(1);
  });

  test("a dig that is flooding and a finished canal restore", async () => {
    await start({ infiniteGold: true, instantBuild: true });
    tickUntilWaterRebuild(game);
    const tiles = canalPathTiles();
    digCanal();
    executeTicks(game, 2);
    const restored = await expectCanalRoundTrip(10);
    for (const t of tiles) expect(restored.isWater(t)).toBe(true);
  });
});

describe("nations dig canals", () => {
  async function nationStart(difficulty: Difficulty, gold: bigint) {
    game = await setup("plains", { difficulty }, [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
    ]);
    builder = game.player("nation_id");
    digTwoLakes(game);
    claim(game, builder, 0, 0, 47, 99);
    builder.addGold(gold);
    // Nations search once a minute; wait for this one's window.
    while (!canalSearchDue(game, builder)) game.executeNextTick();
  }

  test.each([Difficulty.Hard, Difficulty.Impossible])(
    "%s nations dig across a neck of their own land when rich",
    async (difficulty) => {
      await nationStart(difficulty, 10_000_000n);
      considerCanal(game, builder);
      executeTicks(game, 3);
      const [canal] = builder.units(UnitType.Canal);
      expect(canal).toBeDefined();
      // Only one dig at a time.
      considerCanal(game, builder);
      executeTicks(game, 3);
      expect(builder.units(UnitType.Canal)).toHaveLength(1);
    },
  );

  test.each([Difficulty.Easy, Difficulty.Medium])(
    "%s nations never do",
    async (difficulty) => {
      await nationStart(difficulty, 100_000_000n);
      considerCanal(game, builder);
      executeTicks(game, 3);
      expect(builder.units(UnitType.Canal)).toHaveLength(0);
    },
  );

  test("not unless they can easily afford it", async () => {
    // An 8-step canal costs 1.2M; easily affording it takes 3.6M.
    await nationStart(Difficulty.Impossible, 3_000_000n);
    considerCanal(game, builder);
    executeTicks(game, 3);
    expect(builder.units(UnitType.Canal)).toHaveLength(0);
  });
});
