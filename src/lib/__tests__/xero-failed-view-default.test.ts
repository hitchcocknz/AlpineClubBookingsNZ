import { describe, expect, it } from "vitest"
import { failureStateAfterStatusChange } from "@/lib/xero-operation-resolution"

// #4220: the Failed view's Active-only default, as a pure rule.
describe("failureStateAfterStatusChange (#4220)", () => {
  it("picks Active when Failed is chosen over an untouched Failure filter", () => {
    expect(
      failureStateAfterStatusChange({ previousStatus: "all", nextStatus: "FAILED", failureState: "all" }),
    ).toBe("ACTIVE")
    expect(
      failureStateAfterStatusChange({ previousStatus: "PENDING", nextStatus: "FAILED", failureState: "all" }),
    ).toBe("ACTIVE")
  })

  it("keeps a Failure choice the officer already made", () => {
    for (const failureState of ["REPAIRED", "SUPERSEDED", "ACTIVE"]) {
      expect(
        failureStateAfterStatusChange({ previousStatus: "all", nextStatus: "FAILED", failureState }),
      ).toBe(failureState)
    }
  })

  it("drops Active when Status leaves Failed, so no failed rows sit under another status", () => {
    expect(
      failureStateAfterStatusChange({ previousStatus: "FAILED", nextStatus: "PENDING", failureState: "ACTIVE" }),
    ).toBe("all")
    expect(
      failureStateAfterStatusChange({ previousStatus: "FAILED", nextStatus: "all", failureState: "ACTIVE" }),
    ).toBe("all")
  })

  it("leaves other Failure choices alone when Status leaves Failed", () => {
    expect(
      failureStateAfterStatusChange({ previousStatus: "FAILED", nextStatus: "all", failureState: "REPAIRED" }),
    ).toBe("REPAIRED")
  })

  it("changes nothing when Status stays put or neither side is Failed", () => {
    expect(
      failureStateAfterStatusChange({ previousStatus: "FAILED", nextStatus: "FAILED", failureState: "all" }),
    ).toBe("all")
    expect(
      failureStateAfterStatusChange({ previousStatus: "all", nextStatus: "PENDING", failureState: "all" }),
    ).toBe("all")
  })
})
