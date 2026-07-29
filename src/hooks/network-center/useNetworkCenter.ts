import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useAuth } from "@/hooks/useAuth";
import { useBuildings } from "@/hooks/useBuildings";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/integrations/supabase/client";
import { canUse } from "@/lib/permissionPages";
import type {
  MaintenanceInput,
  NetworkActionRequest,
  NetworkSettings,
  PhysicalBuildingRecord,
} from "@/lib/network-center/contracts";
import { resolveNetworkActor } from "@/lib/network-center/actorIdentity";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";
import { networkCenterQueryKeys } from "@/lib/network-center/queryKeys";
import {
  createAsyncDemoNetworkCenterRepository,
  synchronizeDemoNetworkCenterRepository,
} from "@/lib/network-center/repositoryLifecycle";
import {
  NETWORK_CENTER_REALTIME_TABLES,
  NETWORK_CENTER_RUNTIME_ENABLED,
  NETWORK_CENTER_RUNTIME_MODE,
  resolveNetworkCenterRealtimeTarget,
  selectNetworkCenterRepository,
} from "@/lib/network-center/runtime";
import { supabaseNetworkCenterRepository } from "@/lib/network-center/supabaseRepository";

const EXECUTE_DISABLED_MESSAGE =
  "Tài khoản chỉ có quyền xem. Cần network_center.execute để thực thi thao tác.";
const REALTIME_DEBOUNCE_MS = 150;

