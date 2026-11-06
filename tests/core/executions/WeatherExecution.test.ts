import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  WeatherCell,
  WeatherKind,
} from "@openfront/engine-api/game/GameUpdates";
import { unpackMotionPlans } from "@openfront/engine-lib/game/MotionPlans";
import {
  fogHidesTroops,
  MUD_TILE_COST_MULTIPLIER,
  stormTroopLoss,
  WEATHER_DRIFT_PER_TICK,
  WEATHER_MAX_ACTIVE_TICKS,
  WEATHER_MAX_CELLS,
  WEATHER_MAX_RADIUS,
  WEATHER_MIN_ACTIVE_TICKS,
  WEATHER_MIN_CELLS,
  WEATHER_MIN_RADIUS,
  WEATHER_WARNING_TICKS,
} from "@openfront/engine-lib/game/Weather";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConvoyExecution } from "@openfront/engine/execution/ConvoyExecution";
import { TradeShipExecution } from "@openfront/engine/execution/TradeShipExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { WeatherExecution } from "@openfront/engine/execution/WeatherExecution";
import { Game } from "@openfront/engine/game/Game";
import { describe, expect, it } from "vitest";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

const human = (id: string) => new PlayerInfo(id, PlayerType.Human, null, id);

/** A cell in effect from tick 0 that never drifts or ends. */
function cell(c: Partial<WeatherCell>): WeatherCell {
  return {
    id: 1,
    kind: WeatherKind.Fog,
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    radius: 10,
    announceTick: 0,
    activeTick: 0,
    endTick: 1_000_000,
    ...c,
  };
}

/** Scripted weather: `cells` and nothing else, registered on the game. */
function scripted(game: Game, ...cells: Partial<WeatherCell>[]) {
  const weather = new WeatherExecution(1, false);
  game.addExecution(weather);
  game.executeNextTick(); // inits it, so it registers
  cells.forEach((c, i) => weather.addCell(cell({ id: i + 1, ...c })));
  return weather;
}

describe("weather cells", () => {
  /** Every cell `seed` announces over `ticks` on the world map. */
  async function forecast(seed: number, ticks: number) {
    const game = await setup("world");
    const weather = new WeatherExecution(seed);
    game.addExecution(weather);
    const seen = new Map<number, WeatherCell>();
    const counts: number[] = [];
    let updates = 0;
    for (let t = 0; t < ticks; t++) {
      const u = game.executeNextTick();
      updates += u[GameUpdateType.Weather].length;
      for (const c of weather.cells()) {
        if (!seen.has(c.id)) seen.set(c.id, { ...c });
      }
      counts.push(weather.cells().length);
    }
    return { game, weather, cells: [...seen.values()], counts, updates };
  }

  it("are the same for the same seed and differ for another", async () => {
    const a = await forecast(7, 3000);
    const b = await forecast(7, 3000);
    const c = await forecast(8, 3000);
    expect(a.cells.length).toBeGreaterThanOrEqual(WEATHER_MIN_CELLS);
    expect(b.cells).toEqual(a.cells);
    expect(b.counts).toEqual(a.counts);
    expect(c.cells).not.toEqual(a.cells);
  });

  it("keeps 2-4 cells, each announced 30 seconds ahead and living 2-4 minutes", async () => {
    const { game, cells, counts, updates } = await forecast(42, 9000);
    // The first tick inits it; the next two announce the first pair.
    for (const n of counts.slice(3)) {
      expect(n).toBeGreaterThanOrEqual(WEATHER_MIN_CELLS);
      expect(n).toBeLessThanOrEqual(WEATHER_MAX_CELLS);
    }
    // New cells keep coming on the seeded schedule.
    expect(cells.length).toBeGreaterThan(6);
    const map = game.map();
    const kinds = new Set<WeatherKind>();
    for (const c of cells) {
      kinds.add(c.kind);
      expect(c.activeTick - c.announceTick).toBe(WEATHER_WARNING_TICKS);
      const life = c.endTick - c.activeTick;
      expect(life).toBeGreaterThanOrEqual(WEATHER_MIN_ACTIVE_TICKS);
      expect(life).toBeLessThanOrEqual(WEATHER_MAX_ACTIVE_TICKS);
      expect(c.radius).toBeGreaterThanOrEqual(WEATHER_MIN_RADIUS);
      expect(c.radius).toBeLessThanOrEqual(WEATHER_MAX_RADIUS);
      expect(Math.sqrt(c.dx * c.dx + c.dy * c.dy)).toBeCloseTo(
        WEATHER_DRIFT_PER_TICK,
        9,
      );
      const center = map.ref(c.x, c.y);
      if (c.kind === WeatherKind.Mud) expect(map.isLand(center)).toBe(true);
      if (c.kind === WeatherKind.Storm) expect(map.isOcean(center)).toBe(true);
    }
    expect(kinds).toEqual(
      new Set([WeatherKind.Mud, WeatherKind.Storm, WeatherKind.Fog]),
    );
    // Sent once a second, and on every change.
    expect(updates).toBeGreaterThanOrEqual(9000 / 10);
  });

  it("drift along their path, one tile per 10 ticks", async () => {
    const game = await setup("plains");
    const weather = scripted(game, {
      kind: WeatherKind.Mud,
      x: 20,
      y: 50,
      dx: 0.1,
      radius: 5,
    });
    const at = (x: number) =>
      weather.attackTileCostMultiplier(game.ref(x, 50)) > 1;
    // Tick 1 now: the center is at 20.1.
    expect(at(24)).toBe(true);
    expect(at(26)).toBe(false);
    executeTicks(game, 50); // ~25.1
    expect(at(29)).toBe(true);
    expect(at(19)).toBe(false);
  });
});

