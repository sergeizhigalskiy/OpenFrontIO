/**
 * Survival modes never make a nation passive (spec, Nation AI): answering an
 * attack comes first, The Infected goes ahead of other targets only once it
 * borders the nation on enough tiles and gets at most 60% of the spare
 * troops, and a nation holds back only for a horde band that borders it
 * with at least half its troops.
 */
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { HORDE_TEAM } from "@openfront/engine-lib/game/HordeNight";
import {
  INFECTED_NAME,
  INFECTED_PLAYER_ID,
} from "@openfront/engine-lib/game/Plague";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  fightSurvivalThreat,
  hordeTarget,
  NATION_HORDE_HOLD_TROOP_SHARE,
  NATION_PLAGUE_SPARE_SHARE,
  sharedBorderTiles,
  survivalTuning,
} from "@openfront/engine/execution/nation/NationSurvivalBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, test, vi } from "vitest";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";
import { createGame, L, W } from "../pathfinding/_fixtures";

// plains: 100x100, all land.
const PLAINS = "plains";
const RESERVE = 0.3;
const EXPAND = 0.1;

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) p.conquer(game.ref(x, y));
  }
}

function nation(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Nation, null, id);
}

function infectedOn(game: Game, rect: [number, number, number, number]) {
  const infected = game.addPlayer(
    new PlayerInfo(INFECTED_NAME, PlayerType.Bot, null, INFECTED_PLAYER_ID),
  );
  conquerRect(game, infected, ...rect);
  return infected;
}

function band(
  game: Game,
  id: string,
  rect: [number, number, number, number],
  troops: number,
): Player {
  const p = game.addPlayer(
    new PlayerInfo(id, PlayerType.Bot, null, id),
    HORDE_TEAM,
  );
  conquerRect(game, p, ...rect);
  p.setTroops(troops);
  return p;
}

