/**
 * Real-PostgreSQL proof that a family whose per-family charge was VOIDED in Xero
 * (#2147) or CLOSED as already paid (#4098) can be billed again (#4110; owner
 * decision on #4098, 15 Oct 2026: a closed family charge is re-billable).
 *
 * Both paths release the old charge's coverage claims and keep its row. The
 * old row still carries the family, membership type and season, so before
 * #4110 the family/type/season unique index refused the second charge and
 * failed the whole confirm. The index now constrains only charges that can
 * still be invoiced (every status outside MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES),
 * which is what these proofs drive end to end: close (or void) -> reverse ->
 * preview -> confirm -> a new QUEUED family charge. A third proof pins that two
 * LIVE charges for one family/type/season are still refused.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4110-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/membership-family-rebill.realdb.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;

const PARENT_ID = "race-4110-parent";
const CHILD_ID = "race-4110-child";
const OFFICER_ID = "race-4110-officer";
const MEMBER_IDS = [PARENT_ID, CHILD_ID] as const;
const FAMILY_ID = "race-4110-family";
const BILLING_MEMBERSHIP_ID = "race-4110-family-parent";
const TYPE_ID = "race-4110-type";
const FEE_ID = "race-4110-fee";
const OLD_CHARGE_ID = "race-4110-old-charge";
const SEASON_YEAR = 2026;
const DECISION_DATE = new Date("2026-07-01T00:00:00.000Z");
const YEAR_END_MONTH = 3;
const MAPPING_KEY = "subscriptionIncome";
const FAMILY_FEE_CENTS = 30_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Family re-bill proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run family re-bill proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Family re-bill proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Family re-bill proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let billing: typeof import("@/lib/membership-subscription-billing");
let closeAlreadyPaidSubscriptionCharge: (typeof import("@/lib/membership-subscription-charge-close"))["closeAlreadyPaidSubscriptionCharge"];
let createdMapping = false;

(RUN ? describe : describe.skip)(
  "a family is billed again after its family charge is closed or voided — real PostgreSQL (#4110)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function familyChargeIds(): Promise<string[]> {
      const rows = await prisma.membershipSubscriptionCharge.findMany({
        where: { familyGroupId: FAMILY_ID },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    async function deleteFixtures() {
      const chargeIds = await familyChargeIds();
      await prisma.auditLog.deleteMany({ where: { entityId: { in: chargeIds } } });
      await prisma.xeroSyncOperation.deleteMany({
        where: { localModel: "MembershipSubscriptionCharge", localId: { in: chargeIds } },
      });
      await prisma.membershipSubscriptionChargeComponent.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionChargeCoverage.deleteMany({ where: { chargeId: { in: chargeIds } } });
      await prisma.membershipSubscriptionCharge.deleteMany({ where: { id: { in: chargeIds } } });
      await prisma.membershipBillingException.deleteMany({
        where: { OR: [{ memberId: { in: [...MEMBER_IDS] } }, { familyGroupId: FAMILY_ID }] },
      });
      await prisma.memberSubscription.deleteMany({ where: { memberId: { in: [...MEMBER_IDS] } } });
      await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: { in: [...MEMBER_IDS] } } });
      await prisma.familyGroup.updateMany({ where: { id: FAMILY_ID }, data: { billingMembershipId: null } });
      await prisma.familyGroupMember.deleteMany({ where: { familyGroupId: FAMILY_ID } });
      await prisma.familyGroup.deleteMany({ where: { id: FAMILY_ID } });
      await prisma.membershipAnnualFeeComponent.deleteMany({ where: { membershipAnnualFeeId: FEE_ID } });
      await prisma.membershipAnnualFee.deleteMany({ where: { id: FEE_ID } });
      await prisma.membershipType.deleteMany({ where: { id: TYPE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [...MEMBER_IDS, OFFICER_ID] } } });
    }

    /** A family of two, both PAID by hand, whose family charge conflicted. */
    async function seedPaidFamilyWithConflictedCharge() {
      for (const id of [...MEMBER_IDS, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Rebill",
            lastName: id.replace("race-4110-", ""),
            ageTier: "ADULT",
          },
        });
      }
      await prisma.membershipType.create({
        data: { id: TYPE_ID, key: "race-4110-family-type", name: "Race 4110 Family", subscriptionBehavior: "REQUIRED" },
      });
      await prisma.membershipAnnualFee.create({
        data: {
          id: FEE_ID,
          membershipTypeId: TYPE_ID,
          ageTier: null,
          amountCents: FAMILY_FEE_CENTS,
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
          components: { create: [{ label: "Family fee", amountCents: FAMILY_FEE_CENTS, prorate: false }] },
        },
      });
      await prisma.familyGroup.create({ data: { id: FAMILY_ID, name: "Race 4110 family" } });
      await prisma.familyGroupMember.create({ data: { id: BILLING_MEMBERSHIP_ID, familyGroupId: FAMILY_ID, memberId: PARENT_ID } });
      await prisma.familyGroupMember.create({ data: { familyGroupId: FAMILY_ID, memberId: CHILD_ID } });
      await prisma.familyGroup.update({ where: { id: FAMILY_ID }, data: { billingMembershipId: BILLING_MEMBERSHIP_ID } });
      const subscriptionIds: string[] = [];
      for (const memberId of MEMBER_IDS) {
        await prisma.seasonalMembershipAssignment.create({
          data: { memberId, seasonYear: SEASON_YEAR, membershipTypeId: TYPE_ID },
        });
        const subscription = await prisma.memberSubscription.create({
          data: {
            memberId,
            seasonYear: SEASON_YEAR,
            status: "PAID",
            manuallyMarkedPaidAt: new Date("2026-06-15T00:00:00.000Z"),
            manuallyMarkedPaidByMemberId: OFFICER_ID,
          },
        });
        subscriptionIds.push(subscription.id);
      }
      await prisma.membershipSubscriptionCharge.create({
        data: {
          id: OLD_CHARGE_ID,
          idempotencyKey: "race-4110-old-charge-key",
          seasonYear: SEASON_YEAR,
          source: "ANNUAL_BATCH",
          status: "CONFLICT",
          membershipAnnualFeeId: FEE_ID,
          membershipTypeId: TYPE_ID,
          membershipTypeKey: "race-4110-family-type",
          membershipTypeName: "Race 4110 Family",
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          annualAmountCents: FAMILY_FEE_CENTS,
          chargedAmountCents: FAMILY_FEE_CENTS,
          coveredMonths: 12,
          decisionDate: new Date("2026-06-01T00:00:00.000Z"),
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          familyGroupId: FAMILY_ID,
          recipientMemberId: PARENT_ID,
          recipientName: "Rebill parent",
          recipientEmail: `${PARENT_ID}@example.invalid`,
          dueDays: 30,
          xeroAccountCode: "203",
          invoiceReference: "MEMSUB-RACE-4110-OLD",
          lastErrorCode: "SUBSCRIPTION_ALREADY_PAID",
          lastErrorMessage: "Covered subscriptions are already PAID.",
          coverage: {
            create: MEMBER_IDS.map((memberId, index) => ({
              subscriptionId: subscriptionIds[index]!,
              memberId,
              memberName: `Rebill ${memberId.replace("race-4110-", "")}`,
            })),
          },
        },
      });
    }

    /** The manual reversal's own write: the child's payment was recorded by mistake. */
    async function reverseChildPayment() {
      await prisma.memberSubscription.updateMany({
        where: { memberId: CHILD_ID, seasonYear: SEASON_YEAR, status: "PAID" },
        data: { status: "NOT_INVOICED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
    }

    /** What `releaseVoidedSubscriptionInvoice` leaves behind (#2147), for a charge Xero voided. */
    async function voidOldCharge() {
      await prisma.membershipSubscriptionCharge.update({
        where: { id: OLD_CHARGE_ID },
        data: { status: "VOIDED", lastErrorCode: null, lastErrorMessage: null },
      });
      await prisma.membershipSubscriptionChargeCoverage.updateMany({
        where: { chargeId: OLD_CHARGE_ID, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      await prisma.memberSubscription.updateMany({
        where: { memberId: { in: [...MEMBER_IDS] }, seasonYear: SEASON_YEAR },
        data: { voidGeneration: { increment: 1 }, status: "NOT_INVOICED", manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null },
      });
    }

    async function previewAndConfirm() {
      const preview = await billing.buildSubscriptionBillingPreview({
        seasonYear: SEASON_YEAR,
        decisionDate: DECISION_DATE,
        memberIds: [...MEMBER_IDS],
        yearEndMonth: YEAR_END_MONTH,
      });
      const confirmed = await billing.confirmSubscriptionBillingPreview({
        preview,
        expectedConfirmationToken: preview.confirmationToken,
        source: "NEW_MEMBER_APPROVAL",
        confirmedByMemberId: OFFICER_ID,
      });
      return { preview, confirmed };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      billing = await import("@/lib/membership-subscription-billing");
      ({ closeAlreadyPaidSubscriptionCharge } = await import("@/lib/membership-subscription-charge-close"));
      // The subscriptionIncome mapping is a club-wide singleton: configure it only
      // when this database has none, and remove only what this suite created.
      const existing = await prisma.xeroAccountMapping.findUnique({ where: { key: MAPPING_KEY } });
      if (!existing) {
        await prisma.xeroAccountMapping.create({ data: { key: MAPPING_KEY, code: "203" } });
        createdMapping = true;
      }
    });

    beforeEach(async () => {
      await deleteFixtures();
      await seedPaidFamilyWithConflictedCharge();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      if (createdMapping) await prisma.xeroAccountMapping.deleteMany({ where: { key: MAPPING_KEY } });
    });

    async function expectOneNewFamilyCharge(confirmedChargeIds: string[]) {
      const newIds = confirmedChargeIds.filter((id) => id !== OLD_CHARGE_ID);
      expect(newIds).toHaveLength(1);
      const charge = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({
        where: { id: newIds[0] },
        include: { coverage: true },
      });
      expect(charge).toMatchObject({
        status: "QUEUED",
        familyGroupId: FAMILY_ID,
        membershipTypeId: TYPE_ID,
        seasonYear: SEASON_YEAR,
        recipientMemberId: PARENT_ID,
        chargedAmountCents: FAMILY_FEE_CENTS,
      });
      expect(charge.idempotencyKey).not.toBe("race-4110-old-charge-key");
      return charge;
    }

    it("re-bills the family after its charge was closed as already paid and one payment was reversed", async () => {
      await expect(
        closeAlreadyPaidSubscriptionCharge({ chargeId: OLD_CHARGE_ID, reason: "Paid in cash", actorMemberId: OFFICER_ID }),
      ).resolves.toMatchObject({ closed: true });
      await reverseChildPayment();

      const { preview, confirmed } = await previewAndConfirm();

      expect(preview.exceptions.map((item) => item.code)).not.toContain("FAMILY_ALREADY_BILLED");
      const charge = await expectOneNewFamilyCharge(confirmed.chargeIds);
      // Only the reversed child is billed: the parent is still PAID by hand.
      expect(charge.coverage.map((row) => ({ memberId: row.memberId, releasedAt: row.releasedAt }))).toEqual([
        { memberId: CHILD_ID, releasedAt: null },
      ]);
      const old = await prisma.membershipSubscriptionCharge.findUniqueOrThrow({ where: { id: OLD_CHARGE_ID } });
      expect(old.status).toBe("NOT_REQUIRED");
      expect(
        await prisma.xeroSyncOperation.count({ where: { localModel: "MembershipSubscriptionCharge", localId: charge.id } }),
      ).toBe(1);
    });

    it("re-bills the family after Xero voided its charge", async () => {
      await voidOldCharge();

      const { confirmed } = await previewAndConfirm();

      const charge = await expectOneNewFamilyCharge(confirmed.chargeIds);
      expect(charge.coverage.map((row) => row.memberId).sort()).toEqual([...MEMBER_IDS].sort());
    });

    it("still refuses a second LIVE charge for one family, type and season", async () => {
      const second = prisma.membershipSubscriptionCharge.create({
        data: {
          idempotencyKey: "race-4110-second-live-key",
          seasonYear: SEASON_YEAR,
          source: "ANNUAL_BATCH",
          status: "QUEUED",
          membershipTypeId: TYPE_ID,
          membershipTypeKey: "race-4110-family-type",
          membershipTypeName: "Race 4110 Family",
          billingBasis: "PER_FAMILY",
          prorationRule: "NONE",
          annualAmountCents: FAMILY_FEE_CENTS,
          chargedAmountCents: FAMILY_FEE_CENTS,
          coveredMonths: 12,
          decisionDate: new Date("2026-06-01T00:00:00.000Z"),
          coverageStart: new Date("2026-04-01T00:00:00.000Z"),
          coverageEnd: new Date("2027-03-31T00:00:00.000Z"),
          familyGroupId: FAMILY_ID,
          recipientMemberId: PARENT_ID,
          recipientName: "Rebill parent",
          recipientEmail: `${PARENT_ID}@example.invalid`,
          dueDays: 30,
          invoiceReference: "MEMSUB-RACE-4110-SECOND",
        },
      });
      await expect(second).rejects.toMatchObject({ code: "P2002" });
    });
  },
);
