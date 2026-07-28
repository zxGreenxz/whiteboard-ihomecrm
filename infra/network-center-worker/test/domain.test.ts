import { describe, expect, it } from "vitest";

import {
  InterfaceRegistry,
  RouterOperationError,
  chunkAll,
  classifyWorkerError,
  redactForLog,
} from "../src/domain.js";

describe("worker domain safeguards", () => {
  it("chunks an unlimited inventory without dropping any Aruba", () => {
    const source = Array.from({ length: 777 }, (_, index) => `ap-${index}`);
    const chunks = chunkAll(source, 256);

    expect(chunks.map((chunk) => chunk.length)).toEqual([256, 256, 256, 9]);
    expect(chunks.flat()).toEqual(source);
  });

  it("maps database interface UUIDs back to RouterOS keys", () => {
    const registry = new InterfaceRegistry();
    registry.update("router-1", [{ id: "interface-uuid", interfaceKey: "ether4" }]);
    expect(registry.resolve("router-1", "interface-uuid")).toBe("ether4");
    expect(registry.resolve("router-2", "interface-uuid")).toBeNull();
  });

  it("redacts nested secrets and common credential patterns", () => {
    const sanitized = redactForLog({
      workerSecret: "top-secret",
      nested: { privateKey: "PRIVATE", normal: "safe" },
      text: "password=hunter2 token=abc123",
    });

    expect(JSON.stringify(sanitized)).not.toContain("top-secret");
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
    expect(JSON.stringify(sanitized)).not.toContain("hunter2");
    expect(JSON.stringify(sanitized)).not.toContain("abc123");
    expect(sanitized).toMatchObject({ nested: { normal: "safe" } });
  });

  it("classifies failures and preserves uncertainty for disruptive actions", () => {
    expect(classifyWorkerError(new RouterOperationError("connect_timeout", {
      retryable: true,
      mayHaveExecuted: false,
    }), false)).toMatchObject({ outcome: "RETRYABLE_FAILURE" });

    expect(classifyWorkerError(new RouterOperationError("connection_lost", {
      retryable: true,
      mayHaveExecuted: true,
    }), true)).toMatchObject({ outcome: "UNCERTAIN" });
  });
});
