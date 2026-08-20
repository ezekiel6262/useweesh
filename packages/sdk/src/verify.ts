import type { Hex } from "viem";
import { hashOutcome, hashPolicy, type IntentDraft, type IntentRecord } from "@intentos/intent-schema";

/**
 * Checks that an intent handed to a solver offchain is the same one committed onchain.
 *
 * Solvers receive drafts from a coordinator they did not write. Bidding on a draft whose hashes
 * do not match the registry would mean guaranteeing an outcome that can never settle, so this
 * check runs before a solver spends anything on planning.
 */

export interface VerificationResult {
  ok: boolean;
  problems: string[];
}

export function verifyDraftAgainstRecord(draft: IntentDraft, record: IntentRecord, expectedId?: Hex): VerificationResult {
  const problems: string[] = [];

  if (hashOutcome(draft.outcome) !== record.outcomeHash) {
    problems.push("the draft's outcome does not hash to the committed outcome");
  }
  if (hashPolicy(draft.policy) !== record.policyHash) {
    problems.push("the draft's policy does not hash to the committed policy");
  }
  if (draft.outcome.legs.length !== record.legCount) {
    problems.push(`the draft has ${draft.outcome.legs.length} legs, the commitment says ${record.legCount}`);
  }
  if (draft.deadline !== record.deadline) {
    problems.push("the draft's deadline differs from the committed one");
  }
  if (draft.auctionEndsAt !== record.auctionEndsAt) {
    problems.push("the draft's auction window differs from the committed one");
  }
  if (expectedId && expectedId !== record.intentId) {
    problems.push("this record is for a different intent");
  }

  return { ok: problems.length === 0, problems };
}

/** Whether an intent's declared preconditions currently hold. */
export function conditionsHold(
  draft: IntentDraft,
  observations: Record<string, number>,
): { hold: boolean; failed: string[] } {
  const failed: string[] = [];

  for (const condition of draft.metadata.conditions ?? []) {
    const key = condition.subject ?? condition.kind;
    const observed = observations[key];
    if (observed === undefined) {
      failed.push(`no observation for ${key}`);
      continue;
    }
    const holds =
      condition.operator === "lt"
        ? observed < condition.value
        : condition.operator === "lte"
          ? observed <= condition.value
          : condition.operator === "gt"
            ? observed > condition.value
            : observed >= condition.value;

    if (!holds) failed.push(`${key} is ${observed}, needs to be ${condition.operator} ${condition.value}`);
  }

  return { hold: failed.length === 0, failed };
}