describe("mud fronts", () => {
  /** a (x < 40) attacks east for 8 ticks: into b, or into free land. */
  async function push(opts: { mud?: Partial<WeatherCell>; free?: boolean }) {
    const game = await setup(
      "plains",
      {},
      [human("a"), human("b")],
      undefined,
      UseRealAttackLogic,
    );
    const a = game.player("a");
    const b = game.player("b");
    conquerRect(game, a, 0, 0, 40, 100);
    if (!opts.free) conquerRect(game, b, 40, 0, 100, 100);
    a.setTroops(200_000);
    b.setTroops(1_000);
    scripted(game, ...(opts.mud ? [opts.mud] : []));
    const target = opts.free ? game.terraNullius().id() : b.id();
    game.addExecution(new AttackExecution(100_000, a, target));
    executeTicks(game, 8);
    const taken = a.numTilesOwned() - 4000;
    const lost = 100_000 - a.outgoingAttacks()[0].troops();
    return { taken, lost, perTile: lost / taken };
  }
  const MUD = { kind: WeatherKind.Mud, x: 70, y: 50, radius: 80 };

  it("makes enemy land 1.5x slower to take, at the same loss per tile", async () => {
    const clear = await push({});
    const mud = await push({ mud: MUD });
    expect(clear.taken).toBeGreaterThan(30);
    expect(mud.taken / clear.taken).toBeCloseTo(
      1 / MUD_TILE_COST_MULTIPLIER,
      1,
    );
    expect(mud.perTile / clear.perTile).toBeCloseTo(1, 1);
  });

  it("does nothing to free land, as a forecast, or as fog", async () => {
    const free = await push({ free: true });
    expect(await push({ free: true, mud: MUD })).toEqual(free);
    const clear = await push({});
    expect(await push({ mud: { ...MUD, activeTick: 10_000 } })).toEqual(clear);
    expect(await push({ mud: { ...MUD, kind: WeatherKind.Fog } })).toEqual(
      clear,
    );
  });
});

