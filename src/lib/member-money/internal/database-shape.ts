import type { MEMBER_MONEY_RELATIONS } from "../../member-money-tables";

/**
 * The enforcement the journal's migration installs, as the verifier expects to
 * find it (#4513). ONE constant: `member-money-database-shape.test.ts` derives
 * the same values from the migration file and fails when they differ, so a
 * change to an enforcement function or constraint changes both together.
 *
 * `functions` maps each `member_money_*` routine to `md5(pg_proc.prosrc)`, the
 * body PostgreSQL stores; `constraints` names every constraint each relation
 * must carry, validated.
 */
export const MEMBER_MONEY_DATABASE_SHAPE = {
  functions: {
    member_money_system_identifier: "84a6311f30559828a65a0fcfb6e46c4b",
    member_money_refuse_mutation: "1f3a39b585e154e2de7c93967840b72c",
    member_money_check_seal: "9b1a9be58cc2efc7b47ef9f8e99a6cd8",
    member_money_batch_errors: "cbb4fab0548c90641ea97c8a9cf94c97",
    member_money_require_complete: "876201ea45a0f01b0269c311fd85e3ff",
  },
  constraints: {
    MemberMoneyEvent: ["MemberMoneyEvent_pkey", "member_money_event_evidence"],
    MemberMoneyJournal: [
      "MemberMoneyJournal_pkey",
      "MemberMoneyJournal_eventId_fkey",
      "MemberMoneyJournal_reversesJournalId_fkey",
      "member_money_header_shape",
    ],
    MemberMoneyLine: [
      "MemberMoneyLine_pkey",
      "MemberMoneyLine_journalId_fkey",
      "MemberMoneyLine_sourceLinkId_journalId_fkey",
      "MemberMoneyLine_obligationId_fkey",
      "MemberMoneyLine_bookingId_fkey",
      "MemberMoneyLine_lodgeId_fkey",
      "MemberMoneyLine_originalLineId_fkey",
      "member_money_line_shape",
      "member_money_line_debtor",
      "member_money_tax_split",
    ],
    MemberMoneyObligation: [
      "MemberMoneyObligation_pkey",
      "MemberMoneyObligation_journalId_fkey",
      "member_money_obligation_shape",
      "member_money_obligation_debtor",
    ],
    MemberMoneyApplication: [
      "MemberMoneyApplication_pkey",
      "MemberMoneyApplication_journalId_fkey",
      "MemberMoneyApplication_sourceLineId_fkey",
      "MemberMoneyApplication_obligationId_fkey",
      "MemberMoneyApplication_reversesApplicationId_fkey",
      "member_money_application_shape",
    ],
    MemberMoneySourceLink: [
      "MemberMoneySourceLink_pkey",
      "MemberMoneySourceLink_journalId_fkey",
      "MemberMoneySourceLink_bookingLedgerLineId_fkey",
      "member_money_source_shape",
    ],
    MemberMoneySourcePosting: [
      "MemberMoneySourcePosting_pkey",
      "MemberMoneySourcePosting_sourceLinkId_journalId_fkey",
      "MemberMoneySourcePosting_lineId_journalId_fkey",
    ],
  },
} as const satisfies {
  functions: Record<string, string>;
  constraints: Record<(typeof MEMBER_MONEY_RELATIONS)[number], readonly string[]>;
};
