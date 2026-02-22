import { useState, useEffect } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Gauge, Zap, Droplet, Save, History, AlertCircle, CheckCircle2 } from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import { useContracts } from '@/hooks/useContracts';
import { useMeterReadings, useBulkCreateMeterReadings, type BulkMeterReadingData } from '@/hooks/useInvoices';
import MeterReadingHistoryDialog from '@/components/meter-readings/MeterReadingHistoryDialog';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface MeterInput {
  contract_id: string;
  service_id: string;
  meter_type: 'ELECTRIC' | 'WATER';
  previous_reading: number;
  current_reading: number;
  has_changes: boolean;
  is_valid: boolean;
}

const MeterReadingsPage = () => {
  const [readingDate, setReadingDate] = useState(new Date().toISOString().split('T')[0]);
  const [meterInputs, setMeterInputs] = useState<Record<string, MeterInput>>({});
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);

  const { data: contracts, isLoading: contractsLoading } = useContracts({ status: 'ACTIVE' });
  const { data: allMeterReadings } = useMeterReadings();
  const bulkCreateMutation = useBulkCreateMeterReadings();

  // Active contracts with metered services (electric or water) - DEFENSIVE CHECK
  const contractsArray = Array.isArray(contracts?.data) ? contracts.data : (Array.isArray(contracts) ? contracts : []);
  const activeContractsWithMeters = contractsArray.filter((contract: any) =>
    contract?.contract_services?.some((cs: any) =>
      cs.service?.billing_type === 'METERED'
    )
  );

  // Initialize meter inputs from latest readings
  useEffect(() => {
    if (!activeContractsWithMeters || activeContractsWithMeters.length === 0) return;
    // DEFENSIVE CHECK for allMeterReadings
    const meterReadingsArray = Array.isArray(allMeterReadings) ? allMeterReadings : [];

    const inputs: Record<string, MeterInput> = {};

    activeContractsWithMeters.forEach((contract: any) => {
      // Get electric service
      const electricService = contract.contract_services?.find((cs: any) =>
        cs.service?.name?.toLowerCase().includes('điện') || cs.service?.name?.toLowerCase().includes('electric')
      );

      if (electricService) {
        const lastElectricReading = meterReadingsArray
          .filter((r: any) => r.contract_id === contract.id && r.service_id === electricService.service_id && r.meter_type === 'ELECTRIC')
          .sort((a: any, b: any) => new Date(b.reading_date).getTime() - new Date(a.reading_date).getTime())[0];

        const previousReading = lastElectricReading?.current_reading || electricService.initial_reading || 0;

        inputs[`${contract.id}_electric`] = {
          contract_id: contract.id,
          service_id: electricService.service_id,
          meter_type: 'ELECTRIC',
          previous_reading: previousReading,
          current_reading: previousReading,
          has_changes: false,
          is_valid: true,
        };
      }

      // Get water service
      const waterService = contract.contract_services?.find((cs: any) =>
        cs.service?.name?.toLowerCase().includes('nước') || cs.service?.name?.toLowerCase().includes('water')
      );

      if (waterService) {
        const lastWaterReading = meterReadingsArray
          .filter((r: any) => r.contract_id === contract.id && r.service_id === waterService.service_id && r.meter_type === 'WATER')
          .sort((a: any, b: any) => new Date(b.reading_date).getTime() - new Date(a.reading_date).getTime())[0];

        const previousReading = lastWaterReading?.current_reading || waterService.initial_reading || 0;

        inputs[`${contract.id}_water`] = {
          contract_id: contract.id,
          service_id: waterService.service_id,
          meter_type: 'WATER',
          previous_reading: previousReading,
          current_reading: previousReading,
          has_changes: false,
          is_valid: true,
        };
      }
    });

    setMeterInputs(inputs);
  }, [activeContractsWithMeters, allMeterReadings]);

  const handleInputChange = (key: string, value: number) => {
    setMeterInputs((prev) => {
      const input = prev[key];
      if (!input) return prev;

      const newReading = value;
      const isValid = newReading >= input.previous_reading;
      const hasChanges = newReading !== input.previous_reading;

      return {
        ...prev,
        [key]: {
          ...input,
          current_reading: newReading,
          has_changes: hasChanges,
          is_valid: isValid,
        },
      };
    });
  };

  const handleSaveContract = (contractId: string) => {
    const contractInputs = Object.entries(meterInputs)
      .filter(([key, value]) => key.startsWith(contractId) && value.has_changes && value.is_valid)
      .map(([_, value]) => value);

    if (contractInputs.length === 0) {
      alert('Không có chỉ số nào thay đổi cho hợp đồng này!');
      return;
    }

    const invalidInputs = contractInputs.filter((input) => !input.is_valid);
    if (invalidInputs.length > 0) {
      alert('Vẫn còn chỉ số không hợp lệ! Vui lòng kiểm tra lại.');
      return;
    }

    const readings: BulkMeterReadingData[] = contractInputs.map((input) => ({
      contract_id: input.contract_id,
      service_id: input.service_id,
      meter_type: input.meter_type,
      reading_date: readingDate,
      previous_reading: input.previous_reading,
      current_reading: input.current_reading,
    }));

    bulkCreateMutation.mutate(readings, {
      onSuccess: () => {
        // Reset has_changes flag for this contract only
        setMeterInputs((prev) => {
          const updated = { ...prev };
          Object.keys(updated).forEach((key) => {
            if (key.startsWith(contractId)) {
              updated[key] = {
                ...updated[key],
                previous_reading: updated[key].current_reading,
                has_changes: false,
              };
            }
          });
          return updated;
        });
      },
    });
  };

  const handleSaveAll = () => {
    const changedInputs = Object.values(meterInputs).filter((input) => input.has_changes && input.is_valid);

    if (changedInputs.length === 0) {
      alert('Không có chỉ số nào thay đổi!');
      return;
    }

    const invalidInputs = changedInputs.filter((input) => !input.is_valid);
    if (invalidInputs.length > 0) {
      alert('Vẫn còn chỉ số không hợp lệ! Vui lòng kiểm tra lại.');
      return;
    }

    const readings: BulkMeterReadingData[] = changedInputs.map((input) => ({
      contract_id: input.contract_id,
      service_id: input.service_id,
      meter_type: input.meter_type,
      reading_date: readingDate,
      previous_reading: input.previous_reading,
      current_reading: input.current_reading,
    }));

    bulkCreateMutation.mutate(readings, {
      onSuccess: () => {
        // Reset has_changes flag
        setMeterInputs((prev) => {
          const updated = { ...prev };
          Object.keys(updated).forEach((key) => {
            updated[key] = {
              ...updated[key],
              previous_reading: updated[key].current_reading,
              has_changes: false,
            };
          });
          return updated;
        });
      },
    });
  };

  const getContractMeterInputs = (contractId: string) => {
    return Object.entries(meterInputs)
      .filter(([key]) => key.startsWith(contractId))
      .map(([key, value]) => ({ key, ...value }));
  };

  const changedCount = Object.values(meterInputs).filter((input) => input.has_changes && input.is_valid).length;
  const invalidCount = Object.values(meterInputs).filter((input) => !input.is_valid && input.has_changes).length;

  return (
    <MainLayout
      title="Ghi chỉ số công tơ"
      subtitle="Ghi chỉ số điện nước hàng tháng"
      icon={Gauge}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1">
          <Label htmlFor="reading_date">Ngày ghi chỉ số</Label>
          <Input
            id="reading_date"
            type="date"
            value={readingDate}
            onChange={(e) => setReadingDate(e.target.value)}
            className="max-w-xs"
          />
        </div>

        <div className="flex items-end gap-2">
          {changedCount > 0 && (
            <Alert className="py-2 px-4">
              <AlertDescription className="text-sm">
                <CheckCircle2 className="h-4 w-4 inline mr-2 text-green-600" />
                {changedCount} chỉ số đã thay đổi
                {invalidCount > 0 && (
                  <span className="text-red-600 ml-2">
                    <AlertCircle className="h-4 w-4 inline mr-1" />
                    {invalidCount} không hợp lệ
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleSaveAll}
            disabled={changedCount === 0 || invalidCount > 0 || bulkCreateMutation.isPending}
            size="lg"
          >
            <Save className="h-4 w-4 mr-2" />
            {bulkCreateMutation.isPending ? 'Đang lưu...' : `Lưu tất cả (${changedCount})`}
          </Button>
        </div>
      </div>

      {/* Contracts Grid */}
      {contractsLoading ? (
        <div className="text-center py-12 text-gray-500">
          Đang tải dữ liệu...
        </div>
      ) : !activeContractsWithMeters || activeContractsWithMeters.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="Chưa có hợp đồng nào cần ghi chỉ số"
          description="Không có hợp đồng nào đang hoạt động với dịch vụ tính theo công tơ (điện, nước)"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {activeContractsWithMeters.map((contract) => {
            const meterInputsForContract = getContractMeterInputs(contract.id);

            if (meterInputsForContract.length === 0) return null;

            const contractHasChanges = meterInputsForContract.some((m) => m.has_changes && m.is_valid);
            const contractHasInvalid = meterInputsForContract.some((m) => !m.is_valid && m.has_changes);

            return (
              <Card key={contract.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {contract.contract_number || contract.id.slice(0, 8)}
                      </CardTitle>
                      <CardDescription>
                        <div className="mt-1">
                          <strong>{contract.tenant?.full_name}</strong>
                        </div>
                        <div className="text-sm">
                          {contract.room?.name || contract.bed?.name}
                        </div>
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedContractId(contract.id);
                          setHistoryDialogOpen(true);
                        }}
                      >
                        <History className="h-4 w-4 mr-2" />
                        Lịch sử
                      </Button>
                      <Button
                        variant={contractHasChanges ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => handleSaveContract(contract.id)}
                        disabled={!contractHasChanges || contractHasInvalid || bulkCreateMutation.isPending}
                      >
                        <Save className="h-4 w-4 mr-2" />
                        Lưu
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {meterInputsForContract.map(({ key, meter_type, previous_reading, current_reading, has_changes, is_valid }) => {
                    const consumption = current_reading - previous_reading;
                    const isElectric = meter_type === 'ELECTRIC';

                    return (
                      <div
                        key={key}
                        className={`border rounded-lg p-4 ${
                          has_changes && !is_valid ? 'border-red-500 bg-red-50' : has_changes ? 'border-green-500 bg-green-50' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-3">
                          {isElectric ? (
                            <Zap className="h-5 w-5 text-yellow-600" />
                          ) : (
                            <Droplet className="h-5 w-5 text-blue-600" />
                          )}
                          <span className="font-medium">
                            {isElectric ? 'Điện (kWh)' : 'Nước (m³)'}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <Label className="text-xs text-gray-600">Chỉ số cũ</Label>
                            <div className="text-lg font-medium">{previous_reading.toFixed(2)}</div>
                          </div>

                          <div>
                            <Label className="text-xs text-gray-600">Chỉ số mới *</Label>
                            <Input
                              type="number"
                              step="0.01"
                              value={current_reading}
                              onChange={(e) => handleInputChange(key, parseFloat(e.target.value) || 0)}
                              className={`text-lg font-medium ${!is_valid ? 'border-red-500' : ''}`}
                            />
                          </div>

                          <div>
                            <Label className="text-xs text-gray-600">Tiêu thụ</Label>
                            <div className={`text-lg font-bold ${consumption > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                              {consumption.toFixed(2)}
                            </div>
                          </div>
                        </div>

                        {!is_valid && has_changes && (
                          <div className="mt-2 text-sm text-red-600 flex items-center gap-1">
                            <AlertCircle className="h-4 w-4" />
                            Chỉ số mới phải lớn hơn hoặc bằng chỉ số cũ
                          </div>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* History Dialog */}
      <MeterReadingHistoryDialog
        open={historyDialogOpen}
        onOpenChange={setHistoryDialogOpen}
        contractId={selectedContractId}
      />
    </MainLayout>
  );
};

export default MeterReadingsPage;
