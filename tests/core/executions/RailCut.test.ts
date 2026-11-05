import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  RailroadCutUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { RAIL_CUT_CHECK_INTERVAL } from "@openfront/engine-lib/game/TradeRoutes";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { RecomputeRailClusterExecution } from "@openfront/engine/execution/RecomputeRailClusterExecution";
import { TrainExecution } from "@openfront/engine/execution/TrainExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { Railroad, RailroadSnapshot } from "@openfront/engine/game/Railroad";
import { Cluster, TrainStation } from "@openfront/engine/game/TrainStation";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";

const MAP = "plains";
const Y = 10;

async function players() {
  const game = await setup(MAP, { instantBuild: true }, [
    new PlayerInfo("owner", PlayerType.Human, null, "owner"),
    new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    new PlayerInfo("rival", PlayerType.Human, null, "rival"),
    new PlayerInfo("ally", PlayerType.Human, null, "ally"),
  ]);
  const owner = game.player("owner");
  const enemy = game.player("enemy");
  const rival = game.player("rival");
  const ally = game.player("ally");
  // Each needs land to be alive.
  enemy.conquer(game.ref(50, 50));
  rival.conquer(game.ref(60, 60));
  ally.conquer(game.ref(70, 70));
  return { game, owner, enemy, rival, ally };
}

/**
 * Three of `owner`'s cities on a straight line, a at x=0, b at x=20 and c at
 * x=40, joined by the rails a-b and b-c, all in one cluster. `owner` holds
 * the whole line, and the rails have been scanned once.
 */
async function railFixture() {
  const p = await players();
  const { game, owner } = p;
  for (let x = 0; x <= 60; x++) owner.conquer(game.ref(x, Y));

  const net = game.railNetwork();
  let nextId = 100;
  const station = (player: Player, x: number) => {
    const unit = player.buildUnit(UnitType.City, game.ref(x, Y), {});
    unit.setTrainStation(true);
    const s = new TrainStation(game, unit);
    net.stationManager().addStation(s);
    return s;
  };
  const rail = (from: TrainStation, to: TrainStation) => {
    const tiles: TileRef[] = [];
    for (let x = game.x(from.tile()); x <= game.x(to.tile()); x++) {
      tiles.push(game.ref(x, Y));
    }
    const r = new Railroad(from, to, tiles, nextId++);
    from.addRailroad(r);
    to.addRailroad(r);
    return r;
  };
  const a = station(owner, 0);
  const b = station(owner, 20);
  const c = station(owner, 40);
  const ab = rail(a, b);
  const bc = rail(b, c);
  new Cluster().addStations(new Set([a, b, c]));
  // The first scan only records who holds each tile.
  scan(game);
  return { ...p, net, station, rail, a, b, c, ab, bc };
}

function scan(game: Game): void {
  game.railNetwork().refreshCuts();
  game.railNetwork().recomputeClusters();
}

function cutEvents(game: Game, ticks: number): RailroadCutUpdate[] {
  const events: RailroadCutUpdate[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...game.executeNextTick()[GameUpdateType.RailroadCutEvent]);
  }
  return events;
}

const cutMessages = (messages: { mock: { calls: unknown[][] } }) =>
  messages.mock.calls.filter((call) => call[0] === "events_display.rail_cut");

