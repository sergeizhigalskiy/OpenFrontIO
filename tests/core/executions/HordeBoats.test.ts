import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_BOAT_EXPOSED_TILE_COST,
  HORDE_BOAT_REPLAN_TICKS,
  HORDE_BOAT_SHELL_LOSS_PERCENT,
  HORDE_DEFENDERS_TEAM,
  HORDE_TEAM,
  hordeBoatShellLoss,
  mayShootHordeBoat,
} from "@openfront/engine-lib/game/HordeNight";
import {
  HordeBoatPathFinder,
  hordeBoatRoute,
  hordeRouteCost,
  hordeRouteExposure,
} from "@openfront/engine/execution/HordeBoats";
import { HordeNightExecution } from "@openfront/engine/execution/HordeNightExecution";
import { ShellExecution } from "@openfront/engine/execution/ShellExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";
import { createGame, L, W } from "../pathfinding/_fixtures";

// A 400x300 sea with a strip of land along the west edge (x 0-39): the
// human a holds its middle (y 100-199), the human b its north, the nation n
// its south.
const WIDTH = 400;
const HEIGHT = 300;
const COAST_X = 39;

function seaGame(): {
  game: Game;
  a: Player;
  b: Player;
  n: Player;
  band: Player;
} {
  const grid: string[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) grid.push(x <= COAST_X ? L : W);
  }
  const game = createGame(
    { width: WIDTH, height: HEIGHT, grid },
    { hordeNight: { enabled: true, survivalMinutes: 25 } },
  );
  const human = (id: string) =>
    game.addPlayer(
      new PlayerInfo(id, PlayerType.Human, `c_${id}`, id),
      HORDE_DEFENDERS_TEAM,
    );
  const a = human("a");
  const b = human("b");
  const n = game.addPlayer(
    new PlayerInfo("n", PlayerType.Nation, null, "n"),
    HORDE_DEFENDERS_TEAM,
  );
  const band = game.addPlayer(
    new PlayerInfo("band", PlayerType.Bot, null, "band"),
    HORDE_TEAM,
  );
  conquerRect(game, b, 0, 0, COAST_X + 1, 100);
  conquerRect(game, a, 0, 100, COAST_X + 1, 200);
  conquerRect(game, n, 0, 200, COAST_X + 1, HEIGHT);
  for (const p of [a, b, n]) p.setTroops(100_000);
  game.endSpawnPhase();
  return { game, a, b, n, band };
}

function warship(game: Game, owner: Player, x: number, y: number): Unit {
  const tile = game.ref(x, y);
  return owner.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}

/** A band's boat sitting still at (x, y), sailing at `aimedAt`. */
function hordeBoat(
  game: Game,
  band: Player,
  aimedAt: Player,
  x: number,
  y: number,
  troops = 1_000,
): Unit {
  band.setTroops(troops);
  return band.buildUnit(UnitType.TransportShip, game.ref(x, y), {
    troops,
    targetTile: game.ref(COAST_X, 150),
    targetPlayer: aimedAt,
  });
}

function targetOf(game: Game, ship: Unit): Unit | undefined {
  const exec = new WarshipExecution(ship);
  exec.init(game, game.ticks());
  return (exec as any).findTargetUnit();
}

