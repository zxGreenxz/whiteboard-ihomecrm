import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { NETWORK_CENTER_TABS, isNetworkCenterTab } from "@/lib/network-center/model";
import { useSearchParams } from "react-router-dom";
import { AuditTab } from "./tabs/AuditTab";
import { BackupsTab } from "./tabs/BackupsTab";
import { ChangesTab } from "./tabs/ChangesTab";
import { ClientsTab } from "./tabs/ClientsTab";
import { ConfigurationTab } from "./tabs/ConfigurationTab";
import { IncidentsTab } from "./tabs/IncidentsTab";
import { InterfacesTab } from "./tabs/InterfacesTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { TopologyTab } from "./tabs/TopologyTab";

export function BuildingTabs({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab = isNetworkCenterTab(requestedTab) ? requestedTab : "overview";

  const changeTab = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };

  return (
    <Tabs value={activeTab} onValueChange={changeTab} activationMode="manual" className="nc-tabs">
      <div className="nc-tab-scroll">
        <TabsList aria-label="Khu chức năng toà nhà">
          {NETWORK_CENTER_TABS.map((tab) => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}
        </TabsList>
      </div>
      <TabsContent value="overview"><OverviewTab site={site} controller={controller} /></TabsContent>
      <TabsContent value="interfaces"><InterfacesTab site={site} isDemo={controller.isDemo} /></TabsContent>
      <TabsContent value="clients"><ClientsTab site={site} isDemo={controller.isDemo} /></TabsContent>
      <TabsContent value="topology"><TopologyTab site={site} controller={controller} isDemo={controller.isDemo} /></TabsContent>
      <TabsContent value="incidents"><IncidentsTab site={site} controller={controller} /></TabsContent>
      <TabsContent value="configuration"><ConfigurationTab site={site} controller={controller} /></TabsContent>
      <TabsContent value="backups"><BackupsTab site={site} controller={controller} /></TabsContent>
      <TabsContent value="changes"><ChangesTab site={site} isDemo={controller.isDemo} /></TabsContent>
      <TabsContent value="audit"><AuditTab site={site} isDemo={controller.isDemo} /></TabsContent>
      <TabsContent value="settings"><SettingsTab site={site} controller={controller} /></TabsContent>
    </Tabs>
  );
}
