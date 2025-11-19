import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { History, Zap, Droplet, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import { useMeterReadings } from '@/hooks/useInvoices';
import { useContract } from '@/hooks/useContracts';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface MeterReadingHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string | null;
}

const MeterReadingHistoryDialog = ({
  open,
  onOpenChange,
  contractId,
}: MeterReadingHistoryDialogProps) => {
  const { data: contract } = useContract(contractId || '');
  const { data: meterReadings } = useMeterReadings(contractId || '');

  if (!contractId || !contract) return null;

  // Group readings by meter type
  const electricReadings = meterReadings?.filter((r) => r.meter_type === 'ELECTRIC') || [];
  const waterReadings = meterReadings?.filter((r) => r.meter_type === 'WATER') || [];

  // Calculate statistics
  const calculateStats = (readings: typeof meterReadings) => {
    if (!readings || readings.length === 0) return { avgConsumption: 0, totalConsumption: 0, trend: 0 };

    const consumptions = readings.map((r) => r.current_reading - r.previous_reading);
    const totalConsumption = consumptions.reduce((sum, c) => sum + c, 0);
    const avgConsumption = totalConsumption / consumptions.length;

    // Calculate trend (compare last 2 readings)
    let trend = 0;
    if (consumptions.length >= 2) {
      const lastConsumption = consumptions[0];
      const prevConsumption = consumptions[1];
      trend = lastConsumption - prevConsumption;
    }

    return { avgConsumption, totalConsumption, trend };
  };

  const electricStats = calculateStats(electricReadings);
  const waterStats = calculateStats(waterReadings);

  // Prepare chart data (reverse to show oldest to newest)
  const prepareChartData = (readings: typeof meterReadings) => {
    if (!readings || readings.length === 0) return [];

    return [...readings]
      .reverse()
      .map((reading) => ({
        date: format(new Date(reading.reading_date), 'dd/MM', { locale: vi }),
        fullDate: format(new Date(reading.reading_date), 'dd/MM/yyyy', { locale: vi }),
        consumption: parseFloat((reading.current_reading - reading.previous_reading).toFixed(2)),
        current: reading.current_reading,
        previous: reading.previous_reading,
      }));
  };

  const electricChartData = prepareChartData(electricReadings);
  const waterChartData = prepareChartData(waterReadings);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Lịch sử ghi chỉ số
          </DialogTitle>
          <DialogDescription>
            Hợp đồng: {contract.contract_number || contract.id.slice(0, 8)} - {contract.tenant?.full_name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Electric Readings */}
          {electricReadings.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-yellow-600" />
                  <h3 className="text-lg font-semibold">Điện (kWh)</h3>
                </div>
                <div className="flex gap-4 text-sm">
                  <div className="text-right">
                    <div className="text-gray-600">Trung bình</div>
                    <div className="font-bold text-blue-600">{electricStats.avgConsumption.toFixed(2)} kWh</div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-600">Tổng tiêu thụ</div>
                    <div className="font-bold text-blue-600">{electricStats.totalConsumption.toFixed(2)} kWh</div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-600">Xu hướng</div>
                    <div className={`font-bold flex items-center gap-1 ${electricStats.trend > 0 ? 'text-red-600' : electricStats.trend < 0 ? 'text-green-600' : 'text-gray-600'}`}>
                      {electricStats.trend > 0 ? (
                        <><TrendingUp className="h-4 w-4" /> +{electricStats.trend.toFixed(2)}</>
                      ) : electricStats.trend < 0 ? (
                        <><TrendingDown className="h-4 w-4" /> {electricStats.trend.toFixed(2)}</>
                      ) : (
                        '0.00'
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <Tabs defaultValue="chart" className="w-full">
                <TabsList className="grid w-full grid-cols-2 max-w-md">
                  <TabsTrigger value="chart">
                    <BarChart3 className="h-4 w-4 mr-2" />
                    Biểu đồ
                  </TabsTrigger>
                  <TabsTrigger value="table">Bảng dữ liệu</TabsTrigger>
                </TabsList>

                <TabsContent value="chart" className="mt-4">
                  {electricChartData.length > 0 && (
                    <div className="border rounded-md p-4 bg-white">
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={electricChartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 12 }}
                          />
                          <YAxis
                            tick={{ fontSize: 12 }}
                            label={{ value: 'kWh', angle: -90, position: 'insideLeft' }}
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const data = payload[0].payload;
                                return (
                                  <div className="bg-white border rounded-md p-3 shadow-lg">
                                    <p className="font-medium">{data.fullDate}</p>
                                    <p className="text-sm text-yellow-600">
                                      Tiêu thụ: <strong>{data.consumption} kWh</strong>
                                    </p>
                                    <p className="text-xs text-gray-600">
                                      Cũ: {data.previous} → Mới: {data.current}
                                    </p>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          <Bar dataKey="consumption" fill="#ca8a04" name="Tiêu thụ (kWh)" />
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="mt-2 text-center text-sm text-gray-600">
                        Biểu đồ tiêu thụ điện theo thời gian
                      </div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="table" className="mt-4">
                  <div className="border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ngày ghi</TableHead>
                          <TableHead>Chỉ số cũ</TableHead>
                          <TableHead>Chỉ số mới</TableHead>
                          <TableHead>Tiêu thụ</TableHead>
                          <TableHead>Ghi chú</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {electricReadings.map((reading) => {
                          const consumption = reading.current_reading - reading.previous_reading;
                          return (
                            <TableRow key={reading.id}>
                              <TableCell>
                                {format(new Date(reading.reading_date), 'dd/MM/yyyy', { locale: vi })}
                              </TableCell>
                              <TableCell>{reading.previous_reading.toFixed(2)}</TableCell>
                              <TableCell className="font-medium">{reading.current_reading.toFixed(2)}</TableCell>
                              <TableCell>
                                <Badge variant={consumption > electricStats.avgConsumption ? 'destructive' : 'default'}>
                                  {consumption.toFixed(2)} kWh
                                </Badge>
                              </TableCell>
                              <TableCell className="text-sm text-gray-600">
                                {reading.notes || '-'}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}

          {/* Water Readings */}
          {waterReadings.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Droplet className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold">Nước (m³)</h3>
                </div>
                <div className="flex gap-4 text-sm">
                  <div className="text-right">
                    <div className="text-gray-600">Trung bình</div>
                    <div className="font-bold text-blue-600">{waterStats.avgConsumption.toFixed(2)} m³</div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-600">Tổng tiêu thụ</div>
                    <div className="font-bold text-blue-600">{waterStats.totalConsumption.toFixed(2)} m³</div>
                  </div>
                  <div className="text-right">
                    <div className="text-gray-600">Xu hướng</div>
                    <div className={`font-bold flex items-center gap-1 ${waterStats.trend > 0 ? 'text-red-600' : waterStats.trend < 0 ? 'text-green-600' : 'text-gray-600'}`}>
                      {waterStats.trend > 0 ? (
                        <><TrendingUp className="h-4 w-4" /> +{waterStats.trend.toFixed(2)}</>
                      ) : waterStats.trend < 0 ? (
                        <><TrendingDown className="h-4 w-4" /> {waterStats.trend.toFixed(2)}</>
                      ) : (
                        '0.00'
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <Tabs defaultValue="chart" className="w-full">
                <TabsList className="grid w-full grid-cols-2 max-w-md">
                  <TabsTrigger value="chart">
                    <BarChart3 className="h-4 w-4 mr-2" />
                    Biểu đồ
                  </TabsTrigger>
                  <TabsTrigger value="table">Bảng dữ liệu</TabsTrigger>
                </TabsList>

                <TabsContent value="chart" className="mt-4">
                  {waterChartData.length > 0 && (
                    <div className="border rounded-md p-4 bg-white">
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={waterChartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 12 }}
                          />
                          <YAxis
                            tick={{ fontSize: 12 }}
                            label={{ value: 'm³', angle: -90, position: 'insideLeft' }}
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const data = payload[0].payload;
                                return (
                                  <div className="bg-white border rounded-md p-3 shadow-lg">
                                    <p className="font-medium">{data.fullDate}</p>
                                    <p className="text-sm text-blue-600">
                                      Tiêu thụ: <strong>{data.consumption} m³</strong>
                                    </p>
                                    <p className="text-xs text-gray-600">
                                      Cũ: {data.previous} → Mới: {data.current}
                                    </p>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          <Bar dataKey="consumption" fill="#2563eb" name="Tiêu thụ (m³)" />
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="mt-2 text-center text-sm text-gray-600">
                        Biểu đồ tiêu thụ nước theo thời gian
                      </div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="table" className="mt-4">
                  <div className="border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ngày ghi</TableHead>
                          <TableHead>Chỉ số cũ</TableHead>
                          <TableHead>Chỉ số mới</TableHead>
                          <TableHead>Tiêu thụ</TableHead>
                          <TableHead>Ghi chú</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {waterReadings.map((reading) => {
                          const consumption = reading.current_reading - reading.previous_reading;
                          return (
                            <TableRow key={reading.id}>
                              <TableCell>
                                {format(new Date(reading.reading_date), 'dd/MM/yyyy', { locale: vi })}
                              </TableCell>
                              <TableCell>{reading.previous_reading.toFixed(2)}</TableCell>
                              <TableCell className="font-medium">{reading.current_reading.toFixed(2)}</TableCell>
                              <TableCell>
                                <Badge variant={consumption > waterStats.avgConsumption ? 'destructive' : 'default'}>
                                  {consumption.toFixed(2)} m³
                                </Badge>
                              </TableCell>
                              <TableCell className="text-sm text-gray-600">
                                {reading.notes || '-'}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}

          {electricReadings.length === 0 && waterReadings.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              Chưa có lịch sử ghi chỉ số cho hợp đồng này.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MeterReadingHistoryDialog;
