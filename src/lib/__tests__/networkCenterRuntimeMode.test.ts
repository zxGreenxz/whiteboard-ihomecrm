import {
  Children,
  createElement,
  Fragment,
  isValidElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PermissionsMap } from "@/hooks/useMyPermissions";

vi.mock("@/lib/network-center/runtime", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/network-center/runtime")
  >();
  const mode = "off" as const;

  return {
    ...actual,
    NETWORK_CENTER_RUNTIME_MODE: mode,
    NETWORK_CENTER_RUNTIME_ENABLED: actual.isNetworkCenterEnabled(mode),
  };
});

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({
    data: {
      network_center: { view: true },
    } satisfies PermissionsMap,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/reports/useBusinessPerformance", () => ({
  useBusinessPerformanceOrganizations: () => ({
    data: [],
    isSuccess: true,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: "user-a", email: "user@example.com" } }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useProfile", () => ({
  useProfile: () => ({ data: { full_name: "Test User" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

import App from "@/App";
import Sidebar from "@/components/layout/Sidebar";
import {
  isNetworkCenterEnabled,
  resolveNetworkCenterMode,
  selectNetworkCenterRepository,
} from "@/lib/network-center/runtime";
import { LAUNCHER_SECTIONS } from "@/pages/home/launcherTiles";

function collectRoutePaths(node: ReactNode, paths: string[] = []): string[] {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;

    if (child.type === Route && typeof child.props.path === "string") {
      paths.push(child.props.path);
    }
    collectRoutePaths(child.props.children, paths);
  });
  return paths;
}

function resolveRoutePath(paths: string[], pathname: string): string | undefined {
  return paths.find((path) => {
    if (path === "*") return false;
    if (path.endsWith("/*")) return pathname.startsWith(path.slice(0, -1));
    return path === pathname;
  }) ?? paths.find((path) => path === "*");
}

function renderSidebar(): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        StaticRouter,
        { location: "/" },
        createElement(Fragment, null, createElement(Sidebar)),
      ),
    ),
  );
}

describe("Network Center runtime mode", () => {
  it("fails closed to off when production mode is missing or invalid", () => {
    expect(resolveNetworkCenterMode(undefined, true)).toBe("off");
    expect(resolveNetworkCenterMode("", true)).toBe("off");
    expect(resolveNetworkCenterMode("development", true)).toBe("off");
  });

  it("accepts explicit modes without allowing demo in production builds", () => {
    expect(resolveNetworkCenterMode("off", true)).toBe("off");
    expect(resolveNetworkCenterMode("production", true)).toBe("production");
    expect(resolveNetworkCenterMode("demo", true)).toBe("off");
    expect(resolveNetworkCenterMode(" DEMO ", false)).toBe("demo");
    expect(resolveNetworkCenterMode("off", false)).toBe("off");
  });

  it("selects no repository while disabled", () => {
    const production = { kind: "production" };
    const demo = { kind: "demo" };

    expect(selectNetworkCenterRepository("off", production, demo)).toBeNull();
    expect(selectNetworkCenterRepository("production", production, demo)).toBe(production);
    expect(selectNetworkCenterRepository("demo", production, demo)).toBe(demo);
    expect(isNetworkCenterEnabled("off")).toBe(false);
    expect(isNetworkCenterEnabled("demo")).toBe(true);
    expect(isNetworkCenterEnabled("production")).toBe(true);
  });

  it("falls through the real App route tree when off", () => {
    const paths = collectRoutePaths(App());

    expect(paths).not.toContain("/network-center/*");
    expect(resolveRoutePath(paths, "/network-center")).toBe("*");
  });

  it("omits Network Center from the rendered Sidebar and launcher catalog", () => {
    expect(renderSidebar()).not.toContain('href="/network-center"');
    expect(
      LAUNCHER_SECTIONS.flatMap((section) => section.items)
        .some((tile) => tile.href === "/network-center"),
    ).toBe(false);
  });
});
