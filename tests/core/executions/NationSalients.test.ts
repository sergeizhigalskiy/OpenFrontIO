/**
 * Nations cut enemy spearheads (spearhead round, C): Medium and up answer a
 * hostile salient into their land with a spearhead at its neck, sized by the
 * forecast and sent even when they would hold back; Hard and up re-aim it as
 * the neck moves; Impossible hits it from the cheaper side. Easy doesn't.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { SPEAR_FREE_DEPTH } from "@openfront/engine-lib/game/AttackLogic";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  cutOffPiece,
  findSalient,
  NATION_NECK_TIP_MARGIN,
  surveySalient,
} from "@openfront/engine/execution/nation/NationSalients";
import { surveyFronts } from "@openfront/engine/execution/nation/NationSpearheads";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it, vi } from "vitest";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";

function behavior(game: Game, player: Player, seed = 1) {
  return new NationAttackBehavior(
    new PseudoRandom(seed),
    game,
    player,
    0.55,
    0.35,
    0.15,
    { maybeSendAllianceRequests: vi.fn(), maybeBetray: vi.fn() } as never,
    { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as never,
    { clearSeaLane: vi.fn() } as never,
  );
}

/** Attacks the game is sent from now on: owner, target and focus. */
function attacksSent(game: Game) {
  const spy = vi.spyOn(game, "addExecution");
  spy.mockClear();
  return () =>
    spy.mock.calls
      .map((c) => c[0])
      .filter((e): e is AttackExecution => e instanceof AttackExecution)
      .map((e) => {
        const x = e as unknown as {
          _owner: Player;
          focusTile: TileRef | null;
          startTroops: number;
        };
        return {
          owner: x._owner,
          target: e.targetID(),
          focus: x.focusTile,
          troops: x.startTroops,
        };
      });
}

/**
 * big_plains: the human holds y < 60, the nation x 20-179 by y 60-159 and a
 * third player the rest. A 5-tile-wide corridor of the human's runs from
 * (98..102, 60) 40 tiles down, narrowed to 3 tiles at y = 80: a spearhead's,
 * whose line starts at (100, 59).
 */
async function corridorGame(difficulty: Difficulty) {
  const game = await setup(
    "big_plains",
    { difficulty },
    [
      new PlayerInfo("h", PlayerType.Human, "c_h", "h"),
      new PlayerInfo("n", PlayerType.Nation, null, "n"),
      new PlayerInfo("t", PlayerType.Human, "c_t", "t"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  const [h, n, t] = ["h", "n", "t"].map((id) => game.player(id));
  conquerRect(game, t, 0, 0, 200, 200);
  conquerRect(game, h, 0, 0, 200, 60);
  conquerRect(game, n, 20, 60, 180, 160);
  h.startSpear(n, game.ref(100, 120));
  conquerRect(game, h, 98, 60, 103, 100);
  for (const x of [98, 102]) n.conquer(game.ref(x, 80));
  h.setTroops(200_000);
  n.setTroops(600_000);
  return { game, h, n };
}

describe("finding a salient's neck", () => {
  it("is the narrowest ring between the spear line's tip and the main land", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    expect(h.spearLine(n)!.origin).toBe(game.ref(100, 59));
    h.extendSpear(n, game.ref(100, 99), 40);
    const salient = findSalient(
      game,
      n,
      h,
      h.spearLine(n)!.tip,
      h.spearLine(n),
    );
    expect(salient).not.toBeNull();
    expect(salient!.neck.map((t) => game.y(t))).toEqual([80, 80, 80]);
    // The tip side: 5 tiles a row from y = 81 to 99.
    expect(salient!.cutOff).toBe(5 * 19);
    // Past the tip's taper only.
    expect(NATION_NECK_TIP_MARGIN).toBe(6);
  });

  it("the nation's own survey finds a long tongue walled in by it alone", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    const front = surveyFronts(game, n).get(h.smallID())!;
    const salient = surveySalient(game, n, h, front.tiles);
    expect(salient).not.toBeNull();
    expect(salient!.neck.map((t) => game.y(t))).toEqual([80, 80, 80]);
    // Half as long, a bump on the front: no salient.
    for (let y = 60 + SPEAR_FREE_DEPTH / 2; y < 100; y++) {
      for (let x = 98; x < 103; x++) n.conquer(game.ref(x, y));
    }
    expect(
      surveySalient(game, n, h, surveyFronts(game, n).get(h.smallID())!.tiles),
    ).toBeNull();
  });

  it("a bulge wider than it is long is a front, not a salient", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    // Widen the corridor to 45 tiles: 40 deep, its narrowest ring is wider.
    conquerRect(game, h, 78, 60, 123, 100);
    h.extendSpear(n, game.ref(100, 99), 40);
    expect(
      findSalient(game, n, h, h.spearLine(n)!.tip, h.spearLine(n)),
    ).toBeNull();
  });

  it("a cut-off piece is the owner's land around it, when it is cut off", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    expect(cutOffPiece(game, h, game.ref(100, 90))).toBeNull();
    for (let x = 99; x < 102; x++) n.conquer(game.ref(x, 80));
    expect(cutOffPiece(game, h, game.ref(100, 90))!.length).toBe(5 * 19);
  });
});

