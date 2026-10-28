import type { MEMBER_MONEY_RELATIONS } from "../../member-money-tables";

type Relation = (typeof MEMBER_MONEY_RELATIONS)[number];

/**
 * The enforcement the journal's migration installs, as the verifier expects to
 * find it (#4513). ONE constant, every value an md5:
 *
 * - `functions`: each `member_money_*` routine's body, `pg_proc.prosrc`;
 * - `constraints`: each constraint's `pg_get_constraintdef`, which must also be
 *   validated (constraint triggers are pinned as triggers);
 * - `triggers`: each trigger's `pg_get_triggerdef` (its function, timing,
 *   events, condition and deferral), which must also be enabled;
 * - `uniqueIndexes`: each unique index's `pg_get_indexdef`, which must also be
 *   valid.
 *
 * PostgreSQL stores a function body as written, so
 * `member-money-database-shape.test.ts` derives `functions` from the migration
 * file. Constraint, trigger and index definitions come back from the catalog
 * normalised, so that test checks only their names against the file, and
 * `member-money-journal.realdb.test.ts` checks every digest against a freshly
 * migrated PostgreSQL 16 database. The verifier reads them with a fixed
 * `search_path` and `quote_all_identifiers`, the settings the text depends on.
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
    MemberMoneyEvent: {
      MemberMoneyEvent_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      member_money_event_evidence: "dec5ea3215f0b63d1256c88ad6fea8b1",
    },
    MemberMoneyJournal: {
      MemberMoneyJournal_eventId_fkey: "e382fee27cdb0c1ac55177728f59450a",
      MemberMoneyJournal_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      MemberMoneyJournal_reversesJournalId_fkey: "bfb14062993af86e2a6ac423c2fc5477",
      member_money_header_shape: "1c5307421a6e7d68456d3e338f269fa1",
    },
    MemberMoneyLine: {
      MemberMoneyLine_bookingId_fkey: "84a0ecc7411e7c2394eca4da49fb5bc6",
      MemberMoneyLine_journalId_fkey: "880a53fa6aa57925ea20598a9eea8bdb",
      MemberMoneyLine_lodgeId_fkey: "6388303ebdc4088f5a9a96f30bfaf07b",
      MemberMoneyLine_obligationId_fkey: "ff3b906cc7029defd0c5a26af6ef8872",
      MemberMoneyLine_originalLineId_fkey: "9bb262f2bfc231b3ae0955160857de09",
      MemberMoneyLine_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      MemberMoneyLine_sourceLinkId_journalId_fkey: "0b0fe5d4caf0d28c69e98c6578cac37e",
      member_money_line_debtor: "36ace8e3d4b5d735fec30475c069d69d",
      member_money_line_shape: "f647ce1fa0bae67450081172166cd1ea",
      member_money_tax_split: "8a4f9143eb6e8182e5d2290b38ad9952",
    },
    MemberMoneyObligation: {
      MemberMoneyObligation_journalId_fkey: "880a53fa6aa57925ea20598a9eea8bdb",
      MemberMoneyObligation_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      member_money_obligation_debtor: "ed8420650cb91cb615072f6b487a8ff6",
      member_money_obligation_shape: "ea6176c7fa6a8a5ba3b2d656554e98dc",
    },
    MemberMoneyApplication: {
      MemberMoneyApplication_journalId_fkey: "880a53fa6aa57925ea20598a9eea8bdb",
      MemberMoneyApplication_obligationId_fkey: "ff3b906cc7029defd0c5a26af6ef8872",
      MemberMoneyApplication_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      MemberMoneyApplication_reversesApplicationId_fkey: "a9c314c363277462f4bda2e8d6942109",
      MemberMoneyApplication_sourceLineId_fkey: "9c9b3dc4c4ebc30abc93b93f0b6232a3",
      member_money_application_shape: "ea47c21889b47bd29fecb45d48261d59",
    },
    MemberMoneySourceLink: {
      MemberMoneySourceLink_bookingLedgerLineId_fkey: "0e9befc60df7395f80ef18a99c7ca76f",
      MemberMoneySourceLink_journalId_fkey: "880a53fa6aa57925ea20598a9eea8bdb",
      MemberMoneySourceLink_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      member_money_source_shape: "fb1e35f3a64fd3391990b4eefae5bc31",
    },
    MemberMoneySourcePosting: {
      MemberMoneySourcePosting_lineId_journalId_fkey: "e3cf1837238c3d0a0da94776b7786f79",
      MemberMoneySourcePosting_pkey: "4c6419b3704337bbfe50f018842a9ad3",
      MemberMoneySourcePosting_sourceLinkId_journalId_fkey: "0b0fe5d4caf0d28c69e98c6578cac37e",
    },
  },
  triggers: {
    MemberMoneyEvent: {
      member_money_complete: "6c789c2c6ca80a8545e9de74b161dd04",
      member_money_immutable: "beac88e403f54df864cbf9af34de7daa",
      member_money_no_truncate: "afb72435c01ba9eb30b82d5a369a67ef",
    },
    MemberMoneyJournal: {
      member_money_complete: "180a975ebf1b5ed53f307bb7e01c6b80",
      member_money_immutable: "0ffbac7d4f7d9dfbcf402b73b04bcd1c",
      member_money_no_truncate: "396e2cf8946df2f68079af65b08f4257",
      member_money_seal: "007485dfae16d2e474b7c0f51a88d513",
    },
    MemberMoneyLine: {
      member_money_complete: "e3661d9e3951ee378cd22428d5b72934",
      member_money_immutable: "d917ac1dacf60d3086a80f21c568c0ff",
      member_money_no_truncate: "5711eccc84439bb6a5d6edaffd38a9f8",
      member_money_seal: "713727d10e38dc369706c928b6cc76e1",
    },
    MemberMoneyObligation: {
      member_money_complete: "3b9ce8216857de76023be858f14e3df0",
      member_money_immutable: "1836f0324aa4547607e88181b1e4a133",
      member_money_no_truncate: "d1eb7de21ad4914ec16f3c997aa54f48",
      member_money_seal: "11e3f6fe88ee567c88f3742947c77173",
    },
    MemberMoneyApplication: {
      member_money_complete: "1ec78651a1a66dec51742752909d17e7",
      member_money_immutable: "5f4611110c2d5e1c38ca1ecbd1567ada",
      member_money_no_truncate: "0e6212dbb123f52f1f78c85ee8dd4b45",
      member_money_seal: "9f2b551de06075fbafe89b9c5ef66480",
    },
    MemberMoneySourceLink: {
      member_money_complete: "b2f66793a564b69ff9c4d75f2f3626ab",
      member_money_immutable: "bd0e410483c1234e2d5cc56723f5e36e",
      member_money_no_truncate: "fe2517c30169023f07ab0d5d6d239e11",
    },
    MemberMoneySourcePosting: {
      member_money_complete: "107791fe798e3a48ff63d885e4ee3c22",
      member_money_immutable: "927f18e087e9c3a13f08f896ff7e64bf",
      member_money_no_truncate: "e8a66e3a827f165faed5ea82f3ddf12f",
    },
  },
  uniqueIndexes: {
    MemberMoneyEvent: {
      MemberMoneyEvent_eventKey_key: "210c0567cb5318b9c3932cb5d8f13487",
      MemberMoneyEvent_pkey: "008453491c8f0659e2607b7ef96edc58",
    },
    MemberMoneyJournal: {
      MemberMoneyJournal_eventId_key: "58b90166240d879161bae4ecfc821e53",
      MemberMoneyJournal_pkey: "45dc2a9511cea1ddeb209174614349d0",
      MemberMoneyJournal_reversesJournalId_key: "bd44dc7e36067341bd462d50939fee60",
    },
    MemberMoneyLine: {
      MemberMoneyLine_id_journalId_key: "946f417847528057c4518a2bcefb550c",
      MemberMoneyLine_originalLineId_key: "3955457f2077c3695b9e1bc0041ca930",
      MemberMoneyLine_pkey: "db609f1acc60a72b499d2f45e7278684",
    },
    MemberMoneyObligation: {
      MemberMoneyObligation_obligationKey_key: "05bd119629dbb2d8a01126be0db9c7ba",
      MemberMoneyObligation_pkey: "3da4fb0017a954e360673d23702fc68c",
    },
    MemberMoneyApplication: {
      MemberMoneyApplication_applicationKey_key: "22ca9b18286287bd39952de4e64adda9",
      MemberMoneyApplication_pkey: "ee98e76dac1f82613e6230a8d285d3e4",
      MemberMoneyApplication_reversesApplicationId_key: "832f8b9ac7b3d637a6da5e4748c7b4ba",
    },
    MemberMoneySourceLink: {
      MemberMoneySourceLink_bookingLedgerLineId_key: "5a1ebf4eb481c4469e0889d0fd0a386c",
      MemberMoneySourceLink_id_journalId_key: "f80178578066ec88e707004b742dc478",
      MemberMoneySourceLink_pkey: "208928121c2bcc91ddb7348d1e991c56",
      MemberMoneySourceLink_sourceKind_sourceId_sourceVersion_key: "983f00bcf3d8ee57ca31c5e73722239d",
    },
    MemberMoneySourcePosting: {
      MemberMoneySourcePosting_pkey: "e0bc0470c9bdaafe0129dfb1996dff11",
      MemberMoneySourcePosting_sourceLinkId_lineId_key: "acb7ce548312f8513628901ff3975b78",
    },
  },
} as const satisfies {
  functions: Record<string, string>;
  constraints: Record<Relation, Record<string, string>>;
  triggers: Record<Relation, Record<string, string>>;
  uniqueIndexes: Record<Relation, Record<string, string>>;
};
