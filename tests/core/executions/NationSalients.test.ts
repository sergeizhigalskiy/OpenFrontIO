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
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { attackForecast } from "@openfront/engine-lib/game/AttackForecast";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  cutOffPiece,
  findSalient,
  NATION_SALIENT_MIN_RINGS,
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
 * (98..102, 60) 40 tiles down, narrowed to 3 tiles at y = 80.
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
  conquerRect(game, h, 98, 60, 103, 100);
  for (const x of [98, 102]) n.conquer(game.ref(x, 80));
  h.setTroops(200_000);
  n.setTroops(600_000);
  return { game, h, n };
}

describe("finding a salient's neck", () => {
  it("is the narrowest ring between the tip and the main land, NATION_SALIENT_MIN_RINGS or more from the tip", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    const salient = findSalient(game, n, h, game.ref(100, 99));
    expect(salient).not.toBeNull();
    expect(salient!.neck.map((t) => game.y(t))).toEqual([80, 80, 80]);
    // The tip side: 5 tiles a row from y = 81 to 99.
    expect(salient!.cutOff).toBe(5 * 19);
    // Deeper than a spearhead's bulge (SPEAR_TIP_LEAD).
    expect(NATION_SALIENT_MIN_RINGS).toBe(16);
    // Narrowed nearer the tip than that, it is no neck (a tip's taper): the
    // corridor's mouth is.
    conquerRect(game, h, 98, 80, 103, 81);
    for (const x of [98, 102]) n.conquer(game.ref(x, 90));
    expect(
      findSalient(game, n, h, game.ref(100, 99))!.neck.map((t) => game.y(t)),
    ).toEqual([60, 60, 60, 60, 60]);
  });

  it("the nation's own survey finds a long tongue walled in by it alone", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Hard);
    const front = surveyFronts(game, n).get(h.smallID())!;
    const salient = surveySalient(game, n, h, front.tiles);
    expect(salient).not.toBeNull();
    expect(salient!.neck.map((t) => game.y(t))).toEqual([80, 80, 80]);
    // 10 deep, a bump on the front: no salient.
    for (let y = 70; y < 100; y++) {
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
    expect(findSalient(game, n, h, game.ref(100, 99))).toBeNull();
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
    // At war: the human attacked us a while ago.
    n.updateRelation(h, -100);
    // Above the 15% expand ratio, below the 35% reserve.
    n.setTroops(game.config().maxTroops(n) * 0.3);
    const sent = attacksSent(game);
    behavior(game, n).maybeAttack();
    const cut = sent().filter((a) => a.owner === n && a.target === h.id());
    expect(cut).toHaveLength(1);
    expect(game.y(cut[0].focus!)).toBe(80);
  });

  it("Hard severs a human's mushroom 60 tiles deep within a minute", async () => {
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
    // The human reaches the nation down a 10-wide strip through a third
    // player's band, and has pushed a 10-wide stem 30 tiles in and a 31-wide
    // cap past it to 60 deep: what a spearhead down a narrow front leaves.
    conquerRect(game, t, 0, 0, 200, 200);
    conquerRect(game, h, 0, 0, 200, 40);
    conquerRect(game, h, 96, 40, 106, 60);
    conquerRect(game, n, 20, 60, 180, 160);
    conquerRect(game, h, 96, 60, 106, 90);
    conquerRect(game, h, 85, 90, 116, 120);
    h.setTroops(600_000);
    n.setTroops(500_000);
    t.setTroops(100_000);
    for (const p of [h, n, t]) game.addExecution(new PlayerExecution(p));
    game.executeNextTick();
    game.addExecution(
      new AttackExecution(300_000, h, n.id(), null, true, game.ref(100, 119)),
    );
    const nation = behavior(game, n, 7919);
    const sent = attacksSent(game);
    let severed = -1;
    for (let i = 0; i < 600 && severed < 0; i++) {
      if (i >= 10 && i % 50 === 0) nation.maybeAttack();
      game.executeNextTick();
      if (cutOffPiece(game, h, game.ref(100, 110)) !== null) severed = i;
    }
    // Cut at the stem.
    const cuts = sent().filter(
      (a) =>
        a.owner === n &&
        a.target === h.id() &&
        a.focus !== null &&
        game.y(a.focus) >= 60 &&
        game.y(a.focus) < 90,
    );
    expect(cuts.length).toBeGreaterThan(0);
    expect(severed).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("Impossible hits a neck bordering it on both sides from the cheaper side", async () => {
    const { game, h, n } = await corridorGame(Difficulty.Impossible);
    n.updateRelation(h, -100);
    // A defense post of the human's covers the neck's west end (99, 80),
    // 29.7 tiles off, but not its east end (101, 80), 31.1 off.
    h.buildUnit(UnitType.DefensePost, game.ref(78, 59), {});
    const cost = (x: number) =>
      attackForecast(game, n, h, game.ref(x, 80), n.troops(), null).lossPerTile;
    expect(cost(101)).toBeLessThan(cost(99));
    const sent = attacksSent(game);
    behavior(game, n).maybeAttack();
    const cut = sent().filter((a) => a.owner === n && a.target === h.id());
    expect(cut).toHaveLength(1);
    expect(cut[0].focus).toBe(game.ref(101, 80));
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