describe("who may shoot a horde boat", () => {
  test("the rule: its target's own warships, and between humans each other's", () => {
    const human = { type: () => PlayerType.Human };
    const other = { type: () => PlayerType.Human };
    const nation = { type: () => PlayerType.Nation };
    expect(mayShootHordeBoat(human, human)).toBe(true);
    expect(mayShootHordeBoat(other, human)).toBe(true);
    expect(mayShootHordeBoat(nation, human)).toBe(false);
    expect(mayShootHordeBoat(nation, nation)).toBe(true);
    expect(mayShootHordeBoat(human, nation)).toBe(false);
    expect(mayShootHordeBoat(human, null)).toBe(false);
  });

  test("a nation's warship ignores a boat sent at the human; the human's and a second human's shoot it", () => {
    const { game, a, b, n, band } = seaGame();
    const boat = hordeBoat(game, band, a, 200, 150);
    expect(targetOf(game, warship(game, n, 205, 150))).toBeUndefined();
    expect(targetOf(game, warship(game, a, 205, 155))).toBe(boat);
    expect(targetOf(game, warship(game, b, 205, 145))).toBe(boat);
  });

  test("a boat sent at the nation: its own warship shoots, a human's doesn't", () => {
    const { game, b, n, band } = seaGame();
    const boat = hordeBoat(game, band, n, 200, 250);
    expect(targetOf(game, warship(game, b, 205, 250))).toBeUndefined();
    expect(targetOf(game, warship(game, n, 205, 245))).toBe(boat);
  });

  test("a boat a landed band launches sails at the player it attacks", () => {
    const { game, a, band } = seaGame();
    // The band holds a patch of the coast to sail from.
    conquerRect(game, band, 0, 120, COAST_X + 1, 125);
    band.setTroops(10_000);
    game.addExecution(
      new TransportShipExecution(band, game.ref(COAST_X, 180), 5_000),
    );
    executeTicks(game, 1);
    const [boat] = band.units(UnitType.TransportShip);
    expect(boat).toBeDefined();
    expect(boat.targetPlayer()).toBe(a);
  });
});

describe("horde boat armour", () => {
  test("a hit kills 10% of the troops aboard, rounded up", () => {
    expect(HORDE_BOAT_SHELL_LOSS_PERCENT).toBe(10);
    expect(hordeBoatShellLoss(1_000)).toBe(100);
    expect(hordeBoatShellLoss(901)).toBe(91);
    expect(hordeBoatShellLoss(1)).toBe(1);
  });

  test("one shell every 2 s, each taking a tenth: the boat sails on", () => {
    const { game, a, band } = seaGame();
    const boat = hordeBoat(game, band, a, 200, 150);
    game.addExecution(new WarshipExecution(warship(game, a, 203, 150)));
    const fired: number[] = [];
    const add = game.addExecution.bind(game);
    vi.spyOn(game, "addExecution").mockImplementation((...execs) => {
      for (const e of execs) {
        if (e instanceof ShellExecution) fired.push(game.ticks());
      }
      add(...execs);
    });
    const troops: number[] = [];
    for (let i = 0; i < 100; i++) {
      executeTicks(game, 1);
      if (boat.troops() !== (troops[troops.length - 1] ?? 1_000)) {
        troops.push(boat.troops());
      }
    }
    expect(boat.isActive()).toBe(true);
    expect(troops.slice(0, 3)).toEqual([900, 810, 729]);
    // The warship's reload: a shell every 21 ticks, as at a warship.
    expect(fired.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i] - fired[i - 1]).toBe(21);
    }
  });

  test("other transport ships still go down to one shell", () => {
    const { game, a } = seaGame();
    const raider = game.addPlayer(
      new PlayerInfo("raider", PlayerType.Bot, null, "raider"),
    );
    raider.setTroops(1_000);
    const boat = raider.buildUnit(UnitType.TransportShip, game.ref(200, 150), {
      troops: 1_000,
      targetTile: game.ref(COAST_X, 150),
    });
    game.addExecution(new WarshipExecution(warship(game, a, 203, 150)));
    // Past the first reload and the shell flight.
    executeTicks(game, 40);
    expect(boat.isActive()).toBe(false);
  });
});

