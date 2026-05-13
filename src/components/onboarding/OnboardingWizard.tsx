import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building2,
  Home,
  Wrench,
  FileText,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  SkipForward,
} from 'lucide-react';
import { useCreateBuilding } from '@/hooks/useBuildings';
import { useCreateRoom } from '@/hooks/useRooms';
import { useCreateService } from '@/hooks/useServices';
import { useIndividualSetting, useUpdateIndividualSetting } from '@/hooks/useSettings';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';

const ONBOARDING_KEY = 'onboarding_completed';

const STEPS = [
  { id: 'welcome', title: 'Chào mừng', icon: Sparkles },
  { id: 'building', title: 'Tạo toà nhà', icon: Building2 },
  { id: 'apartment', title: 'Thêm căn hộ', icon: Home },
  { id: 'service', title: 'Thêm dịch vụ', icon: Wrench },
  { id: 'complete', title: 'Hoàn thành', icon: CheckCircle2 },
] as const;

export function useOnboardingState() {
  const { data: completed, isLoading } = useIndividualSetting(ONBOARDING_KEY, false);
  const updateSetting = useUpdateIndividualSetting(ONBOARDING_KEY);

  return {
    isCompleted: completed === true,
    isLoading,
    markCompleted: () => updateSetting.mutate(true),
  };
}

