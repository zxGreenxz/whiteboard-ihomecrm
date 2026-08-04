import type {
  ArubaPage,
  ArubaPageCursor,
  ConfigDiff,
  MaintenanceInput,
  MaintenanceWindow,
  NetworkActionRequest,
  NetworkActor,
  NetworkBuilding,
  NetworkCenterRepository,
  NetworkJob,
  NetworkSettings,
  PhysicalBuildingRecord,
} from "./contracts";
import { DemoNetworkCenterRepository } from "./demoRepository";

export function synchronizeDemoNetworkCenterRepository(
  repository: DemoNetworkCenterRepository,
  buildings: PhysicalBuildingRecord[],
): DemoNetworkCenterRepository {
  repository.replaceBuildings(buildings);
  return repository;
}

class AsyncDemoNetworkCenterRepository implements NetworkCenterRepository {
  constructor(private readonly repository: DemoNetworkCenterRepository) {}

  async listFleet(): Promise<NetworkBuilding[]> {
    return this.repository.listFleet();
  }

  async getBuilding(buildingId: string): Promise<NetworkBuilding | null> {
    return this.repository.getBuilding(buildingId);
  }

  async listArubaPage(
    buildingId: string,
    cursor: ArubaPageCursor | null = null,
    limit = 100,
  ): Promise<ArubaPage> {
    return this.repository.listArubaPage(buildingId, cursor, limit);
  }

  async acknowledgeIncident(
    buildingId: string,
    incidentId: string,
    actor: NetworkActor,
  ): Promise<void> {
    this.repository.acknowledgeIncident(buildingId, incidentId, actor);
  }

  async createMaintenance(
    buildingId: string,
    input: MaintenanceInput,
    actor: NetworkActor,
  ): Promise<MaintenanceWindow> {
    return this.repository.createMaintenance(buildingId, input, actor);
  }

  async cancelMaintenance(
    buildingId: string,
    maintenanceId: string,
    actor: NetworkActor,
  ): Promise<void> {
    this.repository.cancelMaintenance(buildingId, maintenanceId, actor);
  }

  async captureConfiguration(
    buildingId: string,
    label: string,
    actor: NetworkActor,
  ): Promise<void> {
    this.repository.captureConfiguration(buildingId, label, actor);
  }

  async compareRevisions(
    buildingId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<ConfigDiff> {
    return this.repository.compareRevisions(buildingId, fromRevisionId, toRevisionId);
  }

  async executeAction(
    buildingId: string,
    request: NetworkActionRequest,
    actor: NetworkActor,
  ): Promise<NetworkJob> {
    return this.repository.executeAction(buildingId, request, actor);
  }

  async updateSettings(
    buildingId: string,
    settings: Partial<NetworkSettings>,
    actor: NetworkActor,
    _requestId?: string,
    expectedVersion?: number,
  ): Promise<void> {
    this.repository.updateSettings(buildingId, settings, actor, expectedVersion);
  }
}

export function createAsyncDemoNetworkCenterRepository(
  source: DemoNetworkCenterRepository | PhysicalBuildingRecord[],
): NetworkCenterRepository {
  const repository = source instanceof DemoNetworkCenterRepository
    ? source
    : new DemoNetworkCenterRepository(source);
  return new AsyncDemoNetworkCenterRepository(repository);
}
