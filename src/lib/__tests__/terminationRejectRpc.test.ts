import { describe, expect, it } from "vitest";
import { rejectTermination } from "../terminationRejectRpc";

describe("rejectTermination boundary", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("rejects malformed IDs before invoking a writer", async () => {
    await expect(rejectTermination(() => { throw new Error("writer invoked"); }, { termination_id: "bad" })).rejects.toThrow("thanh lý");
  });
  it("propagates unavailable writer and authority errors without another write", async () => {
    for (const code of ["PGRST202", "42501", "55000"]) {
      let calls = 0;
      const error = { code, message: "denied" };
      await expect(rejectTermination(() => { calls++; return Promise.resolve({ data: null, error }); }, { termination_id: id })).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });
  it("sends the exact reason and accepts the server void response", async () => {
    let payload: unknown;
    await expect(rejectTermination((fn, args) => {
      payload = { fn, args };
      return Promise.resolve({ data: null, error: null });
    }, { termination_id: id, rejection_reason: "reason" })).resolves.toEqual({ success: true });
    expect(payload).toEqual({ fn: "reject_contract_termination_v1", args: { p_termination_id: id, p_reason: "reason" } });
  });
  it("does not accept an unexpected server response as success", async () => {
    await expect(rejectTermination(() => Promise.resolve({ data: { success: false }, error: null }), { termination_id: id })).rejects.toThrow("phản hồi");
  });
});
