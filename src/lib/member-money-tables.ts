/** Immutable economic relations; provisioning and the verifier share this list. */
export const MEMBER_MONEY_RELATIONS = [
  "MemberMoneyEvent",
  "MemberMoneyJournal",
  "MemberMoneyLine",
  "MemberMoneyObligation",
  "MemberMoneyApplication",
  "MemberMoneySourceLink",
  "MemberMoneySourcePosting",
] as const;

/**
 * The relations whose rows may be inserted only in their header's creating
 * transaction (INV-MONEY-042): each carries the `member_money_seal` trigger.
 */
export const MEMBER_MONEY_SEALED_RELATIONS = [
  "MemberMoneyJournal",
  "MemberMoneyLine",
  "MemberMoneyObligation",
  "MemberMoneyApplication",
] as const satisfies readonly (typeof MEMBER_MONEY_RELATIONS)[number][];
