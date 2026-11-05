import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  BLOCKADE_CHECK_INTERVAL,
  BLOCKADE_RANGE,
} from "@openfront/engine-lib/game/TradeRoutes";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import {
  PortExecution,
  PortExecutionSnapshot,
} from "@openfront/engine/execution/PortExecution";
import { TradeShipExecution } from "@openfront/engine/execution/TradeShipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { portBlockader } from "@openfront/engine/game/PortBlockade";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// Land is x 0-7 and ocean x 8-15; everything is within BLOCKADE_RANGE.
const MAP = "half_land_half_ocean";

/**
 * owner's port at (7, 2) and partner's at (7, 13), each with its
 * PortExecution, trading freely: every check launches a ship.
 */
async function portFixture() {
  const game = await setup(MAP, { instantBuild: true }, [
    new PlayerInfo("owner", PlayerType.Human, null, "owner"),
    new PlayerInfo("partner", PlayerType.Human, null, "partner"),
    new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    new PlayerInfo("ally", PlayerType.Human, null, "ally"),
  ]);
  const owner = game.player("owner");
  const partner = game.player("partner");
  const enemy = game.player("enemy");
  const ally = game.player("ally");
  owner.conquer(game.ref(7, 2));
  partner.conquer(game.ref(7, 13));
  enemy.conquer(game.ref(0, 7));
  ally.conquer(game.ref(0, 9));
  game.config().tradeShipSpawnRate = () => 1;

  const port = owner.buildUnit(UnitType.Port, game.ref(7, 2), {});
  const partnerPort = partner.buildUnit(UnitType.Port, game.ref(7, 13), {});
  const portExec = new PortExecution(port);
  const partnerExec = new PortExecution(partnerPort);
  game.addExecution(portExec, partnerExec);
  return {
    game,
    owner,
    partner,
    enemy,
    ally,
    port,
    partnerPort,
    portExec,
    partnerExec,
  };
}

function warship(game: Game, player: Player, x: number, y: number) {
  const tile = game.ref(x, y);
  return player.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}

const launched = (player: Player) => player.units(UnitType.TradeShip).length;

describe("naval blockades", () => {
  it("trades freely without warships", async () => {
    const { game, owner, port, partnerExec } = await portFixture();
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(launched(owner)).toBeGreaterThan(0);
    expect(partnerExec.tradingPorts()).toContain(port);
  });

  it("a hostile warship stops the port's trade ships and its trade, and tells its owner once", async () => {
    const { game, owner, partner, enemy, port, partnerExec } =
      await portFixture();
    const messages = vi.spyOn(game, "displayMessage");
    const ship = warship(game, enemy, 12, 3);

    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 3);

    expect(portBlockader(game, port)).toBe(ship);
    expect(launched(owner)).toBe(0);
    expect(partnerExec.tradingPorts()).not.toContain(port);
    const notices = messages.mock.calls.filter(
      (call) => call[0] === "events_display.port_blockaded",
    );
    // The partner's port is blockaded too: the warship is hostile to both.
    expect(notices.map((call) => call[2]).sort()).toEqual(
      [owner.id(), partner.id()].sort(),
    );
    const toOwner = notices.find((call) => call[2] === owner.id())!;
    expect(toOwner[1]).toBe(MessageType.UNIT_DESTROYED);
    expect(toOwner[4]).toEqual({ name: enemy.displayName() });
    expect(toOwner[5]).toBe(port.id());
  });

  it("an allied warship does not blockade", async () => {
    const { game, owner, ally, port, partnerExec } = await portFixture();
    owner.createAllianceRequest(ally)!.accept();
    const messages = vi.spyOn(game, "displayMessage");
    warship(game, ally, 12, 3);

    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);

    expect(portBlockader(game, port)).toBeNull();
    expect(partnerExec.tradingPorts()).toContain(port);
    expect(
      messages.mock.calls.filter(
        (call) =>
          call[0] === "events_display.port_blockaded" && call[2] === owner.id(),
      ),
    ).toHaveLength(0);
  });

  it("lifts when the warship leaves, and a new blockade is reported again", async () => {
    const { game, owner, enemy, port, partnerExec } = await portFixture();
    const messages = vi.spyOn(game, "displayMessage");
    const toOwner = () =>
      messages.mock.calls.filter(
        (call) =>
          call[0] === "events_display.port_blockaded" && call[2] === owner.id(),
      ).length;
    const ship = warship(game, enemy, 12, 3);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(launched(owner)).toBe(0);

    ship.delete(false);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(partnerExec.tradingPorts()).toContain(port);
    expect(launched(owner)).toBeGreaterThan(0);
    expect(toOwner()).toBe(1);

    warship(game, enemy, 13, 4);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(partnerExec.tradingPorts()).not.toContain(port);
    expect(toOwner()).toBe(2);
  });

  it("lets trade ships already at sea sail on", async () => {
    const { game, partner, enemy, port, partnerPort } = await portFixture();
    game.config().tradeShipSpawnRate = () => 1_000_000;
    const exec = new TradeShipExecution(partner, partnerPort, port);
    game.addExecution(exec);
    executeTicks(game, 2);
    expect(partner.units(UnitType.TradeShip)).toHaveLength(1);

    warship(game, enemy, 12, 3);
    for (let i = 0; i < 200 && exec.isActive(); i++) game.executeNextTick();

    expect(portBlockader(game, port)).not.toBeNull();
    // It arrived and was paid, blockade or not.
    expect(partner.tradeGold()).toBeGreaterThan(0n);
  });

  it("only counts warships within BLOCKADE_RANGE tiles", async () => {
    const game = await setup("plains", {}, [
      new PlayerInfo("owner", PlayerType.Human, null, "owner"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    ]);
    const owner = game.player("owner");
    const enemy = game.player("enemy");
    owner.conquer(game.ref(10, 10));
    enemy.conquer(game.ref(90, 90));
    // buildUnit doesn't check terrain, so plains do for the distance rule.
    const port = owner.buildUnit(UnitType.Port, game.ref(10, 10), {});
    const far = warship(game, enemy, 10, 10 + BLOCKADE_RANGE + 1);
    expect(portBlockader(game, port)).toBeNull();
    const near = warship(game, enemy, 10, 10 + BLOCKADE_RANGE);
    expect(portBlockader(game, port)).toBe(near);
    near.delete(false);
    expect(far.isActive()).toBe(true);
    expect(portBlockader(game, port)).toBeNull();
  });

  it("keeps the blockade through a snapshot round trip", async () => {
    const { game, enemy } = await portFixture();
    warship(game, enemy, 12, 3);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    await expectSnapshotRoundTrip(game, MAP, BLOCKADE_CHECK_INTERVAL * 2);
  });

  it("loads ports from older snapshots as not blockaded", () => {
    const d = {
      active: true,
      port: 3,
      init: null,
      tradeShipSpawnRejections: 2,
    };
    expect(readVersioned(PortExecutionSnapshot, { v: 1, d })).toEqual({
      ...d,
      blockaded: false,
    });
  });
});
