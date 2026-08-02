import { describe, expect, it } from "vitest";

import { ApiClientError } from "../src/apiClient.js";
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

  it("maps database interface UUIDs to immutable managed-interface targets", () => {
    const registry = new InterfaceRegistry();
    registry.update("router-1", [{
      managedResourceId: "managed-resource-uuid",
      id: "interface-uuid",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);
    expect(registry.resolve("router-1", "interface-uuid")).toEqual({
      managedResourceId: "managed-resource-uuid",
      interfaceId: "interface-uuid",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    });
    expect(registry.resolve("router-2", "interface-uuid")).toBeNull();
  });

  it("fails closed when a managed interface loses immutable enrollment evidence", () => {
    const registry = new InterfaceRegistry();
    registry.update("router-1", [{
      managedResourceId: null,
      id: "interface-uuid",
      interfaceKey: "room-401",
      currentName: "room-401",
      immutableKey: null,
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "DISCOVERED",
    }]);

    expect(registry.resolve("router-1", "interface-uuid")).toBeNull();
  });

  it("drops stale managed-interface mappings when a router inventory refresh replaces them", () => {
    const registry = new InterfaceRegistry();
    registry.update("router-1", [{
      managedResourceId: "managed-resource-uuid",
      id: "interface-uuid",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }]);

    registry.update("router-1", []);

    expect(registry.resolve("router-1", "interface-uuid")).toBeNull();
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

  it("classifies control-plane transport failures by their own retryable semantics", () => {
    expect(classifyWorkerError(
      new ApiClientError({ code: "HTTP_503", retryable: true, status: 503 }),
      false,
    )).toMatchObject({ outcome: "RETRYABLE_FAILURE", result: { code: "HTTP_503" } });

    expect(classifyWorkerError(
      new ApiClientError({ code: "NETWORK_ERROR", retryable: true }),
      true,
      false,
    )).toMatchObject({ outcome: "RETRYABLE_FAILURE", result: { code: "NETWORK_ERROR" } });

    expect(classifyWorkerError(
      new ApiClientError({ code: "HTTP_400", retryable: false, status: 400 }),
      true,
      false,
    )).toMatchObject({ outcome: "FAILED", result: { code: "HTTP_400" } });
  });

  it("never turns a control-plane failure after a disruptive action into a clean retry", () => {
    expect(classifyWorkerError(
      new ApiClientError({ code: "NETWORK_ERROR", retryable: true }),
      true,
      true,
    )).toMatchObject({ outcome: "UNCERTAIN", result: { code: "NETWORK_ERROR" } });

    expect(classifyWorkerError(
      new ApiClientError({ code: "HTTP_502", retryable: true, status: 502 }),
      false,
      true,
    )).toMatchObject({ outcome: "RETRYABLE_FAILURE" });
  });

  it("still fails closed on an error that carries no retryable semantics", () => {
    expect(classifyWorkerError(new Error("boom"), true, true)).toMatchObject({
      outcome: "FAILED",
      result: { code: "UNEXPECTED_WORKER_ERROR" },
    });
  });
});