describe("horde boat evasion", () => {
  const from = (game: Game) => game.ref(WIDTH - 1, 150);
  const to = (game: Game) => game.ref(COAST_X, 150);

  test("detours around a warship's reach when open water allows", () => {
    const { game } = seaGame();
    const threats = [game.ref(220, 150)];
    const direct = hordeBoatRoute(game, from(game), to(game), [])!;
    const route = hordeBoatRoute(game, from(game), to(game), threats)!;
    expect(hordeRouteExposure(game, direct, threats)).toBeGreaterThan(200);
    expect(route[route.length - 1]).toBe(to(game));
    // Around the top or bottom of the 130-tile reach: next to no exposure,
    // and far cheaper at 8 per exposed tile.
    expect(hordeRouteExposure(game, route, threats)).toBeLessThan(10);
    expect(HORDE_BOAT_EXPOSED_TILE_COST).toBe(8);
    expect(hordeRouteCost(game, route, threats)).toBeLessThan(
      hordeRouteCost(game, direct, threats) / 2,
    );
  });

  test("goes straight through, the least exposed way, when there is no way around", () => {
    const { game } = seaGame();
    // Right off the landing: every approach is in reach.
    const threats = [game.ref(60, 150)];
    const direct = hordeBoatRoute(game, from(game), to(game), [])!;
    const route = hordeBoatRoute(game, from(game), to(game), threats)!;
    expect(route).not.toBeNull();
    expect(route[route.length - 1]).toBe(to(game));
    const exposed = hordeRouteExposure(game, route, threats);
    expect(exposed).toBeGreaterThan(0);
    expect(exposed).toBeLessThanOrEqual(
      hordeRouteExposure(game, direct, threats),
    );
    // No wandering: about as long as the straight route.
    expect(route.length).toBeLessThan(direct.length * 1.5);
  });

  test("re-plans when a warship moves into its path", () => {
    const { game, a, band } = seaGame();
    band.setTroops(1_000);
    // a's warship starts far off the boat's line.
    const ship = warship(game, a, WIDTH - 20, HEIGHT - 5);
    const exec = TransportShipExecution.fromSea(
      band,
      from(game),
      to(game),
      1_000,
    );
    game.addExecution(exec);
    executeTicks(game, 5);
    const pf = (exec as any).pathFinder as HordeBoatPathFinder;
    expect(pf).toBeInstanceOf(HordeBoatPathFinder);
    const boat = band.units(UnitType.TransportShip)[0];
    const rest = () => pf.pathForTraversal(boat.tile(), to(game));
    const plans = (exec as any).motionPlanId as number;
    // The boat sails straight at the coast.
    const blocking = game.ref(250, 150);
    expect(hordeRouteExposure(game, rest(), [blocking])).toBeGreaterThan(100);
    ship.move(blocking);
    executeTicks(game, HORDE_BOAT_REPLAN_TICKS + 1);
    expect((exec as any).motionPlanId).toBeGreaterThan(plans);
    expect(hordeRouteExposure(game, rest(), [blocking])).toBeLessThan(10);
  });

  test("the sea route's cost picks the landing: away from the warship", () => {
    const { game, a } = seaGame();
    const horde = new HordeNightExecution("horde-boats");
    horde.init(game);
    const edge = (horde as any).edgeOcean() as TileRef[];
    // Without a warship, the coast nearest the map edge: either end of a's.
    const plain = horde.landingsFor(a, 1, [], edge);
    expect(plain).toHaveLength(1);
    expect(plain[0].kind).toBe("boat");
    // a's warship guards the north end: the boat lands at the south end.
    warship(game, a, 60, 90);
    const [landing] = horde.landingsFor(a, 1, [], edge);
    expect(landing.kind).toBe("boat");
    const landed = (landing as { to: TileRef }).to;
    expect(game.y(landed)).toBeGreaterThan(150);
  });
});

describe("horde boat snapshots", () => {
  test("a horde boat under fire round-trips", async () => {
    // half_land_half_ocean: 16x16, land at x 0-7, ocean at x 8-15.
    const game = await setup(
      "half_land_half_ocean",
      { hordeNight: { enabled: true, survivalMinutes: 25 } },
      [new PlayerInfo("a", PlayerType.Human, "c_a", "a")],
    );
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 8, 16);
    a.setTroops(100_000);
    const band = game.addPlayer(
      new PlayerInfo("band", PlayerType.Bot, null, "band"),
      HORDE_TEAM,
    );
    band.setTroops(5_000);
    game.addExecution(
      TransportShipExecution.fromSea(
        band,
        game.ref(15, 0),
        game.ref(7, 15),
        5_000,
      ),
      new WarshipExecution(warship(game, a, 12, 8)),
    );
    executeTicks(game, 8);
    expect(band.units(UnitType.TransportShip)).toHaveLength(1);
    await expectSnapshotRoundTrip(game, "half_land_half_ocean", 30);
  }, 60_000);
});
