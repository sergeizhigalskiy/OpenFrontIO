import {
  GameMode,
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DisplayMessageUpdate,
  GameUpdateType,
  ProtectedStateUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  exclusiveModeError,
  exclusiveModesOn,
  modeWinRuleKey,
} from "@openfront/engine-lib/game/ModeExclusions";
import {
  CALL_TO_WAR_ATTACK_WINDOW_TICKS,
  CALL_TO_WAR_COOLDOWN_TICKS,
  CALL_TO_WAR_GOLD_SHARE,
  CALL_TO_WAR_MIN_GOLD,
  CALL_TO_WAR_TICKS,
  callToWarCost,
  namesProtectedState,
  PATRON_RECOMPUTE_TICKS,
  patronConvoyTroops,
  PEACE_CONVOY_SHARE,
  PEACE_CONVOY_TICKS,
  PROTECTED_INCOME_MULTIPLIER,
  PROTECTED_STATE_MODE_NAME,
  PROTECTED_STATE_NATION,
  PROTECTED_STATE_PATRONS,
  protectedIncomeBonus,
  protectedStateOn,
  TRIBUTE_SHARE,
  TRIBUTE_TICKS,
  tributePerPatron,
  UNDER_ATTACK_TICKS,
  WAR_CONVOY_SHARE,
  WAR_CONVOY_TICKS,
} from "@openfront/engine-lib/game/ProtectedState";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  CONVOY_TILES_PER_TICK,
  ConvoyExecution,
  ConvoyExecutionSnapshot,
} from "@openfront/engine/execution/ConvoyExecution";
import { convoyStraightDistance } from "@openfront/engine/execution/ConvoyRoute";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  ProtectedStateExecution,
  ProtectedStateExecutionSnapshot,
} from "@openfront/engine/execution/ProtectedStateExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { GameImpl } from "@openfront/engine/game/GameImpl";
import {
  callToWarTargetFor,
  isShielded,
  protectedStateMode,
} from "@openfront/engine/game/ProtectedStateLink";
import { EXECUTION_SNAPSHOT_TYPES } from "@openfront/engine/snapshot/ExecutionRegistry";
import { conquerRect, runUntil } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// plains: 100x100, all land. No PlayerExecution runs, so nobody earns gold
// or grows troops unless a test gives them.
const PLAINS = "plains";
const MIN_GOLD = BigInt(CALL_TO_WAR_MIN_GOLD);
// The patrons' troops, strongest first, and delta's (no patron).
const A = 300_000;
const B = 250_000;
const C = 200_000;
const D = 150_000;

function addPlayer(
  game: Game,
  id: string,
  type: PlayerType,
  rect: [number, number, number, number],
  troops: number,
): Player {
  const p = game.addPlayer(
    new PlayerInfo(id, type, type === PlayerType.Human ? `c_${id}` : null, id),
  );
  conquerRect(game, p, ...rect);
  p.setTroops(troops);
  return p;
}

/**
 * The plains with a small nation in the middle and four bigger nations in
 * the corners (strongest first), plus a human, a tribe and a city-state
 * stronger than all of them. The human and the tribe are smaller than the
 * small nation. `tinyGold` is the small nation's gold before the mode starts
 * (gold given later counts as income, which earns the bonus).
 */
async function protectedGame(
  nation: string | null = null,
  tinyGold: bigint = 0n,
) {
  const game = await setup(PLAINS, { protectedState: true });
  const N = PlayerType.Nation;
  const tiny = addPlayer(game, "tiny", N, [48, 48, 53, 53], 10_000);
  tiny.addGold(tinyGold);
  const alpha = addPlayer(game, "alpha", N, [0, 0, 30, 30], A);
  const bravo = addPlayer(game, "bravo", N, [70, 0, 100, 30], B);
  const charlie = addPlayer(game, "charlie", N, [0, 70, 30, 100], C);
  const delta = addPlayer(game, "delta", N, [70, 70, 100, 100], D);
  const human = addPlayer(
    game,
    "human",
    PlayerType.Human,
    [20, 40, 22, 42],
    900_000,
  );
  const tribe = addPlayer(
    game,
    "tribe",
    PlayerType.Bot,
    [90, 45, 95, 46],
    800_000,
  );
  const cityState = addPlayer(
    game,
    "citystate",
    PlayerType.Bot,
    [85, 35, 95, 44],
    700_000,
  );
  cityState.markCityState();
  const exec = new ProtectedStateExecution(nation);
  game.addExecution(exec);
  // Init, then the first tick picks.
  executeTicks(game, 2);
  return { game, exec, tiny, alpha, bravo, charlie, delta, human, tribe };
}

