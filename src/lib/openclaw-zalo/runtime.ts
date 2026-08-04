/**
 * Whether the OpenClaw Zalo cockpit is reachable in this build.
 *
 * The route is otherwise gated only by the server permission `openclaw_zalo.view`,
 * and that permission is now granted to the owner role of every organization -
 * including the real one. So the moment this branch reaches main, Vercel would put
 * a half-finished cockpit in front of real owners: Tasks 26, 28 and 29 of the plan
 * are not done, no end-to-end scenario has ever run, and no Zalo account is
 * connected. A server permission is the wrong instrument for "not shipped yet";
 * it says who MAY use a feature, not whether the feature exists.
 *
 * This mirrors NETWORK_CENTER_RUNTIME_ENABLED, which main already uses for exactly
 * this situation. Default is OFF, and `demo` is refused in a production build so a
 * stray environment variable cannot open it on ptcrm.vercel.app.
 */
export type OpenClawRuntimeMode = "off" | "demo" | "production";

export function resolveOpenClawMode(
  value: string | undefined,
  isProductionBuild: boolean,
): OpenClawRuntimeMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production") return "production";
  if (normalized === "demo" && !isProductionBuild) return "demo";
  return "off";
}

export function isOpenClawEnabled(mode: OpenClawRuntimeMode): boolean {
  return mode !== "off";
}

export const OPENCLAW_RUNTIME_MODE: OpenClawRuntimeMode = resolveOpenClawMode(
  import.meta.env?.VITE_OPENCLAW_ZALO_MODE as string | undefined,
  import.meta.env?.PROD === true,
);

export const OPENCLAW_RUNTIME_ENABLED = isOpenClawEnabled(OPENCLAW_RUNTIME_MODE);
