import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  BLOCKADE_CHECK_INTERVAL,
  BLOCKADE_RANGE,
  BLOCKADE_TRADE_SHIP_RATE_DIVISOR,
  WAR_MEMORY_TICKS,
} from "@openfront/engine-lib/game/TradeRoutes";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import {
  PortExecution,
  PortExecutionSnapshot,
} from "@openfront/engine/execution/PortExecution";
import { TradeShipExecution } from "@openfront/engine/execution/TradeShipExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { PlayerSnapshot } from "@openfront/engine/game/PlayerImpl";
import { atWar, portBlockader } from "@openfront/engine/game/PortBlockade";
import { snapshotGameData } from "@openfront/engine/snapshot/GameSnapshot";
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

/**
 * An active attack of `attacker` on `target`, launched this tick (no
 * execution: it runs until deleted).
 */
function war(attacker: Player, target: Player) {
  return attacker.createAttack(target, 100, null, new Set());
}

/** Counts the trade ships `port`'s owner launches from now on. */
function countLaunches(game: Game, owner: Player): () => number {
  const added = vi.spyOn(game, "addExecution");
  return () =>
    added.mock.calls
      .flat()
      .filter(
        (e) =>
          e instanceof TradeShipExecution &&
          (e as unknown as { origOwner: Player }).origOwner === owner,
      ).length;
}

const launched = (player: Player) => player.units(UnitType.TradeShip).length;

