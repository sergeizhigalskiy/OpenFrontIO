import { HordeBandExecutionSnapshot } from "@openfront/engine/execution/HordeBandExecution";
import { HordeNightExecutionSnapshot } from "@openfront/engine/execution/HordeNightExecution";
import { PlagueExecutionSnapshot } from "@openfront/engine/execution/PlagueExecution";
import { WinCheckExecutionSnapshot } from "@openfront/engine/execution/WinCheckExecution";

// The game mode records bumped for Boss Raid, Horde Night and the plague:
// what an older game's record becomes.
describe("game mode snapshot migrations", () => {
  test("WinCheck v1: no Boss Raid low-land clock running", () => {
    expect(WinCheckExecutionSnapshot.version).toBe(2);
    expect(WinCheckExecutionSnapshot.migrations[1]({ active: true })).toEqual({
      active: true,
      bossLowLandSince: null,
    });
  });

  test("HordeNight v1: no recorded land, no outcome, no bands at sea", () => {
    expect(HordeNightExecutionSnapshot.version).toBe(2);
    expect(
      HordeNightExecutionSnapshot.migrations[1]({ wavesLanded: 3 }),
    ).toEqual({
      wavesLanded: 3,
      startLand: null,
      outcome: null,
      inbound: [],
    });
  });

  test("HordeBand v1: no defender of its own, and it never disbands", () => {
    expect(HordeBandExecutionSnapshot.version).toBe(2);
    expect(HordeBandExecutionSnapshot.migrations[1]({ attackTick: 4 })).toEqual(
      {
        attackTick: 4,
        defender: null,
        landingTroops: 0,
        landedTick: 0,
      },
    );
  });

  test("Plague v1: a past outbreak never comes back; one still due keeps its 2:00", () => {
    expect(PlagueExecutionSnapshot.version).toBe(2);
    const broke = PlagueExecutionSnapshot.migrations[1]({ infected: 7 }) as {
      outbreaks: number;
      nextOutbreakTick: number | null;
      infectedAlive: boolean;
    };
    expect(broke.outbreaks).toBe(3);
    expect(broke.nextOutbreakTick).toBeNull();
    expect(broke.infectedAlive).toBe(true);
    const due = PlagueExecutionSnapshot.migrations[1]({ infected: null }) as {
      outbreaks: number;
      nextOutbreakTick: number | null;
    };
    expect(due.outbreaks).toBe(0);
    expect(due.nextOutbreakTick).toBe(1200);
  });
});
