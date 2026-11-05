/**
 * Ships re-route when the water graph changes under them: a canal opens a
 * shortcut, or a tide wave floods one. Each ship's water pathfinder picks the
 * new graph up after its own stagger, and the motion plan it records must
 * describe the step it takes that very tick, or the client view (and the
 * replay) runs a tick behind the engine. Checked by a full replay round trip
 * with boats sailing the long way round when the shortcut opens.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { EAST_LAKE, WEST_LAKE } from "../../../util/Canals";
import { setup } from "../../../util/Setup";
import { expectReplayMatches } from "../util/Expect";
import { recordGame, TickScript } from "../util/RecordGame";

/** Sailors, and boats each (a player has at most three at sea). */
const SAILORS = 3;
const BOATS_EACH = 3;
/** Tick the boats start launching, once the water graph has the lakes. */
const LAUNCH = 40;
/** Tick the shortcut opens, with every boat on the long way round. */
const SHORTCUT = 70;

type Rect = { x0: number; y0: number; x1: number; y1: number };

// plains (100x100): two lakes with an 8-tile neck of the builder's land
// between them (Canals.ts), joined the long way by a channel south of them.
// The sailors hold only the west lake's west shore, so their boats to the
// enemy past the east lake sail round until the neck opens.
const WATER: Rect[] = [
  WEST_LAKE,
  EAST_LAKE,
  { x0: 24, y0: 60, x1: 25, y1: 90 },
  { x0: 24, y0: 89, x1: 63, y1: 90 },
  { x0: 62, y0: 60, x1: 63, y1: 90 },
];

function tiles(game: Game, r: Rect): TileRef[] {
  const out: TileRef[] = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) out.push(game.ref(x, y));
  }
  return out;
}

interface Scenario {
  game: Game;
  builder: Player;
  enemy: Player;
  sailors: Player[];
}

async function lakes(): Promise<Scenario> {
  const sailorInfos = Array.from(
    { length: SAILORS },
    (_, i) =>
      new PlayerInfo(`sailor${i}`, PlayerType.Human, `client_s${i}`, `sailor${i}`),
  );
  const game = await setup(
    "plains",
    { disableNavMesh: false, instantBuild: true, infiniteGold: true },
    [
      new PlayerInfo("builder", PlayerType.Human, "client1", "builder_id"),
      new PlayerInfo("enemy", PlayerType.Human, "client2", "enemy_id"),
      ...sailorInfos,
    ],
  );
  return {
    game,
    builder: game.player("builder_id"),
    enemy: game.player("enemy_id"),
    sailors: sailorInfos.map((p) => game.player(p.id)),
  };
}

/**
 * The scenario's first ticks, inside a tick so the update stream carries
 * them: the water dug (as canals dig it), then the land claimed. The
 * sailors split the west shore into bands.
 */
function shapeTheMap(s: Scenario): void {
  s.game.addExecution(
    new TickScript((g) => {
      for (const r of WATER) {
        for (const t of tiles(g, r)) g.queueWaterConversion(t, true);
      }
      return true;
    }),
    new TickScript((g) => {
      // Once the conversions have flushed.
      if (g.isLand(g.ref(30, 50))) return false;
      const { y0, y1 } = WEST_LAKE;
      const band = Math.ceil((y1 - y0 + 1) / SAILORS);
      g.forEachTile((t) => {
        if (!g.isLand(t)) return;
        const x = g.x(t);
        const y = g.y(t);
        if (x < 20) {
          // Each sailor a stretch of the lake's west shore.
          if (y >= y0 && y <= y1) {
            s.sailors[Math.min(SAILORS - 1, Math.floor((y - y0) / band))].conquer(t);
          }
        } else if (x <= 47) s.builder.conquer(t);
        else if (x >= 68) s.enemy.conquer(t);
      });
      for (const sailor of s.sailors) sailor.setTroops(1_000_000);
      return true;
    }),
  );
}

/** Boats to the far side of the east lake, one per tick. */
function launchBoat(s: Scenario, tick: number): void {
  const i = tick - LAUNCH;
  if (i < 0 || i >= SAILORS * BOATS_EACH) return;
  s.game.addExecution(
    new TransportShipExecution(
      s.sailors[i % SAILORS],
      s.game.ref(68, 42 + i),
      1_000,
    ),
  );
}

function boats(s: Scenario) {
  return s.sailors.flatMap((p) => p.units(UnitType.TransportShip));
}

function throughTheNeck(s: Scenario): boolean {
  return boats(s).some((boat) => {
    const x = s.game.x(boat.tile());
    return x >= 40 && x <= 47 && s.game.y(boat.tile()) < 60;
  });
}

async function voyage(open: (s: Scenario) => void) {
  const s = await lakes();
  let routedThrough = false;
  let longWay = 0;
  const rec = await recordGame(s.game, {
    ticks: 330,
    keyframeInterval: 50,
    skipInit: true,
    beforeTick: (_, tick) => {
      if (tick === 0) shapeTheMap(s);
      launchBoat(s, tick);
      if (tick === SHORTCUT) {
        longWay = boats(s).length;
        open(s);
      }
      if (throughTheNeck(s)) routedThrough = true;
    },
  });
  // Every boat was on the long way round, and the shortcut was taken.
  expect(longWay).toBe(SAILORS * BOATS_EACH);
  expect(s.game.isWater(s.game.ref(44, 50))).toBe(true);
  expect(routedThrough).toBe(true);
  return rec;
}

describe("ships re-plan in the tick the water graph changes their route", () => {
  test("a canal opens a shortcut while boats sail the long way", async () => {
    const rec = await voyage((s) => {
      // The builder digs through the neck (instant build).
      s.game.addExecution(
        new ConstructionExecution(
          s.builder,
          UnitType.Canal,
          s.game.ref(44, 50),
        ),
      );
    });
    expectReplayMatches(rec);
  }, 120_000);

  test("a tide wave floods a shortcut while boats sail the long way", async () => {
    const rec = await voyage((s) => {
      // A wave floods the neck the way RisingTideExecution does: always
      // water, and the graph rebuilt in the same tick.
      s.game.addExecution(
        new TickScript((game) => {
          const neck = tiles(game, { x0: 40, y0: 48, x1: 47, y1: 52 });
          for (const t of neck) s.builder.relinquish(t);
          for (const t of neck) game.queueWaterConversion(t, true, true);
          return true;
        }),
      );
    });
    expectReplayMatches(rec);
  }, 120_000);
});
