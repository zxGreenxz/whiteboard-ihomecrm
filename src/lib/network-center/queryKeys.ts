const normalize = (value: string): string => value.trim().toLowerCase();

const normalizeOrganizations = (organizationIds: readonly string[]): string[] =>
  [...new Set(organizationIds.map(normalize).filter(Boolean))].sort();

export const networkCenterQueryKeys = {
  root: ["network-center"] as const,
  user: (userId: string) => ["network-center", normalize(userId)] as const,
  fleet: (userId: string, organizationIds: readonly string[]) =>
    [
      "network-center",
      normalize(userId),
      "fleet",
      normalizeOrganizations(organizationIds),
    ] as const,
  building: (userId: string, organizationId: string, buildingId: string) =>
    [
      "network-center",
      normalize(userId),
      normalize(organizationId),
      "building",
      normalize(buildingId),
    ] as const,
  aruba: (userId: string, organizationId: string, buildingId: string) =>
    [
      "network-center",
      normalize(userId),
      normalize(organizationId),
      "building",
      normalize(buildingId),
      "aruba",
    ] as const,
};
