import { expect, it, vi } from "vitest";
import { cameraInputTime, validateCameraWindow, vietnamCameraInput } from "../network-center/cameraArchive";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

it("round-trips Vietnam time without using the computer timezone", () => {
  const start = Date.parse("2026-10-20T01:00:00.000Z");
  expect(cameraInputTime("2026-10-20T08:00:00")).toBe(start);
  expect(cameraInputTime("2026-10-20T08:00:30.000")).toBe(start + 30_000);
  expect(vietnamCameraInput(start)).toBe("2026-10-20T08:00:00");
  expect(cameraInputTime("2026-02-30T08:00:00")).toBeNaN();
  expect(() => validateCameraWindow("2026-10-20T08:00", "2026-10-20T08:00", 30)).toThrow("sau");
  expect(() => validateCameraWindow("2026-10-20T08:00", "2026-10-20T09:00", 30, Date.parse("2026-10-24T00:00:00Z"))).toThrow("30 phút");
});
