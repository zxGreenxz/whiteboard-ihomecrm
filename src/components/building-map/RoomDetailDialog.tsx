import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useNavigate } from "react-router-dom";
import { useRoom } from "@/hooks/useRooms";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Home,
  DollarSign,
  User,
  Calendar,
  FileText,
  AlertCircle,
  Building2,
  Maximize2
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface RoomDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string | null;
}

export function RoomDetailDialog({ open, onOpenChange, roomId }: RoomDetailDialogProps) {
  const navigate = useNavigate();
  const { data: room, isLoading: roomLoading } = useRoom(roomId || "");

  // Get active contract for this room
  const { data: activeContract } = useQuery({
    queryKey: ["room-active-contract", roomId],
    queryFn: async () => {
      if (!roomId) return null;

      const { data } = await supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          start_date,
          end_date,
          rent_amount,
          status,
          tenant:tenants(
            id,
            full_name,
            phone,
            email
          )
        `)
        .eq("room_id", roomId)
        .eq("status", "ACTIVE")
        .single();

      return data;
    },
    enabled: !!roomId && open,
  });

  // Get latest invoice for this contract
  const { data: latestInvoice } = useQuery({
    queryKey: ["room-latest-invoice", activeContract?.id],
    queryFn: async () => {
      if (!activeContract?.id) return null;

      const { data } = await supabase
        .from("invoices")
        .select("id, title, total_amount, paid_amount, due_date, status")
        .eq("contract_id", activeContract.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      return data;
    },
    enabled: !!activeContract?.id && open,
  });

  if (!roomId) return null;

  const handleCreateContract = () => {
    onOpenChange(false);
    navigate(`/contracts/create?room_id=${roomId}`);
  };

  const handleReportIssue = () => {
    onOpenChange(false);
    navigate(`/issues/create?room_id=${roomId}`);
  };

  const handleViewContract = () => {
    if (activeContract?.id) {
      onOpenChange(false);
      navigate(`/contracts/${activeContract.id}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {roomLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : room ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl flex items-center gap-2">
                <Home className="w-6 h-6" />
                {room.name}
              </DialogTitle>
              <DialogDescription>
                Chi tiết phòng và hợp đồng hiện tại
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-6">
              {/* Room Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Tòa nhà</p>
                    <p className="font-medium">{room.building?.name || "N/A"}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Maximize2 className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Diện tích</p>
                    <p className="font-medium">{room.area_sqm}m²</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Giá thuê</p>
                    <p className="font-medium">{formatCurrency(room.rent_price)}/tháng</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Home className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Trạng thái</p>
                    <Badge>{room.status}</Badge>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Current Contract */}
              {activeContract ? (
                <div className="space-y-4">
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    <FileText className="w-5 h-5" />
                    Hợp đồng hiện tại
                  </h3>

                  <div className="bg-muted/50 p-4 rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Số hợp đồng:</span>
                      <span className="font-medium">{activeContract.contract_number}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Khách thuê:</span>
                      <span className="font-medium">{activeContract.tenant?.full_name}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Thời hạn:</span>
                      <span className="font-medium">
                        {formatDate(activeContract.start_date)} - {formatDate(activeContract.end_date)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Giá thuê:</span>
                      <span className="font-medium">{formatCurrency(activeContract.rent_amount)}</span>
                    </div>
                  </div>

                  <Button variant="outline" className="w-full" onClick={handleViewContract}>
                    Xem chi tiết hợp đồng
                  </Button>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>Phòng chưa có hợp đồng</p>
                </div>
              )}

              {/* Latest Invoice */}
              {latestInvoice && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <DollarSign className="w-5 h-5" />
                      Hóa đơn gần nhất
                    </h3>

                    <div className="bg-muted/50 p-4 rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{latestInvoice.title}</span>
                        <Badge variant={latestInvoice.status === "PAID" ? "default" : "destructive"}>
                          {latestInvoice.status}
                        </Badge>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Tổng tiền:</span>
                        <span className="font-medium">{formatCurrency(latestInvoice.total_amount)}</span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Đã thanh toán:</span>
                        <span className="font-medium">{formatCurrency(latestInvoice.paid_amount || 0)}</span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Hạn thanh toán:</span>
                        <span className="font-medium">{formatDate(latestInvoice.due_date)}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              <Separator />

              {/* Actions */}
              <div className="grid grid-cols-2 gap-3">
                {!activeContract && (
                  <Button onClick={handleCreateContract} className="w-full">
                    <FileText className="w-4 h-4 mr-2" />
                    Tạo hợp đồng
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleReportIssue}
                  className={activeContract ? "col-span-2" : ""}
                >
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Báo cáo sự cố
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-muted-foreground">Không tìm thấy thông tin phòng</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