describe("rail cuts", () => {
  it("cuts the line when an enemy captures one of its tiles, splits its cluster, and tells the owner once", async () => {
    const { game, owner, enemy, a, b, c, ab, bc } = await railFixture();
    const messages = vi.spyOn(game, "displayMessage");
    game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
    enemy.conquer(game.ref(30, Y));

    const events = cutEvents(game, RAIL_CUT_CHECK_INTERVAL * 3);

    expect(bc.isCut()).toBe(true);
    expect(bc.cutTiles).toEqual([game.ref(30, Y)]);
    expect(ab.isCut()).toBe(false);
    expect(events).toEqual([
      { type: GameUpdateType.RailroadCutEvent, id: bc.id, cut: true },
    ]);
    // The rail stays; trains can't cross it, so its stations split apart.
    expect(b.getRailroadTo(c)).toBe(bc);
    expect(a.getCluster()).toBe(b.getCluster());
    expect(c.getCluster()).not.toBe(b.getCluster());
    const cuts = cutMessages(messages);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][1]).toBe(MessageType.UNIT_DESTROYED);
    expect(cuts[0][2]).toBe(owner.id());
    expect(cuts[0][4]).toEqual({ name: enemy.displayName() });
  });

  it("a canal dug under the line doesn't cut it", async () => {
    const { game, bc } = await railFixture();
    game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
    // What CanalExecution does to each path tile: let it go, then dig it.
    const tile = game.ref(30, Y);
    game.player("owner").relinquish(tile);
    game.queueWaterConversion(tile, true);
    const events = cutEvents(game, RAIL_CUT_CHECK_INTERVAL * 3);
    expect(game.isWater(tile)).toBe(true);
    // Land falling to nobody is no capture: the line stays live.
    expect(bc.isCut()).toBe(false);
    expect(events).toEqual([]);
  });

  it("heals and reconnects the line once the owner retakes the tile", async () => {
    const { game, owner, enemy, a, b, c, bc } = await railFixture();
    game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
    enemy.conquer(game.ref(30, Y));
    cutEvents(game, RAIL_CUT_CHECK_INTERVAL * 2);
    expect(bc.isCut()).toBe(true);

    owner.conquer(game.ref(30, Y));
    const events = cutEvents(game, RAIL_CUT_CHECK_INTERVAL * 2);

    expect(bc.isCut()).toBe(false);
    expect(bc.cutTiles).toEqual([]);
    expect(events).toEqual([
      { type: GameUpdateType.RailroadCutEvent, id: bc.id, cut: false },
    ]);
    expect(b.getRailroadTo(c)).toBe(bc);
    expect(c.getCluster()).toBe(a.getCluster());
    expect(a.getCluster()!.size()).toBe(3);
  });

  it("keeps a cut tile cut when a hostile takes it from another hostile", async () => {
    const { game, owner, enemy, rival, bc } = await railFixture();
    enemy.conquer(game.ref(30, Y));
    scan(game);
    expect(bc.isCut()).toBe(true);

    rival.conquer(game.ref(30, Y));
    scan(game);
    expect(bc.isCut()).toBe(true);
    expect(bc.cutTiles).toEqual([game.ref(30, Y)]);

    owner.conquer(game.ref(30, Y));
    scan(game);
    expect(bc.isCut()).toBe(false);
  });

  it("leaves a rail built through a hostile player's land live until someone captures a tile", async () => {
    const { game, owner, enemy, rival, station, rail, c } = await railFixture();
    // Owner's d at x=60, laid across the enemy's land at x=45-55.
    for (let x = 45; x <= 55; x++) enemy.conquer(game.ref(x, Y));
    const d = station(owner, 60);
    const cd = rail(c, d);
    c.getCluster()!.addStation(d);
    const messages = vi.spyOn(game, "displayMessage");
    for (let i = 0; i < 3; i++) scan(game);
    expect(cd.isCut()).toBe(false);
    expect(d.getCluster()).toBe(c.getCluster());

    // The enemy pushing deeper into owner's land along the rail cuts it.
    enemy.conquer(game.ref(58, Y));
    scan(game);
    expect(cd.isCut()).toBe(true);
    expect(cd.cutTiles).toEqual([game.ref(58, Y)]);
    expect(cutMessages(messages).map((call) => call[2])).toEqual([owner.id()]);

    // So does one hostile taking another's tile under it.
    owner.conquer(game.ref(58, Y));
    scan(game);
    expect(cd.isCut()).toBe(false);
    rival.conquer(game.ref(50, Y));
    scan(game);
    expect(cd.cutTiles).toEqual([game.ref(50, Y)]);
  });

  it("is not cut by allies or by land falling to nobody", async () => {
    const { game, owner, ally, ab, bc } = await railFixture();
    owner.createAllianceRequest(ally)!.accept();
    ally.conquer(game.ref(10, Y));
    owner.relinquish(game.ref(30, Y));

    scan(game);

    expect(ab.isCut()).toBe(false);
    expect(bc.isCut()).toBe(false);
  });

  it("is cut by an ally of one end's owner who captures a tile from the other", async () => {
    const { game, owner, enemy, ally, station, rail, c } = await railFixture();
    // A cross-border rail from owner's c to enemy's d.
    for (let x = 50; x <= 60; x++) enemy.conquer(game.ref(x, Y));
    const d = station(enemy, 60);
    const cd = rail(c, d);
    c.getCluster()!.addStation(d);
    scan(game);
    // Each end owner's land is the rail's own.
    expect(cd.isCut()).toBe(false);

    owner.createAllianceRequest(ally)!.accept();
    ally.conquer(game.ref(55, Y));
    const messages = vi.spyOn(game, "displayMessage");
    scan(game);

    expect(cd.isCut()).toBe(true);
    // Only the end owner the ally is hostile to hears of it.
    expect(cutMessages(messages).map((call) => call[2])).toEqual([enemy.id()]);
  });

  it("keeps the cut on the half that has the tile when a station splits the rail", async () => {
    const { game, owner, enemy } = await players();
    for (let x = 0; x < 100; x++) {
      for (let y = 40; y <= 60; y++) owner.conquer(game.ref(x, y));
    }
    const net = game.railNetwork();
    const city = (tile: TileRef) => {
      const s = new TrainStation(
        game,
        owner.buildUnit(UnitType.City, tile, {}),
      );
      s.unit.setTrainStation(true);
      net.connectStation(s);
      return s;
    };
    const a = city(game.ref(10, 50));
    const b = city(game.ref(70, 50));
    const ab = a.getRailroadTo(b)!;
    expect(ab).not.toBeNull();
    const cutTile = ab.tiles[Math.floor(ab.tiles.length * 0.8)];
    enemy.conquer(cutTile);
    scan(game);
    expect(ab.isCut()).toBe(true);

    const addUpdate = vi.spyOn(game, "addUpdate");
    const s = city(ab.tiles[Math.floor(ab.tiles.length * 0.3)]);
    net.recomputeClusters();

    // ab runs from whichever station connected second; find each half.
    const halves = [a.getRailroadTo(s)!, s.getRailroadTo(b)!];
    const cutHalf = halves.find((r) => r.tiles.includes(cutTile))!;
    const liveHalf = halves.find((r) => r !== cutHalf)!;
    expect(cutHalf.cutTiles).toEqual([cutTile]);
    expect(liveHalf.isCut()).toBe(false);
    expect(
      addUpdate.mock.calls
        .map(([u]) => u)
        .filter((u) => u.type === GameUpdateType.RailroadCutEvent),
    ).toEqual([
      { type: GameUpdateType.RailroadCutEvent, id: cutHalf.id, cut: true },
    ]);
    // The station stays with the end it is still joined to.
    const joined = liveHalf.from === s ? liveHalf.to : liveHalf.from;
    const severed = joined === a ? b : a;
    expect(s.getCluster()).toBe(joined.getCluster());
    expect(severed.getCluster()).not.toBe(s.getCluster());
  });

  it("removes a train on a line when it is cut, with no payout", async () => {
    const { game, net, owner, enemy, a, c } = await railFixture();
    const exec = new TrainExecution(net, owner, a, c, 1);
    exec.init(game, 0);
    exec.tick(1);
    exec.tick(2);
    expect(exec.isActive()).toBe(true);

    enemy.conquer(game.ref(10, Y));
    scan(game);
    exec.tick(3);

    expect(exec.isActive()).toBe(false);
    expect(owner.units(UnitType.Train)).toHaveLength(0);
    expect(owner.trainGold()).toBe(0n);
  });

  it("ends a trip at the last station before a cut: no payout over the cut line", async () => {
    const { game, net, owner, enemy, a, b, c } = await railFixture();
    const stopB = vi.spyOn(b, "onTrainStop");
    const stopC = vi.spyOn(c, "onTrainStop");
    const exec = new TrainExecution(net, owner, a, c, 1);
    exec.init(game, 0);
    enemy.conquer(game.ref(30, Y));
    scan(game);

    for (let t = 1; t < 100 && exec.isActive(); t++) exec.tick(t);

    expect(exec.isActive()).toBe(false);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(stopC).not.toHaveBeenCalled();
    expect(owner.units(UnitType.Train)).toHaveLength(0);
  });

  it("routes no new trains over a cut line", async () => {
    const { game, net, owner, enemy, a, b, c } = await railFixture();
    enemy.conquer(game.ref(10, Y));
    scan(game);

    const exec = new TrainExecution(net, owner, a, c, 1);
    exec.init(game, 0);

    expect(exec.isActive()).toBe(false);
    // Stations only pick destinations in their cluster.
    expect(a.getCluster()!.availableForTrade(owner).has(b)).toBe(false);
    expect(a.getCluster()!.availableForTrade(owner).has(c)).toBe(false);
  });

  it("re-sends cut rails when the view resyncs", async () => {
    const { game, enemy, bc } = await railFixture();
    enemy.conquer(game.ref(30, Y));
    scan(game);

    game.queueViewResync();
    const events = game.executeNextTick()[GameUpdateType.RailroadCutEvent];

    expect(events).toEqual([
      { type: GameUpdateType.RailroadCutEvent, id: bc.id, cut: true },
    ]);
  });

  it("keeps cut rails through a snapshot round trip", async () => {
    const { game, owner, enemy, bc } = await railFixture();
    game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
    enemy.conquer(game.ref(30, Y));
    cutEvents(game, RAIL_CUT_CHECK_INTERVAL * 2);
    expect(bc.isCut()).toBe(true);

    const restored = await expectSnapshotRoundTrip(
      game,
      MAP,
      RAIL_CUT_CHECK_INTERVAL * 2,
      (g, tick) => {
        // Retake the tile halfway, so the restored game heals it too.
        if (tick === RAIL_CUT_CHECK_INTERVAL) {
          g.player(owner.id()).conquer(g.ref(30, Y));
        }
      },
    );
    expect(bc.isCut()).toBe(false);
    for (const station of restored.railNetwork().stationManager().getAll()) {
      for (const r of station.getRailroads()) expect(r.isCut()).toBe(false);
    }
  });

  it("loads railroads from older snapshots as live and not yet scanned", () => {
    const tiles = new Uint32Array([1, 2, 3]);
    expect(
      readVersioned(RailroadSnapshot, {
        v: 1,
        d: { id: 7, from: 0, to: 1, tiles },
      }),
    ).toEqual({
      id: 7,
      from: 0,
      to: 1,
      tiles,
      owners: new Uint16Array(0),
      cutTiles: new Uint32Array(0),
    });
  });
});
