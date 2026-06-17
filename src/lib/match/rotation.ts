// Rounds/pairs rotation for ATPL match structure (3 lines × 3 rounds).
// The rotation map lives in rule_set.structure.rotation; these helpers apply it.

export interface Slot {
  round: number;
  homePair: number;
  awayPair: number;
}

/** rotation[round][homePair] = awayPair. Keys are strings (jsonb). */
export type RotationMap = Record<string, Record<string, number>>;

export const ATPL_ROTATION: RotationMap = {
  "1": { "1": 1, "2": 2, "3": 3 },
  "2": { "1": 2, "2": 3, "3": 1 },
  "3": { "1": 3, "2": 1, "3": 2 },
};

/**
 * Mirror of the Phase 2 migration backfill: historical flat line_number (1..9)
 * → rounds-aware slot. line_number was written round-major (L1-3 = round 1,
 * etc.) with home_pair_index cycling 1..3 within each round.
 */
export function lineNumberToSlot(lineNumber: number): Slot {
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > 9) {
    throw new Error(`lineNumber out of range (1..9): ${lineNumber}`);
  }
  const round = Math.floor((lineNumber - 1) / 3) + 1;
  const homePair = ((lineNumber - 1) % 3) + 1;
  const awayPair = ATPL_ROTATION[String(round)][String(homePair)];
  return { round, homePair, awayPair };
}

/** Generate all (round, homePair, awayPair) slots from a structure + rotation. */
export function generateSlots(
  rounds: number,
  linesPerRound: number,
  rotation: RotationMap,
): Slot[] {
  const slots: Slot[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (let homePair = 1; homePair <= linesPerRound; homePair++) {
      const awayPair = rotation[String(round)]?.[String(homePair)];
      if (awayPair === undefined) {
        throw new Error(`rotation missing [${round}][${homePair}]`);
      }
      slots.push({ round, homePair, awayPair });
    }
  }
  return slots;
}