function nationBehavior(game: Game, player: Player): NationAttackBehavior {
  return new NationAttackBehavior(
    new PseudoRandom(42),
    game,
    player,
    0,
    0,
    0,
    { maybeSendAllianceRequests: vi.fn(), maybeBetray: vi.fn() } as any,
    { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as any,
    { clearSeaLane: vi.fn() } as any,
  );
}

function attacksSent(game: Game) {
  const spy = vi.spyOn(game, "addExecution");
  return () =>
    spy.mock.calls
      .map((c) => c[0])
      .filter((e): e is AttackExecution => e instanceof AttackExecution);
}

describe("plague: The Infected ahead of other targets", () => {
  test("only from 50 shared border tiles at Medium, 30 at Hard and 20 at Impossible; never on Easy", async () => {
    for (const [difficulty, needed] of [
      [Difficulty.Medium, 50],
      [Difficulty.Hard, 30],
      [Difficulty.Impossible, 20],
    ] as const) {
      expect(survivalTuning(difficulty).infectedFirstBorder).toBe(needed);
      for (const shared of [needed - 1, needed]) {
        const game = await setup(PLAINS, { plague: true, difficulty }, [
          nation("n"),
        ]);
        const n = game.player("n");
        conquerRect(game, n, 1, 0, 50, 100);
        const infected = infectedOn(game, [0, 0, 1, shared]);
        expect(sharedBorderTiles(game, n, infected)).toBe(shared);
        n.setTroops(200_000);
        expect(
          fightSurvivalThreat(game, n, new PseudoRandom(3), RESERVE, EXPAND),
        ).toBe(shared >= needed);
      }
    }
    const game = await setup(
      PLAINS,
      { plague: true, difficulty: Difficulty.Easy },
      [nation("n")],
    );
    const n = game.player("n");
    conquerRect(game, n, 1, 0, 50, 100);
    infectedOn(game, [0, 0, 1, 100]);
    n.setTroops(200_000);
    expect(
      fightSurvivalThreat(game, n, new PseudoRandom(3), RESERVE, EXPAND),
    ).toBe(false);
  });

  test("commits at most 60% of its spare troops to it", async () => {
    expect(NATION_PLAGUE_SPARE_SHARE).toBe(0.6);
    // Medium keeps its reserve home, Hard only the expand ratio.
    for (const [difficulty, kept] of [
      [Difficulty.Medium, RESERVE],
      [Difficulty.Hard, EXPAND],
    ] as const) {
      const game = await setup(PLAINS, { plague: true, difficulty }, [
        nation("n"),
      ]);
      const n = game.player("n");
      conquerRect(game, n, 1, 0, 50, 100);
      infectedOn(game, [0, 0, 1, 100]);
      n.setTroops(200_000);
      const sent = attacksSent(game);
      expect(
        fightSurvivalThreat(game, n, new PseudoRandom(3), RESERVE, EXPAND),
      ).toBe(true);
      const spare = 200_000 - game.config().maxTroops(n) * kept;
      const [attack] = sent();
      expect(attack.targetID()).toBe(INFECTED_PLAYER_ID);
      expect(attack["startTroops"]).toBeCloseTo(spare * 0.6, 6);
    }
  });

  test("answering a player's attack comes first, ahead of The Infected", async () => {
    for (const difficulty of [Difficulty.Medium, Difficulty.Hard]) {
      const game = await setup(PLAINS, { plague: true, difficulty }, [
        nation("n"),
        nation("m"),
      ]);
      const [n, m] = [game.player("n"), game.player("m")];
      conquerRect(game, n, 1, 0, 60, 100);
      conquerRect(game, m, 60, 0, 100, 100);
      const infected = infectedOn(game, [0, 0, 1, 100]);
      expect(sharedBorderTiles(game, n, infected)).toBe(100);
      n.setTroops(200_000);
      m.setTroops(100_000);
      game.addExecution(new AttackExecution(20_000, m, n.id()));
      executeTicks(game, 1);
      const sent = attacksSent(game);
      nationBehavior(game, n).maybeAttack();
      expect(sent().map((a) => a.targetID())).toEqual([m.id()]);
    }
  });
});

describe("Horde Night: holding back for a band", () => {
  test("a band across a river is no target, and holds nothing back", () => {
    // A 1-tile river at x = 20: the band is nearby, but there's no land border.
    const width = 40;
    const height = 20;
    const grid: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) grid.push(x === 20 ? W : L);
    }
    const game = createGame(
      { width, height, grid },
      {
        difficulty: Difficulty.Hard,
        hordeNight: { enabled: true, survivalMinutes: 30 },
      },
    );
    game.addPlayer(nation("n"));
    const n = game.player("n");
    game.map().forEachTile((t) => {
      if (game.map().isLand(t) && game.x(t) < 20) n.conquer(t);
    });
    const b = band(game, "band", [21, 0, 40, 20], 100_000);
    expect(n.nearby()).toContain(b);
    expect(n.sharesBorderWith(b)).toBe(false);
    expect(hordeTarget(n)).toBeNull();
    n.setTroops(1_000);
    expect(
      fightSurvivalThreat(game, n, new PseudoRandom(1), RESERVE, EXPAND),
    ).toBe(false);
  });

  test("with nothing to spare it holds back only for a bordering band with at least half its troops", async () => {
    expect(NATION_HORDE_HOLD_TROOP_SHARE).toBe(0.5);
    for (const [bandTroops, holds] of [
      [600, true],
      [400, false],
    ] as const) {
      const game = await setup(
        PLAINS,
        {
          difficulty: Difficulty.Hard,
          hordeNight: { enabled: true, survivalMinutes: 30 },
        },
        [nation("n")],
      );
      const n = game.player("n");
      conquerRect(game, n, 0, 0, 50, 100);
      const b = band(game, "band", [50, 0, 100, 100], bandTroops);
      n.setTroops(1_000);
      // Nothing to spare: the expand ratio alone is more than it has.
      expect(game.config().maxTroops(n) * EXPAND).toBeGreaterThan(1_000);
      expect(hordeTarget(n)).toBe(b);
      expect(
        fightSurvivalThreat(game, n, new PseudoRandom(1), RESERVE, EXPAND),
      ).toBe(holds);
    }
  });
});