export default function OnboardingWizard() {
  const [open, setOpen] = useState(true);
  const [currentStep, setCurrentStep] = useState(0);
  const { markCompleted } = useOnboardingState();

  // Form states
  const [buildingName, setBuildingName] = useState('');
  const [buildingAddress, setBuildingAddress] = useState('');
  const [createdBuildingId, setCreatedBuildingId] = useState<string | null>(null);

  const [apartmentName, setApartmentName] = useState('');
  const [apartmentPrice, setApartmentPrice] = useState('');

  const [serviceName, setServiceName] = useState('');
  const [servicePrice, setServicePrice] = useState('');
  const [serviceType, setServiceType] = useState<string>('FIXED');

  // Mutations
  const createBuilding = useCreateBuilding();
  const createRoom = useCreateRoom();
  const createService = useCreateService();

  const progress = ((currentStep) / (STEPS.length - 1)) * 100;

  const handleSkip = () => {
    markCompleted();
    setOpen(false);
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleCreateBuilding = async () => {
    if (!buildingName.trim()) {
      toast.error('Vui lòng nhập tên toà nhà');
      return;
    }
    try {
      const result = await createBuilding.mutateAsync({
        name: buildingName.trim(),
        street_address: buildingAddress.trim() || undefined,
        code: buildingName.trim().substring(0, 10).toUpperCase().replace(/\s/g, ''),
        district: '',
        province: '',
        ward: '',
      });
      setCreatedBuildingId(result.id);
      handleNext();
    } catch {
      // Error handled by hook
    }
  };

  const handleCreateApartment = async () => {
    if (!apartmentName.trim()) {
      toast.error('Vui lòng nhập tên căn hộ');
      return;
    }
    if (!createdBuildingId) {
      toast.error('Vui lòng tạo toà nhà trước');
      return;
    }
    try {
      await createRoom.mutateAsync({
        name: apartmentName.trim(),
        building_id: createdBuildingId,
        rent_price: apartmentPrice ? parseFloat(apartmentPrice) : 0,
        deposit_amount: 0,
      });
      handleNext();
    } catch {
      // Error handled by hook
    }
  };

  const handleCreateService = async () => {
    if (!serviceName.trim()) {
      toast.error('Vui lòng nhập tên dịch vụ');
      return;
    }
    try {
      await createService.mutateAsync({
        name: serviceName.trim(),
        unit_price: servicePrice ? parseFloat(servicePrice) : 0,
        type: serviceType as any,
      });
      handleNext();
    } catch {
      // Error handled by hook
    }
  };

  const handleFinish = () => {
    markCompleted();
    setOpen(false);
  };

  const renderStepContent = () => {
    switch (STEPS[currentStep].id) {
      case 'welcome':
        return <WelcomeStep />;
      case 'building':
        return (
          <BuildingStep
            name={buildingName}
            address={buildingAddress}
            onNameChange={setBuildingName}
            onAddressChange={setBuildingAddress}
          />
        );
      case 'apartment':
        return (
          <ApartmentStep
            name={apartmentName}
            price={apartmentPrice}
            onNameChange={setApartmentName}
            onPriceChange={setApartmentPrice}
          />
        );
      case 'service':
        return (
          <ServiceStep
            name={serviceName}
            price={servicePrice}
            type={serviceType}
            onNameChange={setServiceName}
            onPriceChange={setServicePrice}
            onTypeChange={setServiceType}
          />
        );
      case 'complete':
        return <CompleteStep />;
      default:
        return null;
    }
  };

  const renderActions = () => {
    const step = STEPS[currentStep].id;

    if (step === 'welcome') {
      return (
        <div className="flex justify-between">
          <Button variant="ghost" onClick={handleSkip}>
            <SkipForward className="h-4 w-4 mr-2" />
            Bỏ qua
          </Button>
          <Button onClick={handleNext}>
            Bắt đầu
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      );
    }

    if (step === 'complete') {
      return (
        <div className="flex justify-center">
          <Button onClick={handleFinish} size="lg">
            <CheckCircle2 className="h-4 w-4 mr-2" />
            Hoàn thành
          </Button>
        </div>
      );
    }

    const actionMap: Record<string, { handler: () => void; loading: boolean }> = {
      building: { handler: handleCreateBuilding, loading: createBuilding.isPending },
      apartment: { handler: handleCreateApartment, loading: createRoom.isPending },
      service: { handler: handleCreateService, loading: createService.isPending },
    };

    const action = actionMap[step];

    return (
      <div className="flex justify-between">
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Quay lại
          </Button>
          <Button variant="ghost" onClick={handleSkip}>
            <SkipForward className="h-4 w-4 mr-2" />
            Bỏ qua
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={handleNext}>
            Bước tiếp
          </Button>
          <Button onClick={action?.handler} disabled={action?.loading}>
            {action?.loading ? 'Đang tạo...' : 'Tạo & Tiếp tục'}
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleSkip(); }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {(() => {
              const StepIcon = STEPS[currentStep].icon;
              return <StepIcon className="h-5 w-5 text-primary" />;
            })()}
            {STEPS[currentStep].title}
          </DialogTitle>
          <DialogDescription>
            Bước {currentStep + 1} / {STEPS.length}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicators */}
        <div className="space-y-3">
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between">
            {STEPS.map((step, idx) => {
              const Icon = step.icon;
              const isActive = idx === currentStep;
              const isDone = idx < currentStep;
              return (
                <div
                  key={step.id}
                  className={`flex flex-col items-center gap-1 text-xs ${
                    isActive ? 'text-primary font-medium' : isDone ? 'text-emerald-600' : 'text-muted-foreground'
                  }`}
                >
                  <div
                    className={`h-8 w-8 rounded-full flex items-center justify-center ${
                      isActive
                        ? 'bg-primary text-white'
                        : isDone
                        ? 'bg-emerald-100 text-emerald-600'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isDone ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  <span className="hidden sm:block">{step.title}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step content */}
        <div className="py-4 min-h-[200px]">{renderStepContent()}</div>

        {/* Actions */}
        {renderActions()}
      </DialogContent>
    </Dialog>
  );
}

// =============================================
// Step Components
// =============================================

function WelcomeStep() {
  return (
    <div className="text-center space-y-4">
      <div className="mx-auto h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
        <Sparkles className="h-8 w-8 text-primary" />
      </div>
      <h3 className="text-lg font-semibold">Chào mừng bạn đến với CRM!</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Hãy cùng thiết lập hệ thống quản lý bất động sản của bạn. Chúng tôi sẽ hướng dẫn bạn qua
        các bước cơ bản để bắt đầu sử dụng.
      </p>
      <div className="grid grid-cols-2 gap-3 pt-2">
        {[
          { icon: Building2, label: 'Tạo toà nhà' },
          { icon: Home, label: 'Thêm căn hộ' },
          { icon: Wrench, label: 'Thêm dịch vụ' },
          { icon: FileText, label: 'Tạo hợp đồng' },
        ].map((item) => (
          <Card key={item.label} className="border-dashed">
            <CardContent className="flex items-center gap-2 p-3">
              <item.icon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{item.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function BuildingStep({
  name,
  address,
  onNameChange,
  onAddressChange,
}: {
  name: string;
  address: string;
  onNameChange: (v: string) => void;
  onAddressChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bắt đầu bằng việc tạo toà nhà đầu tiên. Bạn có thể thêm nhiều toà nhà sau.
      </p>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="building-name">
            Tên toà nhà <span className="text-red-500">*</span>
          </Label>
          <Input
            id="building-name"
            placeholder="VD: Toà nhà A, Chung cư Sunrise..."
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="building-address">Địa chỉ</Label>
          <Input
            id="building-address"
            placeholder="VD: 123 Nguyễn Văn Linh, Quận 7, TP.HCM"
            value={address}
            onChange={(e) => onAddressChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function ApartmentStep({
  name,
  price,
  onNameChange,
  onPriceChange,
}: {
  name: string;
  price: string;
  onNameChange: (v: string) => void;
  onPriceChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Thêm căn hộ đầu tiên vào toà nhà vừa tạo. Bạn có thể thêm nhiều căn hộ sau.
      </p>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="apartment-name">
            Tên căn hộ <span className="text-red-500">*</span>
          </Label>
          <Input
            id="apartment-name"
            placeholder="VD: Căn hộ 101, Căn A1..."
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="apartment-price">Giá thuê (VNĐ/tháng)</Label>
          <CurrencyInput
            value={price ? Number(price) : 0}
            onChange={(v) => onPriceChange(v ? String(v) : '')}
          />
        </div>
      </div>
    </div>
  );
}

function ServiceStep({
  name,
  price,
  type,
  onNameChange,
  onPriceChange,
  onTypeChange,
}: {
  name: string;
  price: string;
  type: string;
  onNameChange: (v: string) => void;
  onPriceChange: (v: string) => void;
  onTypeChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Thêm dịch vụ đầu tiên (điện, nước, internet...). Bạn có thể thêm nhiều dịch vụ sau.
      </p>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="service-name">
            Tên dịch vụ <span className="text-red-500">*</span>
          </Label>
          <Input
            id="service-name"
            placeholder="VD: Tiền điện, Tiền nước, Internet..."
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="service-price">Đơn giá</Label>
          <CurrencyInput
            value={price ? Number(price) : 0}
            onChange={(v) => onPriceChange(v ? String(v) : '')}
          />
        </div>
        <div className="space-y-2">
          <Label>Loại tính phí</Label>
          <Select value={type} onValueChange={onTypeChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="FIXED">Cố định</SelectItem>
              <SelectItem value="METERED">Theo chỉ số</SelectItem>
              <SelectItem value="PER_PERSON">Theo người</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function CompleteStep() {
  return (
    <div className="text-center space-y-4">
      <div className="mx-auto h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center">
        <CheckCircle2 className="h-8 w-8 text-emerald-600" />
      </div>
      <h3 className="text-lg font-semibold">Thiết lập hoàn tất!</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Bạn đã hoàn thành các bước cơ bản. Tiếp theo, bạn có thể tạo hợp đồng cho khách hàng.
      </p>
      <div className="flex justify-center pt-2">
        <Button variant="outline" asChild>
          <Link to="/contracts">
            <FileText className="h-4 w-4 mr-2" />
            Đi đến trang Hợp đồng
          </Link>
        </Button>
      </div>
    </div>
  );
}
