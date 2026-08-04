import type { NetworkActor } from "./contracts";

interface AuthUserIdentity {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

interface ProfileIdentity {
  id?: string | null;
  full_name?: string | null;
  email?: string | null;
}

const cleanLabel = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export function resolveNetworkActor(
  user: AuthUserIdentity | null | undefined,
  profile: ProfileIdentity | null | undefined,
): NetworkActor {
  if (!user?.id) return { id: "", label: "" };
  const metadata = user.user_metadata ?? {};
  const matchingProfile = profile?.id === user.id ? profile : null;
  const label = [
    matchingProfile?.full_name,
    metadata.full_name,
    metadata.display_name,
    metadata.name,
    matchingProfile?.email,
    user.email,
    user.id,
  ].map(cleanLabel).find(Boolean) ?? user.id;
  return { id: user.id, label };
}
