import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/hooks/useAuth";
import { useBuildings } from "@/hooks/useBuildings";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/integrations/supabase/client";
import { canUse } from "@/lib/permissionPages";
import type {
  ArubaNode,
  ArubaPageCursor,
  MaintenanceInput,
  NetworkActionRequest,
  NetworkSettings,
  PhysicalBuildingRecord,
} from "@/lib/network-center/contracts";
import { resolveNetworkActor } from "@/lib/network-center/actorIdentity";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";
import { createIntentRegistry } from "@/lib/network-center/intentRegistry";
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
import {
  NetworkCenterRepositoryError,
  supabaseNetworkCenterRepository,
} from "@/lib/network-center/supabaseRepository";

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
  const intentRegistryRef = useRef<ReturnType<typeof createIntentRegistry> | null>(null);
  if (!intentRegistryRef.current) intentRegistryRef.current = createIntentRegistry();
  const intentRegistry = intentRegistryRef.current;
  const [intentRevision, setIntentRevision] = useState(0);
  useEffect(
    () => intentRegistry.subscribe(() => setIntentRevision((current) => current + 1)),
    [intentRegistry],
  );

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
  useEffect(() => {
    if (!actor.id || organizationIds.length === 0) return;
    intentRegistry.prune({ actorId: actor.id, organizationIds });
  }, [actor.id, intentRegistry, organizationIds]);
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
  const arubaKey = useMemo(
    () => networkCenterQueryKeys.aruba(
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
  const activeIntent = useMemo(
    () => intentRegistry.list({
      actorId: actor.id,
      organizationId: selectedOrganizationId,
      buildingId: normalizedSelectedBuildingId,
    })[0] ?? null,
    [
      actor.id,
      intentRegistry,
      intentRevision,
      normalizedSelectedBuildingId,
      selectedOrganizationId,
    ],
  );
  const activeCommandQuery = useQuery({
    queryKey: [
      ...buildingKey,
      "intent",
      activeIntent?.commandId ?? activeIntent?.id ?? "none",
    ],
    queryFn: async () => {
      const currentRepository = requireRepository();
      if (!currentRepository.getCommand || !activeIntent) return null;
      return currentRepository.getCommand(normalizedSelectedBuildingId, {
        commandId: activeIntent.commandId,
        requestId: activeIntent.commandId ? null : activeIntent.id,
      });
    },
    enabled: canView && Boolean(activeIntent && repository?.getCommand),
    retry: activeIntent?.status === "SUBMISSION_UNKNOWN" ? 6 : 2,
    retryDelay: 2_000,
    refetchInterval: activeIntent?.status === "SUBMISSION_UNKNOWN" ? 5_000 : false,
  });
  useEffect(() => {
    const command = activeCommandQuery.data;
    if (!activeIntent || !command) return;
    intentRegistry.attachCommand(activeIntent.id, command.id, command.status);
    intentRegistry.observeCommand(command.id, command.status);
  }, [activeCommandQuery.data, activeIntent, intentRegistry]);
  const arubaQuery = useInfiniteQuery({
    queryKey: arubaKey,
    initialPageParam: null as ArubaPageCursor | null,
    queryFn: ({ pageParam }) => requireRepository().listArubaPage(
      normalizedSelectedBuildingId,
      pageParam,
    ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    maxPages: 1,
    enabled: canView && Boolean(normalizedSelectedBuildingId) && fleetQuery.isSuccess,
  });
  const arubaNodes = useMemo<ArubaNode[]>(
    () => arubaQuery.data?.pages.at(-1)?.items ?? [],
    [arubaQuery.data],
  );
  const selectedBuilding = useMemo(() => {
    const building = buildingQuery.data;
    if (!building) return null;
    const hasLoadedAruba = Boolean(arubaQuery.data?.pages.length);
    const arubaTotal = Math.max(building.arubaTotal ?? 0, arubaNodes.length);
    const loadedEveryArubaPage = hasLoadedAruba
      && !arubaQuery.hasNextPage
      && arubaNodes.length >= arubaTotal;
    return {
      ...building,
      arubaNodes,
      arubaTotal,
      arubaOnline: loadedEveryArubaPage
        ? arubaNodes.filter((node) => node.status === "online").length
        : null,
      jobs: activeCommandQuery.data
        ? [
          { ...activeCommandQuery.data, isStableIntent: true },
          ...building.jobs.filter((job) => job.id !== activeCommandQuery.data?.id),
        ]
        : building.jobs,
    };
  }, [
    activeCommandQuery.data,
    arubaNodes,
    arubaQuery.data,
    arubaQuery.hasNextPage,
    buildingQuery.data,
  ]);

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
      queryClient.invalidateQueries({
        queryKey: networkCenterQueryKeys.aruba(
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
        promises.push(queryClient.invalidateQueries({
          queryKey: networkCenterQueryKeys.aruba(actor.id, organizationId, buildingId),
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

  useEffect(() => {
    for (const job of selectedBuilding?.jobs ?? []) {
      intentRegistry.observeCommand(job.id, job.status);
    }
  }, [intentRegistry, selectedBuilding?.jobs]);

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
    selectedBuilding,
    activeActionIntent: activeIntent,
    arubaNodes,
    hasNextArubaPage: Boolean(arubaQuery.hasNextPage),
    isLoadingAruba: arubaQuery.isLoading,
    isLoadingMoreAruba: arubaQuery.isFetchingNextPage,
    arubaPageError: arubaQuery.isError
      ? "Không thể tải danh sách Aruba. Vui lòng thử lại."
      : "",
    actor,
    canView,
    canExecute,
    executeDisabledMessage: EXECUTE_DISABLED_MESSAGE,
    async loadMoreAruba() {
      if (!arubaQuery.hasNextPage || arubaQuery.isFetchingNextPage) return;
      await arubaQuery.fetchNextPage();
    },
    async retryAruba() {
      await arubaQuery.refetch();
    },
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
      const normalizedBuildingId = normalizeId(buildingId);
      const building = selectedBuilding?.buildingId === normalizedBuildingId
        ? selectedBuilding
        : fleet.find((item) => normalizeId(item.buildingId) === normalizedBuildingId);
      const organizationId = physicalBuildingById.get(normalizedBuildingId)?.organizationId;
      if (!actor.id || !organizationId || !building?.router.id) {
        throw new Error("Không thể xác định phạm vi intent Network Center.");
      }
      const interfaceId = typeof request.fields.interfaceId === "string"
        ? request.fields.interfaceId
        : null;
      const intent = intentRegistry.begin({
        actorId: actor.id,
        organizationId,
        buildingId: normalizedBuildingId,
        deviceId: building.router.id,
        actionType: request.type,
        interfaceId,
        parameters: request.fields,
        reason: request.reason,
        confirmation: request.confirmation ?? null,
      });
      const frozenRequest: NetworkActionRequest = {
        type: intent.target.actionType,
        reason: intent.target.reason,
        fields: intent.target.parameters,
        ...(intent.target.confirmation
          ? { confirmation: intent.target.confirmation }
          : {}),
      };
      intentRegistry.observe(intent.id, "SUBMITTING");
      try {
        const job = await executeActionMutation.mutateAsync({
          buildingId: intent.target.buildingId,
          request: frozenRequest,
          requestId: intent.id,
        });
        intentRegistry.attachCommand(intent.id, job.id, job.status);
        intentRegistry.observeCommand(job.id, job.status);
        return job;
      } catch (error) {
        const authoritativeRejection = error instanceof NetworkCenterRepositoryError
          && Boolean(error.code);
        intentRegistry.observe(
          intent.id,
          authoritativeRejection ? "FAILED" : "SUBMISSION_UNKNOWN",
        );
        throw error;
      }
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
