import {
  AttackIntentSchema,
  BoatAttackIntentSchema,
  BuildUnitIntentSchema,
  CancelBoatIntentSchema,
  DeleteUnitIntentSchema,
  DonateGoldIntentSchema,
  DonateTroopIntentSchema,
  MoveWarshipIntentSchema,
  SpawnIntentSchema,
  UpgradeStructureIntentSchema,
} from "@openfront/engine-api/Schemas";
import { describe, expect, it } from "vitest";

const RECIPIENT = "aaaaaaaa";

// A TileRef indexes Uint8Array/Uint32Array terrain and traversal buffers. A
// fractional ref passes a bare range check but silently corrupts every one of
// those lookups, so the wire format has to reject it outright.
const tileRefCases = [
  {
    name: "spawn",
    schema: SpawnIntentSchema,
    build: (tile: number) => ({ type: "spawn", tile }),
  },
  {
    name: "boat",
    schema: BoatAttackIntentSchema,
    build: (dst: number) => ({ type: "boat", troops: 1, dst }),
  },
  {
    name: "build_unit",
    schema: BuildUnitIntentSchema,
    build: (tile: number) => ({ type: "build_unit", unit: "City", tile }),
  },
  {
    name: "build_unit (minefield with density)",
    schema: BuildUnitIntentSchema,
    build: (tile: number) => ({
      type: "build_unit",
      unit: "Minefield",
      tile,
      density: 50,
    }),
  },
  {
    name: "move_warship",
    schema: MoveWarshipIntentSchema,
    build: (tile: number) => ({ type: "move_warship", unitIds: [1], tile }),
  },
];

describe("intent schemas: tile refs are non-negative integers", () => {
  for (const { name, schema, build } of tileRefCases) {
    it(`${name} accepts integer refs`, () => {
      expect(schema.safeParse(build(0)).success).toBe(true);
      expect(schema.safeParse(build(4040)).success).toBe(true);
    });

    it(`${name} rejects fractional refs`, () => {
      expect(schema.safeParse(build(4040.5)).success).toBe(false);
      expect(schema.safeParse(build(0.0000001)).success).toBe(false);
    });

    it(`${name} rejects negative, NaN and infinite refs`, () => {
      expect(schema.safeParse(build(-1)).success).toBe(false);
      expect(schema.safeParse(build(NaN)).success).toBe(false);
      expect(schema.safeParse(build(Infinity)).success).toBe(false);
      expect(schema.safeParse(build(-Infinity)).success).toBe(false);
    });
  }
});

describe("intent schemas: unit ids are non-negative integers", () => {
  it("upgrade_structure", () => {
    const ok = { type: "upgrade_structure", unit: "City", unitId: 3 };
    expect(UpgradeStructureIntentSchema.safeParse(ok).success).toBe(true);
    const bad = { ...ok, unitId: 3.5 };
    expect(UpgradeStructureIntentSchema.safeParse(bad).success).toBe(false);
  });

  it("cancel_boat", () => {
    const ok = { type: "cancel_boat", unitID: 3 };
    expect(CancelBoatIntentSchema.safeParse(ok).success).toBe(true);
    const bad = { type: "cancel_boat", unitID: 3.5 };
    expect(CancelBoatIntentSchema.safeParse(bad).success).toBe(false);
  });

  it("delete_unit", () => {
    const ok = { type: "delete_unit", unitId: 3 };
    expect(DeleteUnitIntentSchema.safeParse(ok).success).toBe(true);
    const bad = { type: "delete_unit", unitId: 3.5 };
    expect(DeleteUnitIntentSchema.safeParse(bad).success).toBe(false);
  });
});

// A minefield's density is an integer percent from 10 to 100. Fractions would
// leak floats into the field's health, so the wire rejects them like tile refs.
describe("intent schemas: minefield density is an integer percent", () => {
  const minefield = { type: "build_unit", unit: "Minefield", tile: 10 };

  it("accepts 10 to 100, and no density at all", () => {
    for (const density of [10, 11, 50, 99, 100]) {
      const intent = { ...minefield, density };
      expect(BuildUnitIntentSchema.safeParse(intent).success).toBe(true);
    }
    expect(BuildUnitIntentSchema.safeParse(minefield).success).toBe(true);
  });

  it("rejects out-of-range, fractional, negative and non-finite densities", () => {
    for (const density of [0, 9, 101, 1000, 50.5, -10, NaN, Infinity]) {
      const intent = { ...minefield, density };
      expect(BuildUnitIntentSchema.safeParse(intent).success).toBe(false);
    }
  });

  it("is a number, not a string", () => {
    const intent = { ...minefield, density: "50" };
    expect(BuildUnitIntentSchema.safeParse(intent).success).toBe(false);
  });
});

// Troops and gold are deliberately NOT integers. Attack troops are
// `attackRatio * player.troops()` on the client and combat attrition keeps them
// fractional in the sim, so pinning these to .int() would reject every honest
// attack. This locks the looser contract in place.
describe("intent schemas: troop and gold amounts stay fractional", () => {
  it("attack accepts fractional troops", () => {
    const intent = { type: "attack", targetID: null, troops: 12.5 };
    expect(AttackIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("boat accepts fractional troops", () => {
    const intent = { type: "boat", troops: 12.5, dst: 10 };
    expect(BoatAttackIntentSchema.safeParse(intent).success).toBe(true);
  });

  it("donations accept fractional amounts", () => {
    const troops = {
      type: "donate_troops",
      recipient: RECIPIENT,
      troops: 12.5,
    };
    expect(DonateTroopIntentSchema.safeParse(troops).success).toBe(true);

    const gold = { type: "donate_gold", recipient: RECIPIENT, gold: 12.5 };
    expect(DonateGoldIntentSchema.safeParse(gold).success).toBe(true);
  });

  // Non-finite rejection here comes from Zod 4's base number type, not from a
  // modifier we spell out. If this ever fails, add an explicit finiteness
  // refinement to the troop/gold fields rather than deleting the assertion.
  it("still rejects negative and non-finite amounts", () => {
    for (const troops of [-1, NaN, Infinity]) {
      const intent = { type: "attack", targetID: null, troops };
      expect(AttackIntentSchema.safeParse(intent).success).toBe(false);
    }
  });
});
