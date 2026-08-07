import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isOpenClawEnabled, resolveOpenClawMode } from "../runtime";

/**
 * The switch that decides whether an unfinished cockpit is reachable in a build.
 *
 * It exists because the server permission cannot do this job. `openclaw_zalo.view`
 * is granted to the owner role of every organization, the real one included, so it
 * answers "who may use this" - not "is this finished". Without a build-time flag,
 * the first deploy of this branch would put Tasks 26/28/29-incomplete screens in
 * front of real owners.
 */
describe("OpenClaw runtime flag", () => {
  it("is off when nothing is configured", () => {
    // The default has to be off, not on: a feature that ships by forgetting to set
    // a variable is a feature nobody decided to ship.
    expect(resolveOpenClawMode(undefined, false)).toBe("off");
    expect(resolveOpenClawMode("", false)).toBe("off");
    expect(resolveOpenClawMode("   ", true)).toBe("off");
    expect(isOpenClawEnabled(resolveOpenClawMode(undefined, true))).toBe(false);
  });

  it("refuses demo in a production build", () => {
    // A stray VITE_OPENCLAW_ZALO_MODE=demo in the Vercel project would otherwise
    // open the cockpit on ptcrm.vercel.app, which is exactly the accident this
    // guard exists to make impossible.
    expect(resolveOpenClawMode("demo", true)).toBe("off");
    expect(resolveOpenClawMode("demo", false)).toBe("demo");
  });

  it("opens only for an exact, deliberate value", () => {
    expect(resolveOpenClawMode("production", true)).toBe("production");
    expect(resolveOpenClawMode("PRODUCTION", true)).toBe("production");
    for (const wrong of ["prod", "on", "true", "1", "enabled", "productions"]) {
      expect(resolveOpenClawMode(wrong, false), wrong).toBe("off");
    }
  });

  it("cờ TẮT thì bảng route THẬT không có /openclaw-zalo", async () => {
    // VIẾT LẠI Ở P1.2 (tách App.tsx).
    //
    // Bản cũ regex trên VĂN BẢN NGUỒN của src/App.tsx, tìm `OPENCLAW_RUNTIME_ENABLED ? (`
    // đứng gần `path="/openclaw-zalo"`. Cây route đã dời sang src/app/routes/index.tsx
    // nên nó vỡ — vì HÌNH DẠNG đổi, không phải vì tính chất mất.
    //
    // Và bản cũ vốn yếu hơn tên gọi: nó chứng minh hai chuỗi ở gần nhau trong một
    // file, không chứng minh react-router THẬT SỰ không thấy route đó. Nay dựng
    // cây route thật rồi đếm — đúng cách test Network Center bên cạnh đang làm.
    const { AppRoutes } = await import("@/app/routes");
    const { Route } = await import("react-router-dom");
    const { Children, isValidElement } = await import("react");

    type ReactNode = Parameters<typeof Children.forEach>[0];
    const duyet = (node: ReactNode, ra: string[] = []): string[] => {
      Children.forEach(node, (child) => {
        if (!isValidElement(child)) return;
        const props = child.props as { path?: unknown; children?: ReactNode };
        if (child.type === Route && typeof props.path === "string") ra.push(props.path);
        duyet(props.children, ra);
      });
      return ra;
    };

    const paths = duyet(AppRoutes());
    expect(paths.length, "không dựng được bảng route — phép đo hỏng").toBeGreaterThan(50);
    // Cờ mặc định TẮT (đã chốt ở test khác trong file này).
    expect(paths).not.toContain("/openclaw-zalo");
  });
});