describe("answering a salient", () => {
  it("Medium and up spearhead at the neck at once, sized to cancel the spear and cross; Easy doesn't", async () => {
    for (const difficulty of [
      Difficulty.Easy,
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const { game, h, n } = await corridorGame(difficulty);
      h.extendSpear(n, game.ref(100, 99), 40);
      // A spearhead of the human's running on the nation.
      game.addExecution(
        new AttackExecution(50_000, h, n.id(), null, true, game.ref(100, 120)),
      );
      game.executeNextTick();
      const incoming = n.incomingAttacks().reduce((s, a) => s + a.troops(), 0);
      expect(incoming).toBeGreaterThan(0);
      const sent = attacksSent(game);
      behavior(game, n).maybeAttack();
      const atH = sent().filter((a) => a.owner === n && a.target === h.id());
      if (difficulty === Difficulty.Easy) {
        expect(
          atH.some((a) => a.focus !== null && game.y(a.focus) === 80),
        ).toBe(false);
        continue;
      }
      expect(atH, difficulty).toHaveLength(1);
      expect(game.y(atH[0].focus!)).toBe(80);
      expect(game.ownerID(atH[0].focus!)).toBe(h.smallID());
      expect(atH[0].troops).toBeGreaterThan(incoming);
    }
  }, 60_000);

  it("goes out even when the nation would otherwise hold back (below its reserve)", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Medium);
    h.extendSpear(n, game.ref(100, 99), 40);
    // Above the 15% expand ratio, below the 35% reserve.
    n.setTroops(game.config().maxTroops(n) * 0.3);
    const sent = attacksSent(game);
    behavior(game, n).maybeAttack();
    const cut = sent().filter((a) => a.owner === n && a.target === h.id());
    expect(cut).toHaveLength(1);
    expect(game.y(cut[0].focus!)).toBe(80);
  });

  it("Hard severs a human's spearhead 60 tiles in within a minute of it passing 30 deep", async () => {
    const game = await setup(
      "big_plains",
      { difficulty: Difficulty.Hard },
      [
        new PlayerInfo("h", PlayerType.Human, "c_h", "h"),
        new PlayerInfo("n", PlayerType.Nation, null, "n"),
        new PlayerInfo("t", PlayerType.Human, "c_t", "t"),
      ],
      undefined,
      UseRealAttackLogic,
    );
    const [h, n, t] = ["h", "n", "t"].map((id) => game.player(id));
    conquerRect(game, t, 0, 0, 200, 200);
    conquerRect(game, h, 0, 0, 200, 60);
    conquerRect(game, n, 20, 60, 180, 160);
    h.setTroops(600_000);
    n.setTroops(500_000);
    t.setTroops(100_000);
    for (const p of [h, n, t]) game.addExecution(new PlayerExecution(p));
    game.executeNextTick();
    game.addExecution(
      new AttackExecution(300_000, h, n.id(), null, true, game.ref(97, 119)),
    );
    const nation = behavior(game, n, 7919);
    const sent = attacksSent(game);
    let passed30 = -1;
    let severed = -1;
    for (let i = 0; i < 900 && severed < 0; i++) {
      if (i >= 10 && i % 50 === 0) nation.maybeAttack();
      game.executeNextTick();
      const line = h.spearLine(n);
      if (passed30 < 0 && line !== null && line.tipDepth >= 30) passed30 = i;
      if (passed30 >= 0 && line !== null) {
        const tip = line.tip;
        if (game.ownerID(tip) !== h.smallID() || cutOffPiece(game, h, tip)) {
          severed = i;
        }
      }
    }
    expect(passed30).toBeGreaterThanOrEqual(0);
    const cuts = sent().filter(
      (a) =>
        a.owner === n &&
        a.target === h.id() &&
        a.focus !== null &&
        game.y(a.focus) - 59 >= SPEAR_FREE_DEPTH,
    );
    expect(cuts.length).toBeGreaterThan(0);
    expect(severed).toBeGreaterThanOrEqual(0);
    expect(severed - passed30).toBeLessThanOrEqual(600);
  }, 60_000);

  it("Impossible hits a neck bordering it on both sides from the cheaper side", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Impossible);
    h.extendSpear(n, game.ref(100, 99), 40);
    // The nation's remembered spear line on the human starts west of the
    // neck, so its east end lies deeper on it (41 tiles against 39) and
    // costs more.
    n.startSpear(h, game.ref(80, 59));
    expect(n.spearLine(h)!.origin).toBe(game.ref(80, 60));
    const sent = attacksSent(game);
    behavior(game, n).maybeAttack();
    const cut = sent().filter((a) => a.owner === n && a.target === h.id());
    expect(cut).toHaveLength(1);
    expect(cut[0].focus).toBe(game.ref(99, 80));
  });

  it("a cut-off piece too big to annex is attacked next", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    // A 40 x 40 piece of the human's, walled in by the nation: 1,600 tiles,
    // more than its pocket limit (150 tiles or 5%).
    conquerRect(game, h, 40, 100, 80, 140);
    const nation = behavior(game, n);
    (nation as unknown as { salientCut: unknown }).salientCut = {
      target: h,
      tip: game.ref(60, 120),
      focus: game.ref(60, 99),
      tick: game.ticks(),
    };
    const sent = attacksSent(game);
    nation.maybeAttack();
    const atH = sent().filter((a) => a.owner === n && a.target === h.id());
    expect(atH).toHaveLength(1);
    expect(game.ownerID(atH[0].focus!)).toBe(h.smallID());
    expect(cutOffPiece(game, h, atH[0].focus!)!.length).toBe(1600);
  });
});