describe("sea storms", () => {
  // ocean_and_land: land at x <= 7, open sea, an island at x 14-15, y 6-8.
  const STORM = { kind: WeatherKind.Storm, x: 8, y: 8, radius: 40 };

  async function seaGame(storm: boolean) {
    const game = await setup("ocean_and_land", { infiniteGold: true }, [
      human("a"),
      human("b"),
    ]);
    const a = game.player("a");
    const b = game.player("b");
    game.map().forEachTile((t) => {
      if (!game.isLand(t)) return;
      (game.x(t) <= 7 ? a : b).conquer(t);
    });
    a.setTroops(100_000);
    b.setTroops(1_000);
    const weather = scripted(game, ...(storm ? [STORM] : []));
    return { game, a, b, weather };
  }

  /** Ticks until `done`, at most 200. */
  function ticksUntil(game: Game, done: () => boolean): number {
    for (let t = 0; t < 200; t++) {
      if (done()) return t;
      game.executeNextTick();
    }
    return 200;
  }

  it("halve a transport ship's speed and re-plan its motion at that speed", async () => {
    async function voyage(storm: boolean) {
      const { game, a } = await seaGame(storm);
      game.addExecution(new TransportShipExecution(a, game.ref(15, 7), 10_000));
      game.executeNextTick();
      const boat = a.units(UnitType.TransportShip)[0];
      expect(boat).toBeDefined();
      const ticks = ticksUntil(game, () => !boat.isActive());
      const plans = unpackMotionPlans(game.drainPackedMotionPlans()!).filter(
        (p) => p.kind === "grid" && p.unitId === boat.id(),
      );
      return { ticks, plans };
    }
    const clear = await voyage(false);
    const stormy = await voyage(true);
    // The launch and the landing take a tick each, storm or not.
    expect(clear.ticks).toBeGreaterThan(5);
    expect(stormy.ticks - 2).toBeGreaterThanOrEqual(2 * (clear.ticks - 2) - 2);
    expect(stormy.ticks - 2).toBeLessThanOrEqual(2 * (clear.ticks - 2) + 2);
    const stormPlans = stormy.plans.map((p) =>
      p.kind === "grid" ? p.ticksPerStep : 0,
    );
    expect(stormPlans).toContain(2);
    expect(
      clear.plans.every((p) => p.kind === "grid" && p.ticksPerStep === 1),
    ).toBe(true);
  });

  it("halve a warship's speed but not its readiness", async () => {
    async function patrol(storm: boolean) {
      const { game, a } = await seaGame(storm);
      const tile = game.ref(11, 2);
      const ship = a.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
      game.addExecution(new WarshipExecution(ship));
      game.executeNextTick();
      let moves = 0;
      for (let t = 0; t < 60; t++) {
        const before = ship.tile();
        game.executeNextTick();
        if (ship.tile() !== before) moves++;
      }
      return moves;
    }
    const clear = await patrol(false);
    const stormy = await patrol(true);
    expect(clear).toBeGreaterThan(30);
    expect(stormy).toBeLessThanOrEqual(Math.ceil(clear / 2) + 2);
    expect(stormy).toBeGreaterThanOrEqual(Math.floor(clear / 2) - 2);
  });

  it("halve a trade ship's speed", async () => {
    async function trade(storm: boolean) {
      const { game, a, b } = await seaGame(storm);
      const src = a.buildUnit(UnitType.Port, game.ref(7, 7), {});
      const dst = b.buildUnit(UnitType.Port, game.ref(14, 7), {});
      game.addExecution(new TradeShipExecution(a, src, dst));
      game.executeNextTick();
      game.executeNextTick();
      const ship = a.units(UnitType.TradeShip)[0];
      expect(ship).toBeDefined();
      return ticksUntil(game, () => !ship.isActive());
    }
    const clear = await trade(false);
    const stormy = await trade(true);
    // Leaving the port and docking take a tick each, storm or not.
    expect(clear).toBeGreaterThan(5);
    expect(stormy - 2).toBeGreaterThanOrEqual(2 * (clear - 2) - 2);
    expect(stormy - 2).toBeLessThanOrEqual(2 * (clear - 2) + 2);
  });

  it("halve a convoy's speed at sea", async () => {
    async function convoy(storm: boolean) {
      const { game, a, b } = await seaGame(storm);
      a.createAllianceRequest(b)!.accept();
      const path = [];
      for (let x = 7; x <= 14; x++) path.push(game.ref(x, 7));
      const unit = a.buildUnit(UnitType.Convoy, path[0], {
        troops: 1_000,
        targetTile: path[path.length - 1],
        targetPlayer: b,
      });
      game.addExecution(new ConvoyExecution(unit, b, path, 0));
      game.executeNextTick();
      return ticksUntil(game, () => !unit.isActive());
    }
    const clear = await convoy(false);
    const stormy = await convoy(true);
    // Six sea tiles, then the landing.
    expect(clear).toBeGreaterThan(5);
    expect(stormy).toBeGreaterThanOrEqual(2 * clear - 3);
    expect(stormy).toBeLessThanOrEqual(2 * clear + 1);
  });

  it("drown 1% of a boat's troops a tick, at most 25% over one storm", async () => {
    const { game, a, b, weather } = await seaGame(true);
    const boat = a.buildUnit(UnitType.TransportShip, game.ref(11, 12), {
      troops: 10_000,
      targetTile: game.ref(14, 7),
    });
    const convoy = a.buildUnit(UnitType.Convoy, game.ref(10, 3), {
      troops: 4_000,
      targetTile: game.ref(14, 7),
      targetPlayer: b,
    });
    const ashore = a.buildUnit(UnitType.Convoy, game.ref(3, 3), {
      troops: 4_000,
      targetTile: game.ref(14, 7),
      targetPlayer: b,
    });
    executeTicks(game, 1);
    expect(boat.troops()).toBe(9_900);
    expect(convoy.troops()).toBe(3_960);
    executeTicks(game, 10);
    expect(boat.troops()).toBe(8_900);
    executeTicks(game, 50);
    expect(boat.troops()).toBe(7_500);
    expect(convoy.troops()).toBe(3_000);
    expect(ashore.troops()).toBe(4_000);
    // A second storm is a second budget.
    weather.addCell(cell({ ...STORM, id: 2, activeTick: game.ticks() }));
    executeTicks(game, 60);
    expect(boat.troops()).toBe(5_625);
    expect(stormTroopLoss(10_000, 2_450)).toBe(50);
    expect(stormTroopLoss(10_000, 2_500)).toBe(0);
  });
});

