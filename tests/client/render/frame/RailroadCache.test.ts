import {
  GameUpdateType,
  GameUpdateViewData,
} from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import {
  RAIL_CUT_FLAG,
  RailroadCache,
} from "../../../../src/client/render/frame/RailroadCache";

const W = 10;

function frame(
  updates: Partial<Record<GameUpdateType, unknown[]>>,
): GameUpdateViewData {
  return { updates } as unknown as GameUpdateViewData;
}

const snap = (id: number, tiles: number[]) => ({
  type: GameUpdateType.RailroadSnapEvent,
  originalId: -1,
  newId1: id,
  newId2: -2,
  tiles1: tiles,
  tiles2: [],
});
const cut = (id: number, isCut: boolean) => ({
  type: GameUpdateType.RailroadCutEvent,
  id,
  cut: isCut,
});

describe("RailroadCache cut rails", () => {
  // A snap adds its halves already drawn in, so no animation to wait for.
  const line = [1, 2, 3, 4];
  const branch = [4, 14, 24];

  it("flags a cut rail's tiles and clears them when it reconnects", () => {
    const cache = new RailroadCache(W, W);
    cache.apply(frame({ [GameUpdateType.RailroadSnapEvent]: [snap(1, line)] }));
    const intact = line.map((t) => cache.railroadState[t]);
    expect(intact.every((v) => v > 0 && v < RAIL_CUT_FLAG)).toBe(true);

    cache.apply(frame({ [GameUpdateType.RailroadCutEvent]: [cut(1, true)] }));
    expect(line.map((t) => cache.railroadState[t])).toEqual(
      intact.map((v) => v | RAIL_CUT_FLAG),
    );

    cache.apply(frame({ [GameUpdateType.RailroadCutEvent]: [cut(1, false)] }));
    expect(line.map((t) => cache.railroadState[t])).toEqual(intact);
  });

  it("keeps a shared tile flagged while any rail over it is cut, and unflags it when the cut rail goes", () => {
    const cache = new RailroadCache(W, W);
    cache.apply(
      frame({
        [GameUpdateType.RailroadSnapEvent]: [snap(1, line), snap(2, branch)],
      }),
    );
    cache.apply(frame({ [GameUpdateType.RailroadCutEvent]: [cut(2, true)] }));
    expect(cache.railroadState[4] & RAIL_CUT_FLAG).toBe(RAIL_CUT_FLAG);
    expect(cache.railroadState[3] & RAIL_CUT_FLAG).toBe(0);

    cache.apply(
      frame({
        [GameUpdateType.RailroadDestructionEvent]: [
          { type: GameUpdateType.RailroadDestructionEvent, id: 2 },
        ],
      }),
    );
    expect(cache.railroadState[4]).toBeGreaterThan(0);
    expect(cache.railroadState[4] & RAIL_CUT_FLAG).toBe(0);
    expect(cache.railroadState[14]).toBe(0);
  });

  it("ignores cuts of rails it doesn't know", () => {
    const cache = new RailroadCache(W, W);
    cache.apply(frame({ [GameUpdateType.RailroadCutEvent]: [cut(9, true)] }));
    expect(cache.railroadState.every((v) => v === 0)).toBe(true);
  });
});
