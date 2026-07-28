import type { PhysicalBuildingRecord } from "./contracts";
import { DemoNetworkCenterRepository } from "./demoRepository";

export function synchronizeDemoNetworkCenterRepository(
  repository: DemoNetworkCenterRepository,
  buildings: PhysicalBuildingRecord[],
): DemoNetworkCenterRepository {
  repository.replaceBuildings(buildings);
  return repository;
}