function normalizeId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function useNetworkCenter(selectedBuildingId?: string) {
  const queryClient = useQueryClient();
  const buildingsQuery = useBuildings();
  const permissionsQuery = useMyPermissions();
  const authQuery = useAuth();
  const profileQuery = useProfile();
  const mode = NETWORK_CENTER_RUNTIME_MODE;

  const physicalBuildings = useMemo<PhysicalBuildingRecord[]>(
    () =>
      (buildingsQuery.data ?? []).map((building: {
        id: string;
        name: string;
        rooms_count?: number | null;
        organization_id?: string | null;
      }) => ({
        id: building.id,
        name: building.name,
        roomsCount: building.rooms_count ?? 0,
        organizationId: building.organization_id ?? undefined,
      })),
    [buildingsQuery.data],
  );

  const buildingSignature = physicalBuildings
    .map((building) => (
      `${building.id}:${building.name}:${building.roomsCount ?? 0}:${building.organizationId ?? ""}`
    ))
    .join("|");
  const demoServiceRef = useRef<DemoNetworkCenterRepository | null>(null);
  if (!demoServiceRef.current) {
    demoServiceRef.current = new DemoNetworkCenterRepository([]);
  }
  const demoSignatureRef = useRef("");
  if (mode === "demo" && demoSignatureRef.current !== buildingSignature) {
    synchronizeDemoNetworkCenterRepository(demoServiceRef.current, physicalBuildings);
    demoSignatureRef.current = buildingSignature;
  }
  const demoRepository = useMemo(
    () => createAsyncDemoNetworkCenterRepository(demoServiceRef.current!),
    [],
  );
  const repository = selectNetworkCenterRepository(
    mode,
    supabaseNetworkCenterRepository,
    demoRepository,
  );
  const requireRepository = useCallback(() => {
    if (!repository) throw new Error("Network Center is disabled.");
    return repository;
  }, [repository]);

  const actor = resolveNetworkActor(authQuery.data, profileQuery.data);
  const canView = NETWORK_CENTER_RUNTIME_ENABLED
    && Boolean(actor.id)
    && canUse(permissionsQuery.data, "network_center", "view");
  const canExecute = NETWORK_CENTER_RUNTIME_ENABLED && Boolean(actor.id) && canUse(
    permissionsQuery.data,
    "network_center",
    "execute",
  );
  const organizationIds = useMemo(
    () => physicalBuildings
      .map((building) => building.organizationId)
      .filter((value): value is string => Boolean(value)),
    [physicalBuildings],
  );
  const fleetKey = useMemo(
    () => networkCenterQueryKeys.fleet(actor.id || "anonymous", organizationIds),
    [actor.id, organizationIds],
  );
  const fleetQuery = useQuery({
    queryKey: fleetKey,
    queryFn: () => requireRepository().listFleet(),
    enabled: canView && !buildingsQuery.isLoading && !permissionsQuery.isLoading,
  });
  const fleet = useMemo(() => fleetQuery.data ?? [], [fleetQuery.data]);

  const physicalBuildingById = useMemo(
    () => new Map(physicalBuildings.map((building) => [normalizeId(building.id), building])),
    [physicalBuildings],
  );
  const normalizedSelectedBuildingId = normalizeId(selectedBuildingId);
  const selectedOrganizationId = physicalBuildingById.get(normalizedSelectedBuildingId)
    ?.organizationId ?? "unscoped";
  const buildingKey = useMemo(
    () => networkCenterQueryKeys.building(
      actor.id || "anonymous",
      selectedOrganizationId,
      normalizedSelectedBuildingId || "none",
    ),
    [actor.id, normalizedSelectedBuildingId, selectedOrganizationId],
  );
  const buildingQuery = useQuery({
    queryKey: buildingKey,
    queryFn: async () => {
      const fallback = fleet.find(
        (building) => normalizeId(building.buildingId) === normalizedSelectedBuildingId,
      );
      if (!fallback) return null;
      return requireRepository().getBuilding(normalizedSelectedBuildingId, fallback);
    },
    enabled: canView && Boolean(normalizedSelectedBuildingId) && fleetQuery.isSuccess,
  });

  const availableBuildings = useMemo<PhysicalBuildingRecord[]>(
    () => fleet.map((building) => ({
      id: building.buildingId,
      name: building.buildingName,
      roomsCount: building.roomsCount,
      organizationId: physicalBuildingById.get(normalizeId(building.buildingId))?.organizationId,
    })),
    [fleet, physicalBuildingById],
  );

  const invalidateBuilding = useCallback(async (buildingId: string) => {
    const normalizedBuildingId = normalizeId(buildingId);
    const organizationId = physicalBuildingById.get(normalizedBuildingId)?.organizationId
      ?? "unscoped";
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: fleetKey, exact: true }),
      queryClient.invalidateQueries({
        queryKey: networkCenterQueryKeys.building(
          actor.id || "anonymous",
          organizationId,
          normalizedBuildingId,
        ),
        exact: true,
      }),
    ]);
  }, [actor.id, fleetKey, physicalBuildingById, queryClient]);

  const acknowledgeMutation = useMutation({
    mutationFn: (variables: { buildingId: string; incidentId: string; requestId: string }) =>
      requireRepository().acknowledgeIncident(
        variables.buildingId,
        variables.incidentId,
        actor,
        variables.requestId,
      ),
    onSuccess: (_, variables) => invalidateBuilding(variables.buildingId),
  });
  const createMaintenanceMutation = useMutation({
    mutationFn: (variables: {
      buildingId: string;
      input: MaintenanceInput;
      requestId: string;
    }) => requireRepository().createMaintenance(
      variables.buildingId,
      variables.input,
      actor,
      variables.requestId,
    ),
    onSuccess: (_, variables) => invalidateBuilding(variables.buildingId),
  });
  const cancelMaintenanceMutation = useMutation({
    mutationFn: (variables: {
      buildingId: string;
      maintenanceId: string;
      requestId: string;
    }) => requireRepository().cancelMaintenance(
      variables.buildingId,
      variables.maintenanceId,
      actor,
      variables.requestId,
    ),
    onSuccess: (_, variables) => invalidateBuilding(variables.buildingId),
  });
  const captureConfigurationMutation = useMutation({
    mutationFn: (variables: { buildingId: string; label: string; requestId: string }) =>
      requireRepository().captureConfiguration(
        variables.buildingId,
        variables.label,
        actor,
        variables.requestId,
      ),
    onSuccess: (_, variables) => invalidateBuilding(variables.buildingId),
  });
  const executeActionMutation = useMutation({
    mutationFn: (variables: {
      buildingId: string;
      request: NetworkActionRequest;
      requestId: string;
    }) => requireRepository().executeAction(
      variables.buildingId,
      variables.request,
      actor,
      variables.requestId,
    ),
    onSuccess: (_, variables) => invalidateBuilding(variables.buildingId),
  });
  const updateSettingsMutation = useMutation({
    mutationFn: (variables: {
      buildingId: string;
      settings: Partial<NetworkSettings>;
      requestId: string;
      expectedVersion: number;
    }) => requireRepository().updateSettings(
      variables.buildingId,
      variables.settings,
      actor,
      variables.requestId,
      variables.expectedVersion,
    ),
    onSuccess: (_, variables) => invalidateBuilding(variables.buildingId),
  });

  useEffect(() => {
    if (mode !== "production" || !canView || !actor.id) return undefined;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let invalidateFleet = false;
    const pendingBuildingIds = new Set<string>();
    const flush = () => {
      timeout = undefined;
      const promises: Array<Promise<unknown>> = [];
      if (invalidateFleet) {
        promises.push(queryClient.invalidateQueries({ queryKey: fleetKey, exact: true }));
      }
      for (const buildingId of pendingBuildingIds) {
        const organizationId = physicalBuildingById.get(buildingId)?.organizationId ?? "unscoped";
        promises.push(queryClient.invalidateQueries({
          queryKey: networkCenterQueryKeys.building(actor.id, organizationId, buildingId),
          exact: true,
        }));
      }
      invalidateFleet = false;
      pendingBuildingIds.clear();
      void Promise.allSettled(promises);
    };
    const schedule = (table: (typeof NETWORK_CENTER_REALTIME_TABLES)[number], payload: unknown) => {
      const target = resolveNetworkCenterRealtimeTarget(
        table,
        payload,
        normalizedSelectedBuildingId || undefined,
      );
      invalidateFleet ||= target.invalidateFleet;
      target.buildingIds.forEach((buildingId) => pendingBuildingIds.add(buildingId));
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(flush, REALTIME_DEBOUNCE_MS);
    };

    let channel = supabase.channel(`network-center-${actor.id}`);
    for (const table of NETWORK_CENTER_REALTIME_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload) => schedule(table, payload),
      );
    }
    channel.subscribe();

    return () => {
      if (timeout) clearTimeout(timeout);
      void supabase.removeChannel(channel);
    };
  }, [
    actor.id,
    canView,
    fleetKey,
    mode,
    normalizedSelectedBuildingId,
    physicalBuildingById,
    queryClient,
  ]);

  const requireExecute = () => {
    if (!canExecute) throw new Error(EXECUTE_DISABLED_MESSAGE);
  };

  return {
    mode,
    isDemo: mode === "demo",
    buildingsQuery,
    permissionsQuery,
    authQuery,
    profileQuery,
    fleetQuery,
    buildingQuery,
    physicalBuildings,
    availableBuildings,
    fleet,
    selectedBuilding: buildingQuery.data ?? null,
    actor,
    canView,
    canExecute,
    executeDisabledMessage: EXECUTE_DISABLED_MESSAGE,
    async acknowledgeIncident(buildingId: string, incidentId: string) {
      requireExecute();
      return acknowledgeMutation.mutateAsync({
        buildingId,
        incidentId,
        requestId: crypto.randomUUID(),
      });
    },
    async createMaintenance(buildingId: string, input: MaintenanceInput) {
      requireExecute();
      return createMaintenanceMutation.mutateAsync({
        buildingId,
        input,
        requestId: crypto.randomUUID(),
      });
    },
    async cancelMaintenance(buildingId: string, maintenanceId: string) {
      requireExecute();
      return cancelMaintenanceMutation.mutateAsync({
        buildingId,
        maintenanceId,
        requestId: crypto.randomUUID(),
      });
    },
    async captureConfiguration(buildingId: string, label: string) {
      requireExecute();
      return captureConfigurationMutation.mutateAsync({
        buildingId,
        label,
        requestId: crypto.randomUUID(),
      });
    },
    compareRevisions(
      buildingId: string,
      fromRevisionId: string,
      toRevisionId: string,
    ) {
      return requireRepository().compareRevisions(
        buildingId,
        fromRevisionId,
        toRevisionId,
      );
    },
    async executeAction(buildingId: string, request: NetworkActionRequest) {
      requireExecute();
      return executeActionMutation.mutateAsync({
        buildingId,
        request,
        requestId: crypto.randomUUID(),
      });
    },
    async updateSettings(
      buildingId: string,
      settings: Partial<NetworkSettings>,
      expectedVersion: number,
    ) {
      requireExecute();
      return updateSettingsMutation.mutateAsync({
        buildingId,
        settings,
        requestId: crypto.randomUUID(),
        expectedVersion,
      });
    },
  };
}

export type NetworkCenterController = ReturnType<typeof useNetworkCenter>;
