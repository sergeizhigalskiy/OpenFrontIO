import {
  GameUpdateType,
  PlayerUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { WAR_MEMORY_TICKS } from "@openfront/engine-lib/game/TradeRoutes";
import { diffPlayerUpdate } from "@openfront/engine/game/GameUpdateUtils";
import { describe, expect, it } from "vitest";
import { atWarInView } from "../../src/client/WebGLFrameBuilder";
import { makePlayerUpdate, makePlayerView } from "../util/viewStubs";

/** Players 1 and 2; player 1 launched an attack at 2 on tick 100. */
function pair(data: Partial<PlayerUpdate> = {}) {
  const a = makePlayerView({
    data: { id: "a", smallID: 1, hostileActs: [2, 100], ...data },
  });
  const b = makePlayerView({ data: { id: "b", smallID: 2 } });
  return { a, b };
}

describe("the blockade ring's war rule on the client", () => {
  it("holds 1199 ticks after the last attack and lifts at 1200, either way round", () => {
    expect(WAR_MEMORY_TICKS).toBe(1200);
    const { a, b } = pair();
    expect(a.lastHostileActTick(b)).toBe(100);
    expect(b.lastHostileActTick(a)).toBeUndefined();
    expect(atWarInView(a, b, 100 + 1199)).toBe(true);
    expect(atWarInView(b, a, 100 + 1199)).toBe(true);
    expect(atWarInView(a, b, 100 + 1200)).toBe(false);
    expect(atWarInView(b, a, 100 + 1200)).toBe(false);
  });

  it("an attack still running counts at any tick", () => {
    const { a, b } = pair({
      hostileActs: [],
      outgoingAttacks: [
        { attackerID: 1, targetID: 2, troops: 10, id: "x", retreating: false },
      ],
    });
    expect(atWarInView(b, a, 1_000_000)).toBe(true);
  });

  it("allies are never at war", () => {
    const { a, b } = pair({ allies: [2] });
    expect(atWarInView(a, b, 150)).toBe(false);
    expect(atWarInView(b, a, 150)).toBe(false);
  });

  it("the engine's record reaches the view and later changes are sent", () => {
    const first = makePlayerUpdate({
      id: "a",
      smallID: 1,
      hostileActs: [2, 100],
    });
    const a = makePlayerView({ data: first });
    const b = makePlayerView({ data: { id: "b", smallID: 2 } });
    const c = makePlayerView({ data: { id: "c", smallID: 5 } });
    expect(a.lastHostileActTick(b)).toBe(100);
    const next = { ...first, hostileActs: [2, 100, 5, 140] };
    const diff = diffPlayerUpdate(first, next);
    expect(diff?.hostileActs).toEqual([2, 100, 5, 140]);
    a.applyUpdate(diff!);
    expect(a.lastHostileActTick(c)).toBe(140);
    // An update without the field leaves it as it was.
    a.applyUpdate({ type: GameUpdateType.Player, id: "a" } as PlayerUpdate);
    expect(a.lastHostileActTick(c)).toBe(140);
    expect(diffPlayerUpdate(next, { ...next })).toBeNull();
  });
});
