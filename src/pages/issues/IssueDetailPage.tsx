import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, User, MapPin, Calendar, DollarSign,
  CheckCircle2, Star, Timer, ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useIssue, useIssueComments, useUpdateIssue } from "@/hooks/useIssues";
import { useTaskTypes } from "@/hooks/useTaskTypes";
import { AssignIssueDialog } from "@/components/issues/AssignIssueDialog";
import { IssueCommentForm } from "@/components/issues/IssueCommentForm";
import { IssueRatingDialog } from "@/components/issues/IssueRatingDialog";
import { format, formatDistanceStrict } from "date-fns";
import { vi } from "date-fns/locale";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

type IssueStatus = "NEW" | "ASSIGNED" | "IN_PROGRESS" | "RESOLVED" | "CLOSED" | "CANCELLED";

const PRIORITY_CONFIG = {
  LOW: { label: "Thấp", color: "bg-gray-100 text-gray-800" },
  MEDIUM: { label: "Trung bình", color: "bg-blue-100 text-blue-800" },
  HIGH: { label: "Cao", color: "bg-orange-100 text-orange-800" },
  URGENT: { label: "Khẩn cấp", color: "bg-red-100 text-red-800" },
};

const STATUS_CONFIG = {
  NEW: { label: "Mới", color: "bg-blue-100 text-blue-800" },
  ASSIGNED: { label: "Đã phân công", color: "bg-purple-100 text-purple-800" },
  IN_PROGRESS: { label: "Đang xử lý", color: "bg-yellow-100 text-yellow-800" },
  RESOLVED: { label: "Hoàn thành", color: "bg-green-100 text-green-800" },
  CLOSED: { label: "Đã đóng", color: "bg-gray-100 text-gray-800" },
  CANCELLED: { label: "Đã hủy", color: "bg-red-100 text-red-800" },
};

const IssueDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);
  const [actualCostInput, setActualCostInput] = useState("");
  const [showCostForm, setShowCostForm] = useState(false);

  const { data: issue, isLoading } = useIssue(id || "");
  const { data: comments = [] } = useIssueComments(id);
  const { data: taskTypes = [] } = useTaskTypes();
  const updateIssue = useUpdateIssue();

  const handleStatusChange = async (newStatus: string) => {
    if (!id) return;
    const typedStatus = newStatus as IssueStatus;
    try {
      await updateIssue.mutateAsync({
        id,
        status: typedStatus,
        ...(typedStatus === "RESOLVED" && { resolved_at: new Date().toISOString() }),
        ...(typedStatus === "CLOSED" && { closed_at: new Date().toISOString() }),
      });
    } catch (error) {
      console.error("Failed to update status:", error);
    }
  };

  const handleSaveCost = async () => {
    if (!id) return;
    const cost = parseFloat(actualCostInput);
    if (isNaN(cost) || cost < 0) {
      toast.error("Chi phí không hợp lệ");
      return;
    }
    try {
      await updateIssue.mutateAsync({ id, actual_cost: cost });
      setShowCostForm(false);
      setActualCostInput("");
    } catch (error) {
      console.error("Failed to update cost:", error);
    }
  };

  if (isLoading || !issue) {
    return (
      <MainLayout>
        <div className="p-6">
          <div className="flex items-center justify-center h-96">
            <p className="text-muted-foreground">Đang tải...</p>
          </div>
        </div>
      </MainLayout>
    );
  }

  const priorityConfig = PRIORITY_CONFIG[issue.priority as keyof typeof PRIORITY_CONFIG] || PRIORITY_CONFIG.MEDIUM;
  const statusConfig = STATUS_CONFIG[issue.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.NEW;
  const taskType = taskTypes.find((t) => t.id === issue.category_id);
  const issueImages: string[] = Array.isArray(issue.images) ? (issue.images as string[]) : [];

  let resolutionTime: string | null = null;
  if (issue.resolved_at) {
    resolutionTime = formatDistanceStrict(new Date(issue.created_at), new Date(issue.resolved_at), { locale: vi });
  }

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/tasks")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">{issue.title}</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Tạo ngày {format(new Date(issue.created_at), "dd/MM/yyyy HH:mm", { locale: vi })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={priorityConfig.color}>{priorityConfig.label}</Badge>
            <Badge className={statusConfig.color}>{statusConfig.label}</Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Description */}
            <Card>
              <CardHeader><CardTitle>Mô tả công việc</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p className="whitespace-pre-wrap">{issue.description}</p>
                {issueImages.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">Ảnh đính kèm</p>
                    <div className="flex flex-wrap gap-2">
                      {issueImages.map((url, index) => (
                        <a key={index} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt={`Ảnh ${index + 1}`}
                            className="w-24 h-24 object-cover rounded border hover:opacity-80 transition-opacity"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Cost Tracking */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="w-5 h-5" />
                    Chi phí phát sinh
                  </CardTitle>
                  {!showCostForm && (
                    <Button variant="outline" size="sm" onClick={() => {
                      setActualCostInput(issue.actual_cost?.toString() || "");
                      setShowCostForm(true);
                    }}>
                      {issue.actual_cost ? "Cập nhật chi phí" : "Ghi nhận chi phí"}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Chi phí dự kiến</p>
                    <p className="text-lg font-semibold">
                      {issue.estimated_cost ? formatCurrency(issue.estimated_cost) : "Chưa có"}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Chi phí thực tế</p>
                    <p className="text-lg font-semibold">
                      {issue.actual_cost ? formatCurrency(issue.actual_cost) : "Chưa có"}
                    </p>
                  </div>
                </div>
                {showCostForm && (
                  <div className="mt-4 flex gap-2 items-end">
                    <div className="flex-1">
                      <label className="text-sm font-medium">Chi phí thực tế (VNĐ)</label>
                      <Input type="number" value={actualCostInput}
                        onChange={(e) => setActualCostInput(e.target.value)}
                        placeholder="Nhập chi phí..."
                      />
                    </div>
                    <Button size="sm" onClick={handleSaveCost} disabled={updateIssue.isPending}>Lưu</Button>
                    <Button size="sm" variant="outline" onClick={() => setShowCostForm(false)}>Hủy</Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Progress Updates */}
            <Card>
              <CardHeader><CardTitle>Cập nhật tiến độ</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {comments.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">Chưa có cập nhật tiến độ nào</p>
                ) : (
                  <div className="space-y-4">
                    {comments.map((comment) => (
                      <div key={comment.id} className="flex gap-3">
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="w-4 h-4" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-sm">{comment.profile?.full_name || "Không rõ"}</span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(comment.created_at), "dd/MM HH:mm", { locale: vi })}
                            </span>
                          </div>
                          <p className="text-sm whitespace-pre-wrap">{comment.comment}</p>
                          {comment.images && Array.isArray(comment.images) && (comment.images as string[]).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {(comment.images as string[]).map((url, idx) => (
                                <a key={idx} href={url} target="_blank" rel="noopener noreferrer">
                                  <img src={url} alt={`Ảnh ${idx + 1}`}
                                    className="w-16 h-16 object-cover rounded border hover:opacity-80"
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <Separator />
                <IssueCommentForm issueId={id || ""} currentStatus={issue.status || undefined} canChangeStatus={true} />
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle>Thao tác</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Cập nhật trạng thái</label>
                  <Select value={issue.status || ""} onValueChange={handleStatusChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NEW">Mới</SelectItem>
                      <SelectItem value="ASSIGNED">Đã phân công</SelectItem>
                      <SelectItem value="IN_PROGRESS">Đang xử lý</SelectItem>
                      <SelectItem value="RESOLVED">Hoàn thành</SelectItem>
                      <SelectItem value="CLOSED">Đã đóng</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="w-full" variant="outline" onClick={() => setAssignDialogOpen(true)}>
                  {issue.assigned_to ? "Phân công lại" : "Phân công"}
                </Button>
                {issue.status === "RESOLVED" && (
                  <Button className="w-full" variant={issue.rating ? "outline" : "default"}
                    onClick={() => setRatingDialogOpen(true)}>
                    <Star className="w-4 h-4 mr-2" />
                    {issue.rating ? "Chỉnh sửa đánh giá" : "Đánh giá & Đóng"}
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Chi tiết</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {taskType ? (
                  <div className="flex items-start gap-2">
                    <ClipboardList className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Loại công việc</div>
                      <div className="flex items-center gap-2">
                        {taskType.color && <div className="w-3 h-3 rounded-full" style={{ backgroundColor: taskType.color }} />}
                        <span className="text-sm font-medium">{taskType.name}</span>
                      </div>
                    </div>
                  </div>
                ) : issue.category ? (
                  <div className="flex items-start gap-2">
                    <ClipboardList className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Loại công việc</div>
                      <div className="text-sm font-medium">{issue.category.name}</div>
                    </div>
                  </div>
                ) : null}

                {(issue.building || issue.room) && (
                  <div className="flex items-start gap-2">
                    <MapPin className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Vị trí</div>
                      <div className="text-sm font-medium">
                        {issue.building?.name}{issue.room && ` - ${issue.room.name}`}
                      </div>
                    </div>
                  </div>
                )}

                {issue.assigned_profile && (
                  <div className="flex items-start gap-2">
                    <User className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Người phụ trách</div>
                      <div className="text-sm font-medium">{issue.assigned_profile.full_name || "Chưa rõ"}</div>
                      {issue.assigned_at && (
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(issue.assigned_at), "dd/MM/yyyy", { locale: vi })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {issue.due_date && (
                  <div className="flex items-start gap-2">
                    <Calendar className="w-5 h-5 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Hạn hoàn thành</div>
                      <div className="text-sm font-medium">
                        {format(new Date(issue.due_date), "dd/MM/yyyy", { locale: vi })}
                      </div>
                    </div>
                  </div>
                )}

                {issue.resolved_at && (
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Hoàn thành lúc</div>
                      <div className="text-sm font-medium">
                        {format(new Date(issue.resolved_at), "dd/MM/yyyy HH:mm", { locale: vi })}
                      </div>
                    </div>
                  </div>
                )}

                {resolutionTime && (
                  <div className="flex items-start gap-2">
                    <Timer className="w-5 h-5 text-blue-600" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Thời gian xử lý</div>
                      <div className="text-sm font-medium">{resolutionTime}</div>
                    </div>
                  </div>
                )}

                {issue.rating && (
                  <div className="flex items-start gap-2">
                    <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
                    <div className="flex-1">
                      <div className="text-xs text-muted-foreground">Đánh giá</div>
                      <div className="flex items-center gap-1">
                        {[...Array(5)].map((_, i) => (
                          <Star key={i} className={`w-4 h-4 ${
                            i < (issue.rating || 0) ? "fill-yellow-400 text-yellow-400" : "text-gray-300"
                          }`} />
                        ))}
                      </div>
                      {issue.feedback && (
                        <div className="text-sm mt-1 text-muted-foreground italic">"{issue.feedback}"</div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <AssignIssueDialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen} issueId={id || ""} />
        <IssueRatingDialog open={ratingDialogOpen} onOpenChange={setRatingDialogOpen}
          issueId={id || ""} currentRating={issue.rating} currentFeedback={issue.feedback} />
      </div>
    </MainLayout>
  );
};

export default IssueDetailPage;
