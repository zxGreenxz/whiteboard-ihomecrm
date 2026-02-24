import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CustomerStatus } from '@/types/customer';

interface CustomerStatusTabsProps {
  activeTab: CustomerStatus;
  onTabChange: (tab: CustomerStatus) => void;
}

const STATUS_TABS: { value: CustomerStatus; label: string }[] = [
  { value: 'RENTING', label: 'Đang thuê' },
  { value: 'MOVED_OUT', label: 'Đã chuyển đi' },
  { value: 'WALK_IN', label: 'Khách vãng lai' },
];

export default function CustomerStatusTabs({
  activeTab,
  onTabChange,
}: CustomerStatusTabsProps) {
  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as CustomerStatus)}>
      <TabsList>
        {STATUS_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
