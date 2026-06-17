import { describe, expect, it } from "vitest";
import { ATPL_ROTATION, generateSlots, lineNumberToSlot, type Slot } from "./rotation";

describe("lineNumberToSlot — mirrors the migration backfill", () => {
  const expected: Record<number, Slot> = {
    1: { round: 1, homePair: 1, awayPair: 1 },
    2: { round: 1, homePair: 2, awayPair: 2 },
    3: { round: 1, homePair: 3, awayPair: 3 },
    4: { round: 2, homePair: 1, awayPair: 2 },
    5: { round: 2, homePair: 2, awayPair: 3 },
    6: { round: 2, homePair: 3, awayPair: 1 },
    7: { round: 3, homePair: 1, awayPair: 3 },
    8: { round: 3, homePair: 2, awayPair: 1 },
    9: { round: 3, homePair: 3, awayPair: 2 },
  };

  it("maps all 9 flat lines to the right round/pair slot", () => {
    for (let n = 1; n <= 9; n++) {
      expect(lineNumberToSlot(n)).toEqual(expected[n]);
    }
  });

  it("rejects out-of-range line numbers", () => {
    expect(() => lineNumberToSlot(0)).toThrow();
    expect(() => lineNumberToSlot(10)).toThrow();
    expect(() => lineNumberToSlot(1.5)).toThrow();
  });
});

describe("generateSlots", () => {
  it("produces the 9 ATPL slots from the rotation map", () => {
    const slots = generateSlots(3, 3, ATPL_ROTATION);
    expect(slots).toHaveLength(9);
    // every (round, homePair) pair is present exactly once
    const keys = new Set(slots.map((s) => `${s.round}-${s.homePair}`));
    expect(keys.size).toBe(9);
    // away pair follows the rotation
    for (const s of slots) {
      expect(s.awayPair).toBe(ATPL_ROTATION[String(s.round)][String(s.homePair)]);
    }
  });
});
