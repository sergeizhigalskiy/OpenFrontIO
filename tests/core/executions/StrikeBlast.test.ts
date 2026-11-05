import { TileRef } from "@openfront/engine-api/game/GameMap";
import { TrainType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  CRUISE_MISSILE_BLAST_RADIUS,
  STRIKE_TARGET_TYPES,
} from "@openfront/engine-lib/game/ConventionalWar";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  order,
  runUntil,
  structure,
} from "../../util/ConventionalWar";
import { executeTicks } from "../../util/utils";

// half_land_half_ocean: 16x16, land at x 0-7, ocean at x 8-15. a holds
// x 0-1, its ally c x 2, the enemy b x 3-7 (the coast). The blasts land
// around (9, 8), just off b's coast.
async function coast(): Promise<{
  game: Game;
  a: Player;
  b: Player;
  c: Player;
}> {
  const { game, players } = await conventionalGame(
    "half_land_half_ocean",
    ["a", "b", "c"],
    { infiniteGold: true },
  );
  const [a, b, c] = players;
  conquerRect(game, a, 0, 0, 2, 16);
  conquerRect(game, c, 2, 0, 3, 16);
  conquerRect(game, b, 3, 0, 8, 16);
  a.createAllianceRequest(c)!.accept();
  return { game, a, b, c };
}

function warship(owner: Player, game: Game, x: number, y: number): Unit {
  const tile = game.ref(x, y);
  return owner.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}

/** Orders `type` at `tile` and ticks until it has landed. */
function strike(game: Game, a: Player, type: UnitType, tile: TileRef): Unit {
  order(game, a, type, tile);
  let flight: Unit | undefined;
  runUntil(
    game,
    () => {
      flight = game.units(type)[0];
      return flight !== undefined;
    },
    5,
  );
  expect(flight, `${type} took off`).toBeDefined();
  runUntil(game, () => !flight!.isActive(), 100);
  expect(flight!.reachedTarget()).toBe(true);
  return flight!;
}

describe("airstrike and cruise missile blasts", () => {
  test("lists every structure and ship, train and convoy, never a weapon or a minefield", () => {
    for (const type of [
      UnitType.City,
      UnitType.Port,
      UnitType.Factory,
      UnitType.SAMLauncher,
      UnitType.Warship,
      UnitType.TransportShip,
      UnitType.TradeShip,
      UnitType.Train,
      UnitType.Convoy,
    ]) {
      expect(STRIKE_TARGET_TYPES, type).toContain(type);
    }
    for (const type of [
      UnitType.Minefield,
      UnitType.Shell,
      UnitType.SAMMissile,
      UnitType.Drone,
      UnitType.Airstrike,
      UnitType.Airdrop,
      UnitType.CruiseMissile,
      UnitType.BallisticMissile,
      UnitType.ClusterMissile,
      UnitType.ClusterWarhead,
    ]) {
      expect(STRIKE_TARGET_TYPES, type).not.toContain(type);
    }
  });

  test("a cruise missile on water destroys the port, city and ships in its blast", async () => {
    const { game, a, b } = await coast();
    const silo = structure(game, a, UnitType.MissileSilo, game.ref(0, 0));
    const water = game.ref(9, 8);
    expect(game.isWater(water)).toBe(true);
    // Water is a target, as for a nuke.
    expect(a.canBuild(UnitType.CruiseMissile, water)).toBe(silo.tile());
    expect(CRUISE_MISSILE_BLAST_RADIUS).toBe(3);
    const port = structure(game, b, UnitType.Port, game.ref(7, 8));
    const city = structure(game, b, UnitType.City, game.ref(7, 10), 3);
    const ship = warship(b, game, 10, 8);
    const boat = b.buildUnit(UnitType.TransportShip, game.ref(9, 10), {
      troops: 1_000,
    });
    const trader = b.buildUnit(UnitType.TradeShip, game.ref(11, 8), {
      targetUnit: port,
    });
    const train = b.buildUnit(UnitType.Train, game.ref(6, 8), {
      trainType: TrainType.Engine,
    });
    // Out of the 3-tile blast.
    const farShip = warship(b, game, 13, 8);
    strike(game, a, UnitType.CruiseMissile, water);
    for (const unit of [port, city, ship, boat, trader, train]) {
      expect(unit.isActive(), unit.type()).toBe(false);
    }
    expect(farShip.isActive()).toBe(true);
  });

  test("an airstrike on unclaimed land launches and destroys enemy units there", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 40, 200);
    const base = structure(game, a, UnitType.Airbase, game.ref(30, 100));
    const empty = game.ref(100, 100);
    expect(game.hasOwner(empty)).toBe(false);
    expect(a.canBuild(UnitType.Airstrike, empty)).toBe(base.tile());
    // An enemy convoy crossing the empty land, in the blast.
    const convoy = b.buildUnit(UnitType.Convoy, game.ref(101, 100), {
      troops: 1_000,
      targetTile: game.ref(150, 150),
      targetPlayer: b,
    });
    strike(game, a, UnitType.Airstrike, empty);
    expect(convoy.isActive()).toBe(false);
    expect(base.isInCooldown()).toBe(true);
  });

  test("our own and our allies' units in the blast survive", async () => {
    const { game, a, b, c } = await coast();
    structure(game, a, UnitType.MissileSilo, game.ref(0, 0), 2);
    const base = structure(game, a, UnitType.Airbase, game.ref(1, 15));
    const enemy = warship(b, game, 9, 8);
    const own = warship(a, game, 9, 9);
    const allied = warship(c, game, 8, 9);
    const alliedPost = structure(game, c, UnitType.DefensePost, game.ref(2, 8));
    strike(game, a, UnitType.CruiseMissile, game.ref(8, 8));
    expect(enemy.isActive()).toBe(false);
    expect(own.isActive()).toBe(true);
    expect(allied.isActive()).toBe(true);
    const enemy2 = warship(b, game, 9, 7);
    expect(a.canBuild(UnitType.Airstrike, game.ref(9, 8))).toBe(base.tile());
    strike(game, a, UnitType.Airstrike, game.ref(9, 8));
    expect(enemy2.isActive()).toBe(false);
    expect(own.isActive()).toBe(true);
    expect(allied.isActive()).toBe(true);
    // c's post sat 6 tiles out of both blasts; it was never at risk.
    expect(alliedPost.isActive()).toBe(true);
  });

  test("units in flight and minefields in the blast survive", async () => {
    const { game, a, b } = await coast();
    structure(game, a, UnitType.MissileSilo, game.ref(0, 0));
    const ship = warship(a, game, 14, 14);
    const mines = b.buildUnit(UnitType.Minefield, game.ref(9, 9), {
      density: 50,
    });
    const drone = b.buildUnit(UnitType.Drone, game.ref(10, 8), {
      targetUnit: ship,
    });
    const plane = b.buildUnit(UnitType.Airstrike, game.ref(9, 7), {
      targetTile: game.ref(0, 15),
      trajectory: [],
    });
    const target = warship(b, game, 9, 8);
    strike(game, a, UnitType.CruiseMissile, game.ref(9, 8));
    executeTicks(game, 1);
    expect(target.isActive()).toBe(false);
    expect(mines.isActive()).toBe(true);
    expect(drone.isActive()).toBe(true);
    expect(plane.isActive()).toBe(true);
  });
});
