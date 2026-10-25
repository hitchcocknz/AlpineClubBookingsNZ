-- Subscription-category decoupling, step 1 of 2: introduce the new
-- SubscriptionCategory billing axis, independent of MembershipType.
--
-- Context: a club's MembershipType (e.g. "Senior") governs booking rights and
-- hut nightly rates only. Separately, a club-definable SubscriptionCategory
-- (e.g. "Couple", "Adult + Child", "2 Adults + 2+ Children") governs which
-- flat annual fee a member's subscription bills under, fully decoupled from
-- their MembershipType. Two Senior members who are a couple keep full Senior
-- booking rights while paying one flat "Couple" fee instead of 2x the
-- individual Senior fee. See docs/invariants/membership-lifecycle.md
-- (INV-LIFE-005, which already establishes "access role, seasonal membership
-- type, age tier... are separate axes") and docs/AUTHORITATIVE_FEES.md.
--
-- EXPAND-ONLY, blue/green old_code_compatible = yes (see
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv): three new tables plus one nullable,
-- additive column on SeasonalMembershipAssignment. Old code never reads or
-- writes subscriptionCategoryId and has no notion of SubscriptionCategory, so
-- it is completely unaffected mid-rollout. No column drop/alter, no RENAME,
-- no DML beyond the single built-in "Individual" seed row below (which old
-- code also never reads). Money stays integer cents; dates stay date-only.
-- Session-clock gate: the seed row's createdAt/updatedAt are written as an
-- explicit timezone('UTC', statement_timestamp()) value, never bare
-- now()/CURRENT_TIMESTAMP, per every other DML INSERT in this migration tree.
--
-- SubscriptionCategoryFee deliberately has NO membershipTypeId and NO
-- ageTier column (a category fee is one flat number, independent of which
-- MembershipType(s) the covered members hold or their ages), so unlike
-- MembershipAnnualFee/JoiningFee it needs no partial unique index and no GiST
-- no-overlap EXCLUDE constraint — a plain composite unique on
-- (subscriptionCategoryId, effectiveFrom) is sufficient, matching JoiningFee's
-- pre-age-tier shape (see 20260717170000_joining_fee_model).

-- ---------------------------------------------------------------------------
-- 1. SubscriptionCategory table
-- ---------------------------------------------------------------------------
CREATE TABLE "SubscriptionCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionCategory_key_key" ON "SubscriptionCategory"("key");
CREATE INDEX "SubscriptionCategory_isActive_sortOrder_idx" ON "SubscriptionCategory"("isActive", "sortOrder");

-- Built-in "Individual" sentinel row (owner decision, mirrors MembershipType's
-- isBuiltIn convention): a routing marker the admin UI shows as the explicit
-- "Individual" option, never looked up by id at billing time since
-- SeasonalMembershipAssignment.subscriptionCategoryId is NULL for an
-- Individual member (the common case, unaffected by this feature).
INSERT INTO "SubscriptionCategory" ("id", "key", "name", "isActive", "isBuiltIn", "sortOrder", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'individual', 'Individual', true, true, 0, timezone('UTC', statement_timestamp()), timezone('UTC', statement_timestamp()));

-- ---------------------------------------------------------------------------
-- 2. SubscriptionCategoryFee table
-- ---------------------------------------------------------------------------
CREATE TABLE "SubscriptionCategoryFee" (
    "id" TEXT NOT NULL,
    "subscriptionCategoryId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "prorationRule" "MembershipFeeProrationRule" NOT NULL DEFAULT 'NONE',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCategoryFee_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionCategoryFee_amount_nonnegative" CHECK ("amountCents" >= 0),
    CONSTRAINT "SubscriptionCategoryFee_date_order" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE UNIQUE INDEX "SubscriptionCategoryFee_subscriptionCategoryId_effectiveFr_key"
  ON "SubscriptionCategoryFee"("subscriptionCategoryId", "effectiveFrom");
CREATE INDEX "SubscriptionCategoryFee_effective_lookup_idx"
  ON "SubscriptionCategoryFee"("subscriptionCategoryId", "effectiveFrom", "effectiveTo");

ALTER TABLE "SubscriptionCategoryFee"
  ADD CONSTRAINT "SubscriptionCategoryFee_subscriptionCategoryId_fkey"
  FOREIGN KEY ("subscriptionCategoryId") REFERENCES "SubscriptionCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. SubscriptionCategoryFeeComponent table
-- ---------------------------------------------------------------------------
CREATE TABLE "SubscriptionCategoryFeeComponent" (
    "id" TEXT NOT NULL,
    "subscriptionCategoryFeeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "prorate" BOOLEAN NOT NULL DEFAULT true,
    "xeroAccountCode" TEXT,
    "xeroItemCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCategoryFeeComponent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionCategoryFeeComponent_subscriptionCategoryFeeI_idx"
  ON "SubscriptionCategoryFeeComponent"("subscriptionCategoryFeeId", "sortOrder");

ALTER TABLE "SubscriptionCategoryFeeComponent"
  ADD CONSTRAINT "SubscriptionCategoryFeeComponent_subscriptionCategoryFeeId_fkey"
  FOREIGN KEY ("subscriptionCategoryFeeId") REFERENCES "SubscriptionCategoryFee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. SeasonalMembershipAssignment.subscriptionCategoryId (nullable, additive)
-- ---------------------------------------------------------------------------
ALTER TABLE "SeasonalMembershipAssignment" ADD COLUMN "subscriptionCategoryId" TEXT;

CREATE INDEX "SeasonalMembershipAssignment_subscriptionCategoryId_idx"
  ON "SeasonalMembershipAssignment"("subscriptionCategoryId");
CREATE INDEX "SeasonalMembershipAssignment_seasonYear_subscriptionCatego_idx"
  ON "SeasonalMembershipAssignment"("seasonYear", "subscriptionCategoryId");

ALTER TABLE "SeasonalMembershipAssignment"
  ADD CONSTRAINT "SeasonalMembershipAssignment_subscriptionCategoryId_fkey"
  FOREIGN KEY ("subscriptionCategoryId") REFERENCES "SubscriptionCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
