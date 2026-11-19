import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { companySessionToken } from "@/lib/companyPreferenceRemote";

export const cameraQualityChoices = {
  live: ["sd", "hd", "fullhd", "original"], playback: ["sd", "hd", "fullhd", "original"], export: ["480p", "720p", "1080p", "original"],
} as const;
type Kind = keyof typeof cameraQualityChoices;
type Quality<K extends Kind> = typeof cameraQualityChoices[K][number];
const writes = new Map<string, Promise<void>>();
const changes = new Map<string, { value: string }>();
const storageKey = (owner: string, kind: Kind) => `ihomecrm.camera-quality:${owner}:${kind}`;
function local(owner: string, kind: Kind) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(owner, kind)) ?? "null");
    if (value && typeof value === "object" && "value" in value && typeof value.value === "string" && (cameraQualityChoices[kind] as readonly string[]).includes(value.value)) return { value: value.value, pending: "pending" in value && value.pending === true };
  } catch { /* Unavailable or outdated device storage cannot block camera playback. */ }
}
function remember(owner: string, kind: Kind, value: string, pending: boolean) {
  try { localStorage.setItem(storageKey(owner, kind), JSON.stringify({ value, pending })); } catch { /* Server persistence remains available. */ }
}
/** Separate, account-scoped preferences; each RPC atomically changes only one JSON key. */
export function useCameraQuality<K extends Kind>(kind: K): readonly [Quality<K>, (value: Quality<K>) => void, string] {
  const owner = useAuth().data?.id ?? null;
  const fallback = cameraQualityChoices[kind][0] as Quality<K>;
  const revision = useRef(0); const currentOwner = useRef(owner); currentOwner.current = owner;
  const [state, setState] = useState<{ owner: string | null; value: Quality<K>; notice: string }>({ owner, value: fallback, notice: "" });
  const save = (user: string, value: Quality<K>, version: number) => {
    const key = `camera_${kind}_quality`; const serialKey = storageKey(user, kind);
    changes.set(serialKey, { value }); // Identity survives remounts and invalidates reads started before this choice.
    const task = (writes.get(serialKey) ?? Promise.resolve()).catch(() => { /* The previous selection reports its own failure; the newer choice must still save. */ }).then(async () => {
      const token = await companySessionToken(user);
      const { data, error } = await supabase.rpc("set_my_ui_preference", { p_key: key, p_value: value }).setHeader("Authorization", `Bearer ${token}`);
      if (error || !data || typeof data !== "object" || Array.isArray(data) || data[key] !== value) throw new Error("PREFERENCE_NOT_SAVED");
    });
    writes.set(serialKey, task);
    void task.then(() => {
      if (writes.get(serialKey) === task) { writes.delete(serialKey); remember(user, kind, value, false); }
      if (currentOwner.current === user && revision.current === version) setState({ owner: user, value, notice: "" });
    }, () => {
      if (writes.get(serialKey) === task) writes.delete(serialKey);
      if (currentOwner.current === user && revision.current === version) setState({ owner: user, value, notice: "Lựa chọn đang giữ trên máy này; chưa đồng bộ được vào tài khoản." });
    });
  };
  useEffect(() => {
    const version = ++revision.current; let active = true;
    if (!owner) { setState({ owner, value: fallback, notice: "" }); return; }
    const cached = local(owner, kind);
    const serialKey = storageKey(owner, kind); const changeAtLoad = changes.get(serialKey); const pendingAtLoad = writes.get(serialKey);
    setState({ owner, value: (cached?.value as Quality<K> | undefined) ?? fallback, notice: "" });
    void (async () => {
      try {
        const token = await companySessionToken(owner);
        const { data, error } = await supabase.from("profiles").select("ui_preferences").eq("id", owner).single().setHeader("Authorization", `Bearer ${token}`);
        if (error) throw error;
        if (!active || revision.current !== version || currentOwner.current !== owner) return;
        const latest = local(owner, kind);
        if (latest?.pending) { setState({ owner, value: latest.value as Quality<K>, notice: "" }); if (!writes.has(storageKey(owner, kind))) save(owner, latest.value as Quality<K>, version); return; }
        if (pendingAtLoad || changes.get(serialKey) !== changeAtLoad) {
          const recent = changes.get(serialKey)?.value ?? latest?.value;
          if (recent) setState({ owner, value: recent as Quality<K>, notice: "" });
          return;
        }
        const preferences = data?.ui_preferences;
        const value = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? preferences[`camera_${kind}_quality`] : undefined;
        if (typeof value === "string" && (cameraQualityChoices[kind] as readonly string[]).includes(value)) {
          remember(owner, kind, value, false); setState({ owner, value: value as Quality<K>, notice: "" });
        }
      } catch { /* Keep the account's cached choice; a later explicit selection retries saving. */ }
    })();
    return () => { active = false; ++revision.current; };
    // save is bound to this preference kind; explicit selection revisions protect against stale reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, kind, fallback]);
  const select = (value: Quality<K>) => {
    if (!(cameraQualityChoices[kind] as readonly string[]).includes(value)) return;
    const version = ++revision.current; setState({ owner, value, notice: "" });
    if (owner) { remember(owner, kind, value, true); save(owner, value, version); }
  };
  return [state.owner === owner ? state.value : fallback, select, state.owner === owner ? state.notice : ""] as const;
}