/** protectedGame with echo, a weak nation on tiny's east side, added after the pick. */
async function warGame(tinyGold: bigint = 0n) {
  const g = await protectedGame(null, tinyGold);
  const echo = addPlayer(
    g.game,
    "echo",
    PlayerType.Nation,
    [53, 48, 60, 53],
    50_000,
  );
  return { ...g, echo };
}

/** Every execution the game is sent from now on. */
function sent(game: Game) {
  const spy = vi.spyOn(game, "addExecution");
  spy.mockClear();
  return () => spy.mock.calls.map((c) => c[0]);
}

function messages(game: Game, ticks: number): DisplayMessageUpdate[] {
  const out: DisplayMessageUpdate[] = [];
  for (let i = 0; i < ticks; i++) {
    const u = game.executeNextTick()[GameUpdateType.DisplayEvent];
    out.push(...(u as DisplayMessageUpdate[]));
  }
  return out;
}

// Ratios 0: it sends everything it may.
function behaviorFor(game: Game, player: Player): NationAttackBehavior {
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

describe("Protected State rules", () => {
  test("the designer's two constants ship as the spec says", () => {
    expect(PROTECTED_STATE_NATION).toBeNull();
    expect(PROTECTED_STATE_MODE_NAME).toBe("Protected State");
  });

  test("the tuned numbers", () => {
    expect(PROTECTED_STATE_PATRONS).toBe(3);
    expect(PATRON_RECOMPUTE_TICKS).toBe(600);
    expect(TRIBUTE_TICKS).toBe(600);
    // Tuned from the spec's starting 0.3 (see ProtectedState.ts).
    expect(TRIBUTE_SHARE).toBe(0.6);
    expect(PROTECTED_INCOME_MULTIPLIER).toBe(1.5);
    expect(PEACE_CONVOY_TICKS).toBe(300);
    expect(PEACE_CONVOY_SHARE).toBe(0.02);
    expect(WAR_CONVOY_TICKS).toBe(150);
    expect(WAR_CONVOY_SHARE).toBe(0.08);
    expect(UNDER_ATTACK_TICKS).toBe(100);
    expect(CALL_TO_WAR_TICKS).toBe(1200);
    expect(CALL_TO_WAR_GOLD_SHARE).toBe(0.25);
    expect(CALL_TO_WAR_MIN_GOLD).toBe(100_000);
    expect(CALL_TO_WAR_COOLDOWN_TICKS).toBe(1800);
    expect(CALL_TO_WAR_ATTACK_WINDOW_TICKS).toBe(600);
  });

  test("off unless the config turns it on; old configs have no field", async () => {
    expect(protectedStateOn({})).toBe(false);
    expect(protectedStateOn({ protectedState: true })).toBe(true);
    const game = await setup(PLAINS, {});
    expect(game.config().protectedState()).toBe(false);
    expect(protectedStateMode(game)).toBeNull();
  });

  test("names match ignoring case and spaces; null names nobody", () => {
    expect(namesProtectedState("Luxembourg", "luxembourg")).toBe(true);
    expect(namesProtectedState("Luxembourg", "  LUXEMBOURG ")).toBe(true);
    expect(namesProtectedState("Luxembourg", "Belgium")).toBe(false);
    expect(namesProtectedState("Luxembourg", null)).toBe(false);
    expect(namesProtectedState("Luxembourg", "")).toBe(false);
  });

  test("income: the multiplier on all it earns; tribute: its share split evenly", () => {
    const bonus = BigInt(Math.round((PROTECTED_INCOME_MULTIPLIER - 1) * 1000));
    expect(protectedIncomeBonus(1_000n)).toBe(bonus);
    expect(protectedIncomeBonus(0n)).toBe(0n);
    const share = BigInt(Math.round(TRIBUTE_SHARE * 3000));
    expect(tributePerPatron(3_000n, 3)).toBe(share / 3n);
    expect(tributePerPatron(3_000n, 2)).toBe(share / 2n);
    expect(tributePerPatron(3_000n, 0)).toBe(0n);
  });

  test("a call to war costs its share of the gold, at least the minimum", () => {
    expect(callToWarCost(MIN_GOLD - 1n)).toBeNull();
    expect(callToWarCost(MIN_GOLD)).toBe(MIN_GOLD);
    const rich = MIN_GOLD * 10n;
    expect(callToWarCost(rich)).toBe(
      (rich * BigInt(Math.round(CALL_TO_WAR_GOLD_SHARE * 1000))) / 1000n,
    );
  });

  test("convoys carry their share of the patron's troops, rounded down", () => {
    expect(patronConvoyTroops(500_000, PEACE_CONVOY_SHARE)).toBe(
      Math.floor(500_000 * PEACE_CONVOY_SHARE),
    );
    expect(patronConvoyTroops(500_000, WAR_CONVOY_SHARE)).toBe(
      Math.floor(500_000 * WAR_CONVOY_SHARE),
    );
    expect(patronConvoyTroops(10, PEACE_CONVOY_SHARE)).toBe(0);
  });

  test("it can't be played with Boss Raid, Horde Night or the plague", () => {
    expect(exclusiveModesOn({ protectedState: true })).toEqual([
      "protectedState",
    ]);
    expect(modeWinRuleKey({ protectedState: true })).toBe(
      "protected_state.rules",
    );
    expect(exclusiveModeError({ protectedState: true })).toBeNull();
    expect(exclusiveModeError({ protectedState: true, plague: true })).toBe(
      `the zombie plague and ${PROTECTED_STATE_MODE_NAME} can't be played together`,
    );
    expect(
      exclusiveModeError({
        protectedState: true,
        hordeNight: { enabled: true },
      }),
    ).toBe(
      `Horde Night and ${PROTECTED_STATE_MODE_NAME} can't be played together`,
    );
    expect(
      exclusiveModeError({
        gameMode: GameMode.Team,
        bossRaid: { boss: "nation" },
        protectedState: true,
      }),
    ).toBe(
      `Boss Raid and ${PROTECTED_STATE_MODE_NAME} can't be played together`,
    );
  });
});

describe("Protected State designation", () => {
  test("the nation with the fewest tiles gets it, never a human or a tribe", async () => {
    const { exec, tiny } = await protectedGame();
    expect(exec.protectedState()).toBe(tiny);
  });

  test("a named nation gets it, by name in any case", async () => {
    const { exec, charlie } = await protectedGame("CHARLIE");
    expect(exec.protectedState()).toBe(charlie);
  });

  test("a name the map doesn't have falls back to the smallest nation", async () => {
    const { exec, tiny } = await protectedGame("Atlantis");
    expect(exec.protectedState()).toBe(tiny);
  });

  test("it is announced to everyone and sent to the view", async () => {
    const game = await setup(PLAINS, { protectedState: true });
    const tiny = addPlayer(game, "tiny", PlayerType.Nation, [0, 0, 5, 5], 1);
    const big = addPlayer(game, "big", PlayerType.Nation, [50, 50, 70, 70], 9);
    game.addExecution(new ProtectedStateExecution());
    game.executeNextTick();
    const updates = game.executeNextTick();
    const msg = (
      updates[GameUpdateType.DisplayEvent] as DisplayMessageUpdate[]
    ).find((m) => m.message === "events_display.protected_state_named");
    expect(msg?.playerID).toBeNull();
    expect(msg?.params).toEqual({
      nation: "tiny",
      mode: PROTECTED_STATE_MODE_NAME,
    });
    expect(msg?.messageType).toBe(MessageType.ALLIANCE_ACCEPTED);
    const view = updates[GameUpdateType.Cataclysm] as ProtectedStateUpdate[];
    expect(view).toContainEqual({
      type: GameUpdateType.Cataclysm,
      kind: "protectedState",
      state: tiny.smallID(),
      patrons: [big.smallID()],
    });
  });

  test("with no nation the mode just stops", async () => {
    const game = await setup(PLAINS, { protectedState: true });
    addPlayer(game, "human", PlayerType.Human, [0, 0, 5, 5], 1);
    const exec = new ProtectedStateExecution();
    game.addExecution(exec);
    executeTicks(game, 2);
    expect(exec.protectedState()).toBeNull();
    expect(exec.isActive()).toBe(false);
  });

  test("when it falls the mode ends quietly and nobody takes its place", async () => {
    const { game, exec, tiny, delta } = await protectedGame();
    for (const t of Array.from(tiny.tiles())) delta.conquer(t);
    expect(tiny.isAlive()).toBe(false);
    const updates = game.executeNextTick();
    expect(exec.isActive()).toBe(false);
    expect(exec.protectedState()).toBeNull();
    expect(exec.currentPatrons()).toEqual([]);
    expect(protectedStateMode(game)?.protectedState()).toBeNull();
    expect(updates[GameUpdateType.Cataclysm]).toContainEqual({
      type: GameUpdateType.Cataclysm,
      kind: "protectedState",
      state: 0,
      patrons: [],
    });
    const said = (
      updates[GameUpdateType.DisplayEvent] as DisplayMessageUpdate[]
    ).filter((m) => m.message.startsWith("events_display.protected_state"));
    expect(said).toEqual([]);
  });
});

describe("Protected State patrons", () => {
  test("the 3 strongest nations by troops, never a human, tribe or city-state", async () => {
    const { exec, alpha, bravo, charlie } = await protectedGame();
    expect(exec.currentPatrons()).toEqual([alpha, bravo, charlie]);
  });

  test("recomputed every 60 seconds", async () => {
    const { game, exec, alpha, bravo, delta } = await protectedGame();
    delta.setTroops(A * 2);
    executeTicks(game, PATRON_RECOMPUTE_TICKS - 1);
    expect(exec.currentPatrons()).not.toContain(delta);
    executeTicks(game, 1);
    expect(exec.currentPatrons()).toEqual([delta, alpha, bravo]);
  });

  test("never attack it, by land or boat", async () => {
    const { game, tiny, alpha, delta } = await protectedGame();
    expect(isShielded(game, tiny, alpha)).toBe(true);
    expect(alpha.canAttackPlayer(tiny)).toBe(false);
    // A nation that isn't a patron still can.
    expect(isShielded(game, tiny, delta)).toBe(false);
    expect(delta.canAttackPlayer(tiny)).toBe(true);

    conquerRect(game, alpha, 30, 48, 48, 53);
    const tilesBefore = tiny.numTilesOwned();
    game.addExecution(new AttackExecution(100_000, alpha, tiny.id()));
    executeTicks(game, 20);
    expect(tiny.numTilesOwned()).toBe(tilesBefore);
    expect(alpha.outgoingAttacks()).toEqual([]);

    // The AI won't send one either, even forced.
    const out = sent(game);
    const ai = behaviorFor(game, alpha);
    expect(ai.sendAttack(tiny)).toBe(false);
    expect(ai.sendAttack(tiny, true)).toBe(false);
    expect(out()).toEqual([]);
  });

  test("never break an alliance with it", async () => {
    const { game, tiny, alpha, delta } = await protectedGame();
    alpha.createAllianceRequest(tiny)!.accept();
    alpha.createAllianceRequest(delta)!.accept();
    const alliance = new NationAllianceBehavior(
      new PseudoRandom(1),
      game,
      alpha,
      { sendEmoji: vi.fn() } as any,
    );
    // Far weaker than alpha: a Medium nation betrays an ally like that.
    tiny.setTroops(1);
    delta.setTroops(1);
    expect(alliance.maybeBetray(tiny, null, [tiny], [])).toBe(false);
    expect(alpha.isAlliedWith(tiny)).toBe(true);
    expect(alliance.maybeBetray(delta, null, [delta], [])).toBe(true);
  });

  test("a patron doesn't answer the Protected State's attacks", async () => {
    const { game, tiny, alpha, delta } = await protectedGame();
    tiny.createAttack(alpha, 50_000, null, new Set());
    tiny.createAttack(delta, 50_000, null, new Set());
    expect(behaviorFor(game, alpha).findIncomingAttackPlayer()).toBeNull();
    expect(behaviorFor(game, delta).findIncomingAttackPlayer()).toBe(tiny);
  });
});

describe("Protected State tribute and income", () => {
  test("it earns the multiplier, and every 60 seconds pays its share to its patrons", async () => {
    const { game, tiny, alpha, bravo, charlie, delta } = await protectedGame();
    const gold = (p: Player) => p.gold();
    const before = [alpha, bravo, charlie, delta].map(gold);
    tiny.addGold(20_000n);
    executeTicks(game, 10);
    // The income bonus on what it earned.
    const earned = 20_000n + protectedIncomeBonus(20_000n);
    expect(tiny.gold()).toBe(earned);
    executeTicks(game, TRIBUTE_TICKS - 10);
    // Its share of all it earned, evenly to the patrons, none to anyone else.
    const each = tributePerPatron(earned, 3);
    expect(each).toBeGreaterThan(0n);
    expect(tiny.gold()).toBe(earned - 3n * each);
    expect([alpha, bravo, charlie, delta].map(gold)).toEqual([
      before[0] + each,
      before[1] + each,
      before[2] + each,
      before[3],
    ]);
  });

  test("it never pays more than it holds", async () => {
    const { game, exec, tiny, alpha, bravo } = await protectedGame();
    tiny.addGold(100_000n);
    executeTicks(game, 10);
    const each = tributePerPatron(100_000n + protectedIncomeBonus(100_000n), 3);
    // It spends all but less than one patron's share.
    tiny.removeGold(tiny.gold() - each / 2n);
    const alphaGold = alpha.gold();
    const bravoGold = bravo.gold();
    executeTicks(game, TRIBUTE_TICKS - 10);
    expect(exec.totalTributePaid()).toBe(each / 2n);
    expect(alpha.gold()).toBe(alphaGold + each / 2n);
    expect(bravo.gold()).toBe(bravoGold);
    expect(tiny.gold()).toBe(0n);
  });
});

describe("Protected State troop convoys", () => {
  const convoyTroops = (p: Player) =>
    p.units(UnitType.Convoy).map((c) => c.troops());

  test("in peace each patron sends its share of troops every 30 seconds", async () => {
    const { game, tiny, alpha, bravo, charlie, delta } = await protectedGame();
    const out = sent(game);
    const convoys = () => out().filter((e) => e instanceof ConvoyExecution);
    // Picked on the tick before: the first convoys leave 30 s after it.
    executeTicks(game, PEACE_CONVOY_TICKS - 1);
    expect(convoys()).toHaveLength(0);
    executeTicks(game, 1);
    expect(convoys()).toHaveLength(3);
    const share = (troops: number) =>
      patronConvoyTroops(troops, PEACE_CONVOY_SHARE);
    expect(convoyTroops(alpha)).toEqual([share(A)]);
    expect(convoyTroops(bravo)).toEqual([share(B)]);
    expect(convoyTroops(charlie)).toEqual([share(C)]);
    expect(convoyTroops(delta)).toEqual([]);
    expect(alpha.troops()).toBe(A - share(A));
    // They arrive and add to its troops.
    const troopsBefore = tiny.troops();
    executeTicks(game, 80);
    expect(alpha.units(UnitType.Convoy)).toEqual([]);
    expect(tiny.troops()).toBe(troopsBefore + share(A) + share(B) + share(C));
    executeTicks(game, PEACE_CONVOY_TICKS - 80);
    expect(convoys()).toHaveLength(6);
  });

  test("never more than it has room for, counting what is on the way", async () => {
    const { game, tiny, alpha, bravo, charlie } = await protectedGame();
    const first = patronConvoyTroops(A, PEACE_CONVOY_SHARE);
    const left = first + 1_000;
    const room = Math.floor(game.config().maxTroops(tiny) - tiny.troops());
    tiny.setTroops(tiny.troops() + room - left);
    executeTicks(game, PEACE_CONVOY_TICKS);
    const carried = (p: Player) => convoyTroops(p).reduce((s, t) => s + t, 0);
    expect(carried(alpha)).toBe(first);
    expect(carried(bravo)).toBe(1_000);
    expect(carried(charlie)).toBe(0);
  });

  test("under attack: its war share every 15 seconds", async () => {
    const { game, tiny, alpha, echo } = await warGame();
    tiny.setTroops(1_000);
    const out = sent(game);
    const convoys = () => out().filter((e) => e instanceof ConvoyExecution);
    // An attack on it that stays on (no execution fights it out).
    const attack = echo.createAttack(tiny, 10_000, null, new Set());
    executeTicks(game, WAR_CONVOY_TICKS - 1);
    expect(convoys()).toHaveLength(0);
    executeTicks(game, 1);
    expect(convoys()).toHaveLength(3);
    expect(convoyTroops(alpha)).toEqual([
      patronConvoyTroops(A, WAR_CONVOY_SHARE),
    ]);
    // Once they have arrived, it is short of troops again.
    executeTicks(game, 100);
    tiny.setTroops(1_000);
    executeTicks(game, WAR_CONVOY_TICKS - 100);
    expect(convoys()).toHaveLength(6);
    // UNDER_ATTACK_TICKS after the attack ends it is at peace again: none
    // after 15 s, the next 30 s after the last.
    attack.delete();
    executeTicks(game, 100);
    tiny.setTroops(1_000);
    executeTicks(game, WAR_CONVOY_TICKS - 100);
    expect(convoys()).toHaveLength(6);
    executeTicks(game, PEACE_CONVOY_TICKS - WAR_CONVOY_TICKS);
    expect(convoys()).toHaveLength(9);
  });

  test("a patron's convoy needs no alliance and leaves the relation alone", async () => {
    const { game, tiny, alpha } = await protectedGame();
    expect(alpha.isFriendly(tiny)).toBe(false);
    const relation = tiny.relation(alpha);
    const troops = tiny.troops();
    executeTicks(game, PEACE_CONVOY_TICKS + 80);
    expect(alpha.units(UnitType.Convoy)).toEqual([]);
    expect(tiny.troops()).toBeGreaterThan(troops);
    expect(tiny.relation(alpha)).toBe(relation);
  });

  test("with no route the troops arrive after a convoy's travel time", async () => {
    const { game, tiny, alpha, bravo, charlie } = await protectedGame();
    // A sea 7 tiles wide all round tiny: no overland route and no shore.
    for (let x = 38; x < 63; x++) {
      for (let y = 38; y < 63; y++) {
        if (x < 45 || x >= 56 || y < 45 || y >= 56) {
          (game as GameImpl).setWater(game.ref(x, y));
        }
      }
    }
    const share = (troops: number) =>
      patronConvoyTroops(troops, PEACE_CONVOY_SHARE);
    const before = tiny.troops();
    executeTicks(game, PEACE_CONVOY_TICKS);
    // The troops left, with no convoy on the map.
    expect(alpha.units(UnitType.Convoy)).toEqual([]);
    expect(alpha.troops()).toBe(A - share(A));
    expect(bravo.troops()).toBe(B - share(B));
    // Each lot lands when a convoy covering the distance would.
    const travel = Math.max(
      ...[alpha, bravo, charlie].map((p) =>
        Math.ceil(
          convoyStraightDistance(game, p, tiny) / CONVOY_TILES_PER_TICK,
        ),
      ),
    );
    expect(travel).toBeGreaterThan(10);
    const all = before + share(A) + share(B) + share(C);
    executeTicks(game, travel - 1);
    expect(tiny.troops()).toBeLessThan(all);
    executeTicks(game, 1);
    expect(tiny.troops()).toBe(all);
    expect(charlie.troops()).toBe(C - share(C));
  });
});

describe("Protected State calls to war", () => {
  test("on whoever attacked it most, at its share of its gold", async () => {
    const rich = MIN_GOLD * 10n;
    const { game, exec, tiny, echo, alpha, delta } = await warGame(rich);
    // Echo is its only neighbour, but delta sent more at it.
    echo.createAttack(tiny, 10_000, null, new Set());
    const lunge = delta.createAttack(tiny, 50_000, null, new Set());
    const said = messages(game, 12);
    lunge.delete();
    expect(exec.currentCallToWar()?.target).toBe(delta);
    expect(exec.callsToWarMade()).toBe(1);
    expect(tiny.gold()).toBe(rich - callToWarCost(rich)!);
    const msg = said.find(
      (m) => m.message === "events_display.protected_state_call_to_war",
    );
    expect(msg?.playerID).toBeNull();
    expect(msg?.params).toEqual({ nation: "tiny", target: "delta" });
    expect(msg?.messageType).toBe(MessageType.ATTACK_REQUEST);
    expect(callToWarTargetFor(game, alpha)).toBe(delta);
    // Only patrons answer, and the target is no patron.
    expect(callToWarTargetFor(game, echo)).toBeNull();
    expect(callToWarTargetFor(game, delta)).toBeNull();
  });

  test("with nobody attacking it, on its strongest neighbour", async () => {
    const { game, exec, tiny, echo } = await warGame(MIN_GOLD);
    executeTicks(game, 12);
    expect(exec.currentCallToWar()?.target).toBe(echo);
    expect(tiny.gold()).toBe(0n);
  });

  test("not below the minimum, then once per cooldown, for its duration", async () => {
    const { game, exec, tiny, echo } = await warGame(MIN_GOLD - 1n);
    executeTicks(game, 30);
    expect(exec.currentCallToWar()).toBeNull();
    tiny.addGold(MIN_GOLD * 4n);
    runUntil(game, () => exec.currentCallToWar() !== null, 30);
    const first = exec.currentCallToWar()!;
    expect(first.target).toBe(echo);
    const calledAt = first.endTick - CALL_TO_WAR_TICKS;
    expect(exec.callToWar(echo)).toBe(false);
    runUntil(game, () => game.ticks() > first.endTick, CALL_TO_WAR_TICKS + 5);
    expect(exec.currentCallToWar()).toBeNull();
    runUntil(
      game,
      () => game.ticks() >= calledAt + CALL_TO_WAR_COOLDOWN_TICKS - 1,
      CALL_TO_WAR_COOLDOWN_TICKS,
    );
    expect(exec.callsToWarMade()).toBe(1);
    executeTicks(game, 20);
    expect(exec.callsToWarMade()).toBe(2);
  });

  test("a patron friendly with the target stays out", async () => {
    const { game, exec, echo, alpha, bravo } = await warGame(MIN_GOLD);
    alpha.createAllianceRequest(echo)!.accept();
    executeTicks(game, 12);
    expect(exec.currentCallToWar()?.target).toBe(echo);
    expect(callToWarTargetFor(game, alpha)).toBeNull();
    expect(callToWarTargetFor(game, bravo)).toBe(echo);
  });

  test("a called patron attacks the target, sized and aimed as usual", async () => {
    const { game, echo, alpha } = await warGame(MIN_GOLD);
    // alpha borders echo, not tiny.
    conquerRect(game, alpha, 60, 30, 70, 53);
    executeTicks(game, 12);
    expect(callToWarTargetFor(game, alpha)).toBe(echo);
    const out = sent(game);
    behaviorFor(game, alpha).maybeAttack();
    const targets = out()
      .filter((e) => e instanceof AttackExecution)
      .map((e) => (e as AttackExecution).targetID());
    expect(targets).toContain(echo.id());
  });
});

describe("Protected State snapshots", () => {
  test("ProtectedState v1 is registered; Convoy v2 marks older convoys donations", () => {
    expect(ProtectedStateExecutionSnapshot.version).toBe(1);
    expect(EXECUTION_SNAPSHOT_TYPES).toContain(ProtectedStateExecutionSnapshot);
    expect(ConvoyExecutionSnapshot.version).toBe(2);
    expect(ConvoyExecutionSnapshot.migrations[1]({ pathIndex: 3 })).toEqual({
      pathIndex: 3,
      patronage: false,
    });
  });

  test("a game mid-mode restores and plays on the same", async () => {
    const { game, exec, tiny, echo, alpha } = await warGame(MIN_GOLD * 2n);
    echo.createAttack(tiny, 10_000, null, new Set());
    executeTicks(game, WAR_CONVOY_TICKS + 5);
    expect(exec.currentCallToWar()?.target).toBe(echo);
    expect(alpha.units(UnitType.Convoy)).toHaveLength(1);
    await expectSnapshotRoundTrip(game, PLAINS, 40);
  }, 60_000);
});