describe("naval blockades", () => {
  it("trades freely without warships", async () => {
    const { game, owner, port, partnerExec } = await portFixture();
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(launched(owner)).toBeGreaterThan(0);
    expect(partnerExec.tradingPorts()).toContain(port);
  });

  it("a warship that isn't at war with the port's owner doesn't blockade", async () => {
    const { game, owner, enemy, port, partnerExec } = await portFixture();
    const messages = vi.spyOn(game, "displayMessage");
    warship(game, enemy, 12, 3);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(atWar(game, enemy, owner)).toBe(false);
    expect(portBlockader(game, port)).toBeNull();
    expect(partnerExec.tradingPorts()).toContain(port);
    expect(
      messages.mock.calls.filter(
        (call) => call[0] === "events_display.port_blockaded",
      ),
    ).toHaveLength(0);
  });

  it("at war, either side attacking, the warship blockades the port and tells its owner once", async () => {
    const { game, owner, partner, enemy, port, partnerPort, partnerExec } =
      await portFixture();
    const messages = vi.spyOn(game, "displayMessage");
    const ship = warship(game, enemy, 12, 3);
    // The port's owner attacked the warship's owner.
    war(owner, enemy);
    expect(atWar(game, enemy, owner)).toBe(true);
    expect(atWar(game, owner, enemy)).toBe(true);

    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 3);

    expect(portBlockader(game, port)).toBe(ship);
    expect(partnerExec.tradingPorts()).not.toContain(port);
    // The partner isn't at war with anyone, so its port trades on.
    expect(atWar(game, enemy, partner)).toBe(false);
    expect(portBlockader(game, partnerPort)).toBeNull();
    const notices = messages.mock.calls.filter(
      (call) => call[0] === "events_display.port_blockaded",
    );
    expect(notices.map((call) => call[2])).toEqual([owner.id()]);
    expect(notices[0][1]).toBe(MessageType.UNIT_DESTROYED);
    expect(notices[0][4]).toEqual({ name: enemy.displayName() });
    expect(notices[0][5]).toBe(port.id());
  });

  it("allies are never at war, even right after an attack", async () => {
    const { game, owner, ally, port, partnerExec } = await portFixture();
    // They fought, then made up.
    const attack = war(ally, owner);
    expect(atWar(game, ally, owner)).toBe(true);
    attack.delete();
    owner.createAllianceRequest(ally)!.accept();
    warship(game, ally, 12, 3);
    expect(ally.lastHostileActTick(owner)).toBeDefined();
    expect(atWar(game, ally, owner)).toBe(false);
    // Allied while an attack still runs, too.
    war(ally, owner);
    expect(atWar(game, ally, owner)).toBe(false);

    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);

    expect(portBlockader(game, port)).toBeNull();
    expect(partnerExec.tradingPorts()).toContain(port);
  });

  it("a blockade holds 1199 ticks after the last attack and lifts at 1200", async () => {
    expect(WAR_MEMORY_TICKS).toBe(1200);
    const { game, owner, enemy, port, portExec } = await portFixture();
    const ship = warship(game, enemy, 12, 3);
    const launched = game.ticks();
    // A short attack: launched and over in the same tick.
    war(enemy, owner).delete();
    expect(enemy.outgoingAttacks()).toHaveLength(0);
    expect(enemy.lastHostileActTick(owner)).toBe(launched);

    while (game.ticks() < launched + WAR_MEMORY_TICKS - 1) {
      game.executeNextTick();
    }
    expect(game.ticks()).toBe(launched + 1199);
    expect(atWar(game, enemy, owner)).toBe(true);
    expect(portBlockader(game, port)).toBe(ship);
    expect((portExec as unknown as { blockaded: boolean }).blockaded).toBe(
      true,
    );

    game.executeNextTick();
    expect(game.ticks()).toBe(launched + 1200);
    expect(atWar(game, enemy, owner)).toBe(false);
    expect(portBlockader(game, port)).toBeNull();
    // The port's own check catches up within a check interval.
    executeTicks(game, BLOCKADE_CHECK_INTERVAL);
    expect((portExec as unknown as { blockaded: boolean }).blockaded).toBe(
      false,
    );
  });

  it("an attack still running keeps them at war past 1200 ticks", async () => {
    const { game, owner, enemy, port } = await portFixture();
    const ship = warship(game, enemy, 12, 3);
    // The port's owner attacked, and its attack is still going.
    war(owner, enemy);
    executeTicks(game, WAR_MEMORY_TICKS + 50);
    expect(atWar(game, enemy, owner)).toBe(true);
    expect(portBlockader(game, port)).toBe(ship);
  });

  it("a newer attack from either side restarts the 2 minutes", async () => {
    const { game, owner, enemy } = await portFixture();
    war(enemy, owner).delete();
    executeTicks(game, 1000);
    // The other side answers.
    war(owner, enemy).delete();
    executeTicks(game, 1000);
    expect(atWar(game, enemy, owner)).toBe(true);
    executeTicks(game, 200);
    expect(atWar(game, enemy, owner)).toBe(false);
  });

  it("sends the war record to the view with the attacker's player update", async () => {
    const { game, owner, enemy } = await portFixture();
    game.executeNextTick();
    const launched = game.ticks();
    war(enemy, owner).delete();
    const updates = game.executeNextTick()[GameUpdateType.Player];
    const fromEnemy = updates.find((u) => u.id === enemy.id());
    expect(fromEnemy?.hostileActs).toEqual([owner.smallID(), launched]);
  });

  it("a nuke at the port's owner counts as an attack", async () => {
    const game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("owner", PlayerType.Human, null, "owner"),
        new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
      ],
    );
    const owner = game.player("owner");
    const enemy = game.player("enemy");
    owner.conquer(game.ref(10, 10));
    owner.conquer(game.ref(60, 60));
    enemy.conquer(game.ref(90, 90));
    const port = owner.buildUnit(UnitType.Port, game.ref(10, 10), {});
    const ship = warship(game, enemy, 10, 30);
    enemy.buildUnit(UnitType.MissileSilo, game.ref(90, 90), {});
    expect(portBlockader(game, port)).toBeNull();

    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, enemy, game.ref(60, 60), null),
    );
    executeTicks(game, 2);
    expect(enemy.units(UnitType.AtomBomb)).toHaveLength(1);
    expect(enemy.outgoingAttacks()).toHaveLength(0);
    expect(enemy.lastHostileActTick(owner)).toBeDefined();
    expect(atWar(game, enemy, owner)).toBe(true);
    expect(portBlockader(game, port)).toBe(ship);
  });

  it("a boat attack at the port's owner counts too", async () => {
    const { game, owner, enemy } = await portFixture();
    enemy.conquer(game.ref(7, 7));
    game.addExecution(new TransportShipExecution(enemy, game.ref(7, 2), 10));
    game.executeNextTick();
    expect(enemy.units(UnitType.TransportShip)).toHaveLength(1);
    expect(enemy.outgoingAttacks()).toHaveLength(0);
    expect(enemy.lastHostileActTick(owner)).toBeDefined();
    expect(atWar(game, enemy, owner)).toBe(true);
  });

  it("keeps who attacked whom through a snapshot; older saves start with none", async () => {
    const { game, owner, enemy } = await portFixture();
    const launched = game.ticks();
    war(enemy, owner).delete();
    executeTicks(game, 3);
    const restored = await expectSnapshotRoundTrip(
      game,
      MAP,
      BLOCKADE_CHECK_INTERVAL,
      (g) => {
        g.config().tradeShipSpawnRate = () => 1;
      },
    );
    expect(
      restored.player("enemy").lastHostileActTick(restored.player("owner")),
    ).toBe(launched);

    const d = {
      ...(snapshotGameData(game).players[0].d as Record<string, unknown>),
    };
    delete d.hostileActs;
    expect(readVersioned(PlayerSnapshot, { v: 5, d }).hostileActs).toEqual([]);
  });

  it("a blockaded port sends trade ships at half rate", async () => {
    expect(BLOCKADE_TRADE_SHIP_RATE_DIVISOR).toBe(2);
    const checks = 40;
    const free = await portFixture();
    // Past the first check, so both count whole checks.
    executeTicks(free.game, BLOCKADE_CHECK_INTERVAL);
    const freeLaunches = countLaunches(free.game, free.owner);
    executeTicks(free.game, BLOCKADE_CHECK_INTERVAL * checks);

    const blockaded = await portFixture();
    warship(blockaded.game, blockaded.enemy, 12, 3);
    war(blockaded.enemy, blockaded.owner);
    executeTicks(blockaded.game, BLOCKADE_CHECK_INTERVAL);
    expect(portBlockader(blockaded.game, blockaded.port)).not.toBeNull();
    const blockadedLaunches = countLaunches(blockaded.game, blockaded.owner);
    executeTicks(blockaded.game, BLOCKADE_CHECK_INTERVAL * checks);

    // One a check without the blockade, one every second check with it.
    expect(freeLaunches()).toBe(checks);
    expect(blockadedLaunches()).toBe(checks / 2);
  });

  it("lifts when the war ends or the warship leaves, and a new blockade is reported again", async () => {
    const { game, owner, enemy, port, partnerExec } = await portFixture();
    const messages = vi.spyOn(game, "displayMessage");
    const toOwner = () =>
      messages.mock.calls.filter(
        (call) =>
          call[0] === "events_display.port_blockaded" && call[2] === owner.id(),
      ).length;
    const ship = warship(game, enemy, 12, 3);
    const attack = war(enemy, owner);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(portBlockader(game, port)).toBe(ship);

    // The attack ends, and 2 minutes later so does the war.
    attack.delete();
    executeTicks(game, WAR_MEMORY_TICKS);
    expect(atWar(game, enemy, owner)).toBe(false);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(portBlockader(game, port)).toBeNull();
    expect(partnerExec.tradingPorts()).toContain(port);
    expect(toOwner()).toBe(1);

    // War again, then the warship leaves.
    war(enemy, owner);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(toOwner()).toBe(2);
    ship.delete(false);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(partnerExec.tradingPorts()).toContain(port);

    warship(game, enemy, 13, 4);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect(partnerExec.tradingPorts()).not.toContain(port);
    expect(toOwner()).toBe(3);
  });

  it("lets trade ships already at sea sail on", async () => {
    const { game, owner, partner, enemy, port, partnerPort } =
      await portFixture();
    game.config().tradeShipSpawnRate = () => 1_000_000;
    const exec = new TradeShipExecution(partner, partnerPort, port);
    game.addExecution(exec);
    executeTicks(game, 2);
    expect(partner.units(UnitType.TradeShip)).toHaveLength(1);

    warship(game, enemy, 12, 3);
    war(enemy, owner);
    for (let i = 0; i < 200 && exec.isActive(); i++) game.executeNextTick();

    expect(portBlockader(game, port)).not.toBeNull();
    // It arrived and was paid, blockade or not.
    expect(partner.tradeGold()).toBeGreaterThan(0n);
  });

  it("only counts warships within 25 tiles", async () => {
    expect(BLOCKADE_RANGE).toBe(25);
    const game = await setup("plains", {}, [
      new PlayerInfo("owner", PlayerType.Human, null, "owner"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    ]);
    const owner = game.player("owner");
    const enemy = game.player("enemy");
    owner.conquer(game.ref(10, 10));
    enemy.conquer(game.ref(90, 90));
    war(enemy, owner);
    // buildUnit doesn't check terrain, so plains do for the distance rule.
    const port = owner.buildUnit(UnitType.Port, game.ref(10, 10), {});
    const far = warship(game, enemy, 10, 10 + 26);
    expect(portBlockader(game, port)).toBeNull();
    const near = warship(game, enemy, 10, 10 + 25);
    expect(portBlockader(game, port)).toBe(near);
    near.delete(false);
    expect(far.isActive()).toBe(true);
    expect(portBlockader(game, port)).toBeNull();
  });

  it("keeps the blockade through a snapshot round trip", async () => {
    const { game, owner, enemy, portExec } = await portFixture();
    warship(game, enemy, 12, 3);
    war(enemy, owner);
    executeTicks(game, BLOCKADE_CHECK_INTERVAL * 2);
    expect((portExec as unknown as { blockaded: boolean }).blockaded).toBe(
      true,
    );
    // The fixture's every-check spawn rate is patched onto the config, which
    // a restore builds afresh: patch both games alike.
    await expectSnapshotRoundTrip(
      game,
      MAP,
      BLOCKADE_CHECK_INTERVAL * 4,
      (g) => {
        g.config().tradeShipSpawnRate = () => 1;
      },
    );
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