describe("fog", () => {
  /** An attack and a boat for 30 ticks, with or without fog everywhere. */
  async function play(fog: boolean) {
    const game = await setup(
      "ocean_and_land",
      { infiniteGold: true },
      [human("a"), human("b")],
      undefined,
      UseRealAttackLogic,
    );
    const a = game.player("a");
    const b = game.player("b");
    game.map().forEachTile((t) => {
      if (!game.isLand(t)) return;
      (game.x(t) <= 3 ? a : b).conquer(t);
    });
    a.setTroops(50_000);
    b.setTroops(5_000);
    const weather = scripted(
      game,
      ...(fog ? [{ kind: WeatherKind.Fog, x: 8, y: 8, radius: 40 }] : []),
    );
    game.addExecution(
      new AttackExecution(20_000, a, b.id()),
      new TransportShipExecution(a, game.ref(15, 7), 5_000),
    );
    executeTicks(game, 30);
    return {
      a: [a.troops(), a.numTilesOwned()],
      b: [b.troops(), b.numTilesOwned()],
      units: game.units().map((u) => [u.id(), u.tile(), u.troops()]),
      mud: weather.attackTileCostMultiplier(game.ref(5, 5)),
      storm: weather.inStorm(game.ref(10, 10)),
    };
  }

  it("has no engine effect", async () => {
    const clear = await play(false);
    const fog = await play(true);
    expect(fog).toEqual(clear);
    expect(fog.mud).toBe(1);
    expect(fog.storm).toBe(false);
  });

  it("hides troop counts only from viewers who don't own or ally them", () => {
    const fog = [cell({ kind: WeatherKind.Fog, x: 10, y: 10, radius: 5 })];
    expect(fogHidesTroops(fog, 5, 10, 12, false)).toBe(true);
    expect(fogHidesTroops(fog, 5, 10, 12, true)).toBe(false);
    expect(fogHidesTroops(fog, 5, 30, 30, false)).toBe(false);
    // A forecast or another kind hides nothing.
    const forecast = [cell({ ...fog[0], activeTick: 100 })];
    expect(fogHidesTroops(forecast, 5, 10, 12, false)).toBe(false);
    const storm = [cell({ ...fog[0], kind: WeatherKind.Storm })];
    expect(fogHidesTroops(storm, 5, 10, 12, false)).toBe(false);
  });
});
