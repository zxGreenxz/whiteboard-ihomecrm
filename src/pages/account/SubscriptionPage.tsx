import { CreditCard, Crown, Building2, Home, Calendar, Check, Loader2 } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  useSubscriptionPlans,
  useUserSubscription,
  useCreateUserSubscription,
  type SubscriptionPlan,
} from "@/hooks/useSubscription";

function formatPrice(price: number) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(price);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function SubscriptionPage() {
  const { data: plans, isLoading: plansLoading } = useSubscriptionPlans();
  const { data: currentSub, isLoading: subLoading } = useUserSubscription();
  const createSubscription = useCreateUserSubscription();

  const isLoading = plansLoading || subLoading;
  // Trước 11/08/2026 chỗ này viết
  //   `currentSub?.plan as typeof plans extends (infer T)[] ? T : never`
  // để suy kiểu phần tử của `plans`. Biểu thức đó HỎNG: `typeof plans` là
  // `SubscriptionPlan[] | undefined` (React Query), mà `… | undefined` không
  // extends `(infer T)[]`, nên nhánh sai được chọn và `currentPlan` thành
  // `never`. Dưới cờ hiện tại `undefined` bị lược nên nó tình cờ chạy đúng; bật
  // `strictNullChecks` là tám thuộc tính đọc trên nó cùng báo lỗi một lượt.
  const currentPlan = currentSub?.plan as SubscriptionPlan | undefined;
  const isExpired = currentSub ? new Date(currentSub.end_date) < new Date() : false;

  const handleSubscribe = (planId: string, durationMonths: number) => {
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + durationMonths);

    createSubscription.mutate({
      plan_id: planId,
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      status: "active",
    });
  };

  if (isLoading) {
    return (
      <MainLayout title="Gói cước" subtitle="Quản lý gói cước đăng ký" icon={CreditCard}>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout title="Gói cước" subtitle="Quản lý gói cước đăng ký" icon={CreditCard}>
      <div className="space-y-6 max-w-5xl">
        {/* Current Subscription */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-yellow-500" />
              Gói cước hiện tại
            </CardTitle>
          </CardHeader>
          <CardContent>
            {currentSub && currentPlan ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-lg font-semibold">{currentPlan.name}</p>
                  {currentPlan.description && (
                    <p className="text-sm text-muted-foreground">{currentPlan.description}</p>
                  )}
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      Hạn sử dụng: {formatDate(currentSub.end_date)}
                    </span>
                    {currentPlan.max_buildings != null && (
                      <span className="flex items-center gap-1">
                        <Building2 className="h-4 w-4" />
                        {currentPlan.max_buildings} toà nhà
                      </span>
                    )}
                    {currentPlan.max_rooms != null && (
                      <span className="flex items-center gap-1">
                        <Home className="h-4 w-4" />
                        {currentPlan.max_rooms} căn hộ
                      </span>
                    )}
                  </div>
                </div>
                <Badge variant={isExpired ? "destructive" : "default"}>
                  {isExpired ? "Đã hết hạn" : "Đang hoạt động"}
                </Badge>
              </div>
            ) : (
              <p className="text-muted-foreground">Bạn chưa đăng ký gói cước nào.</p>
            )}
          </CardContent>
        </Card>

        <Separator />

        {/* Available Plans */}
        <div>
          <h2 className="text-lg font-semibold mb-4">Các gói cước</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(plans || []).map((plan) => {
              const isCurrent = currentPlan?.id === plan.id;
              const features = Array.isArray(plan.features) ? (plan.features as string[]) : [];

              return (
                <Card key={plan.id} className={isCurrent ? "border-primary ring-1 ring-primary" : ""}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{plan.name}</CardTitle>
                      {isCurrent && <Badge variant="secondary">Đang dùng</Badge>}
                    </div>
                    {plan.description && (
                      <CardDescription>{plan.description}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <span className="text-2xl font-bold">{formatPrice(plan.price)}</span>
                      <span className="text-sm text-muted-foreground">
                        /{plan.duration_months} tháng
                      </span>
                    </div>

                    <div className="space-y-2 text-sm">
                      {plan.max_buildings != null && (
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span>Tối đa {plan.max_buildings} toà nhà</span>
                        </div>
                      )}
                      {plan.max_rooms != null && (
                        <div className="flex items-center gap-2">
                          <Home className="h-4 w-4 text-muted-foreground" />
                          <span>Tối đa {plan.max_rooms} căn hộ</span>
                        </div>
                      )}
                    </div>

                    {features.length > 0 && (
                      <ul className="space-y-1 text-sm">
                        {features.map((f, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <Check className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <Button
                      className="w-full"
                      variant={isCurrent ? "outline" : "default"}
                      disabled={isCurrent || createSubscription.isPending}
                      onClick={() => handleSubscribe(plan.id, plan.duration_months)}
                    >
                      {createSubscription.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : null}
                      {isCurrent ? "Gói hiện tại" : "Đăng ký"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {(!plans || plans.length === 0) && (
            <p className="text-center text-muted-foreground py-8">
              Chưa có gói cước nào khả dụng.
            </p>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
