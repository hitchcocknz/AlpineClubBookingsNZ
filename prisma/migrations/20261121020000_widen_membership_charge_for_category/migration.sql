-- Subscription-category decoupling, step 2 of 2: widen MembershipSubscriptionCharge
-- (and its coverage/exception siblings) so a charge can bill on the NEW
-- SubscriptionCategory axis instead of the MembershipType axis, following
-- 20261121010000_add_subscription_category.
--
-- MembershipSubscriptionCharge.membershipTypeId/Key/Name widen from required
-- to nullable, and four new nullable subscriptionCategory* columns are added.
-- Exactly one of the two trios is populated per charge going forward,
-- enforced by the new CHECK MembershipCharge_type_xor_category
-- (num_nonnulls = 1). Every EXISTING charge keeps membershipTypeId populated
-- and the new columns NULL, so no existing row changes meaning.
--
-- The #4110 "at most one LIVE family charge" partial unique index
-- (MembershipCharge_family_type_year_live_key, added by
-- 20261118010000_membership_charge_family_unique_live_only) is left
-- COMPLETELY UNTOUCHED — not dropped, not re-scoped. It does not need to be:
-- a multi-column unique/partial-unique index never treats two NULLs as equal
-- (standard SQL), so any number of category charges (membershipTypeId always
-- NULL on them) coexist under this existing index with no collision against
-- each other or against type charges, with zero changes to its definition.
-- A sibling partial unique index, MembershipCharge_family_category_year_live_key,
-- gives the category axis the IDENTICAL "at most one live charge per family,
-- re-billable after void/close" semantics from day one, even though no
-- category charge can exist yet (no history to migrate) — this is a fresh
-- constraint on an all-new key shape, not a re-key of anything pre-existing,
-- so none of #1931/E5's dual-read adopt-by-reference complexity applies here.
--
-- MembershipSubscriptionChargeCoverage gains two nullable audit columns
-- (membershipTypeId/Name) recording each COVERED MEMBER's own membership type
-- at confirm time, since a category charge can cover members of DIFFERENT
-- membership types (e.g. a Senior + Life Member couple sharing one "Couple"
-- category charge) — booking rights are read from SeasonalMembershipAssignment
-- directly and never from this audit column, so this has zero effect on
-- rights/rate either way, regardless of which axis billed the parent charge.
--
-- MembershipBillingException gains a nullable subscriptionCategoryId column,
-- populated instead of membershipTypeId when an exception is raised while
-- resolving category-based billing.
--
-- EXPAND-ONLY, blue/green old_code_compatible = yes (see
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv): every new column is nullable, the
-- pre-existing type-axis partial index is untouched, and the previously
-- deployed (old-colour) code never names the new category-scoped index and
-- never relies on it. No backfill DML, no RENAME, no Xero/provider call.
--
-- LOCK IMPACT: Prisma runs this file in one transaction. ALTER COLUMN ...
-- DROP NOT NULL and the ADD COLUMN statements are catalog-only (no table
-- rewrite) on PostgreSQL. The new CREATE UNIQUE INDEX (one partial index,
-- the category sibling only — the type-axis index is untouched) takes an
-- ACCESS EXCLUSIVE lock on MembershipSubscriptionCharge for the index build,
-- same lock class as 20261118010000 — a scan of a cold billing table with one
-- row per family or member per season. Run in the normal deploy window and
-- let the deploy guard stop on lock timeout.
--
-- Prisma cannot express a predicated index or a CHECK constraint, so neither
-- appears in prisma/schema.prisma as a modelled attribute; the new partial
-- index is registered in prisma/partial-unique-indexes.tsv, which
-- scripts/check-partial-indexes.sh holds to set equality in CI. The CHECK is
-- documented in a schema.prisma comment only (not modelled — Prisma has no
-- CHECK primitive).

-- ---------------------------------------------------------------------------
-- 1. Widen MembershipSubscriptionCharge's type columns; add category columns
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeId" DROP NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeKey" DROP NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeName" DROP NOT NULL;

ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryId" TEXT;
ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryKey" TEXT;
ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryName" TEXT;
ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryFeeId" TEXT;

CREATE INDEX "MembershipSubscriptionCharge_subscriptionCategoryId_seasonY_idx"
  ON "MembershipSubscriptionCharge"("subscriptionCategoryId", "seasonYear");

-- ---------------------------------------------------------------------------
-- 2. The category-axis live-charge partial unique index. The existing
--    type-axis index (MembershipCharge_family_type_year_live_key) is left
--    exactly as 20261118010000 created it — see the file header.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "MembershipCharge_family_category_year_live_key"
  ON "MembershipSubscriptionCharge"("seasonYear", "subscriptionCategoryId", "familyGroupId")
  WHERE "subscriptionCategoryId" IS NOT NULL AND "status" NOT IN ('NOT_REQUIRED', 'VOIDED');

-- ---------------------------------------------------------------------------
-- 3. Every charge bills on exactly one axis.
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipSubscriptionCharge" ADD CONSTRAINT "MembershipCharge_type_xor_category"
  CHECK (num_nonnulls("membershipTypeId", "subscriptionCategoryId") = 1);

-- ---------------------------------------------------------------------------
-- 4. MembershipSubscriptionChargeCoverage: per-covered-member type audit
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipSubscriptionChargeCoverage" ADD COLUMN "membershipTypeId" TEXT;
ALTER TABLE "MembershipSubscriptionChargeCoverage" ADD COLUMN "membershipTypeName" TEXT;

-- ---------------------------------------------------------------------------
-- 5. MembershipBillingException: category-axis exception context
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipBillingException" ADD COLUMN "subscriptionCategoryId" TEXT;

CREATE INDEX "MembershipBillingException_subscriptionCategoryId_status_idx"
  ON "MembershipBillingException"("subscriptionCategoryId", "status");
