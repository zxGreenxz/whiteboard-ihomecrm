import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, User, MapPin, Calendar, DollarSign, Clock, CheckCircle2, Star, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useIssue, useIssueComments, useUpdateIssue } from "@/hooks/useIssues";
import { AssignIssueDialog } from "@/components/issues/AssignIssueDialog";
import { IssueCommentForm } from "@/components/issues/IssueCommentForm";
import { IssueRatingDialog } from "@/components/issues/IssueRatingDialog";
import { format, formatDistanceStrict } from "date-fns";
import { vi } from "date-fns/locale";
import { formatCurrency } from "@/lib/utils";

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
  RESOLVED: { label: "Đã giải quyết", color: "bg-green-100 text-green-800" },
  CLOSED: { label: "Đã đóng", color: "bg-gray-100 text-gray-800" },
  CANCELLED: { label: "Đã hủy", color: "bg-red-100 text-red-800" },
};

const IssueDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);

  const { data: issue, isLoading } = useIssue(id || "");
  const { data: comments = [] } = useIssueComments(id);
  const updateIssue = useUpdateIssue();

  const handleStatusChange = async (newStatus: string) => {
    if (!id) return;
    try {
      await updateIssue.mutateAsync({
        id,
        status: newStatus,
        ...(newStatus === "RESOLVED" && { resolved_at: new Date().toISOString() }),
        ...(newStatus === "CLOSED" && { closed_at: new Date().toISOString() }),
      });
    } catch (error) {
      console.error("Failed to update status:", error);
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

  // Calculate resolution time
  let resolutionTime = null;
  if (issue.resolved_at) {
    const start = new Date(issue.created_at);
    const end = new Date(issue.resolved_at);
    resolutionTime = formatDistanceStrict(start, end, { locale: vi });
  }

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/issues")}>
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
            <CardHeader>
              <CardTitle>Mô tả sự cố</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap">{issue.description}</p>
            </CardContent>
          </Card>

          {/* Comments Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Bình luận & Cập nhật</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {comments.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  Chưa có bình luận nào
                </p>
              ) : (
                <div className="space-y-4">
                  {comments.map((comment) => (
                    <div key={comment.id} className="flex gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <User className="w-4 h-4" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm">
                            {comment.profile?.full_name || "Unknown"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(comment.created_at), "dd/MM HH:mm", { locale: vi })}
                          </span>
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{comment.comment}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Separator />

              {/* Comment Form */}
              <IssueCommentForm
                issueId={id || ""}
                currentStatus={issue.status || undefined}
                canChangeStatus={true}
              />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Thao tác</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">Cập nhật trạng thái</label>
                <Select value={issue.status || ""} onValueChange={handleStatusChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NEW">Mới</SelectItem>
                    <SelectItem value="ASSIGNED">Đã phân công</SelectItem>
                    <SelectItem value="IN_PROGRESS">Đang xử lý</SelectItem>
                    <SelectItem value="RESOLVED">Đã giải quyết</SelectItem>
                    <SelectItem value="CLOSED">Đã đóng</SelectItem>
                    <SelectItem value="CANCELLED">Hủy</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button
                className="w-full"
                variant="outline"
                onClick={() => setAssignDialogOpen(true)}
              >
                {issue.assigned_to ? "Phân công lại" : "Phân công"}
              </Button>

              {issue.status === "RESOLVED" && (
                <Button
                  className="w-full"
                  variant={issue.rating ? "outline" : "default"}
                  onClick={() => setRatingDialogOpen(true)}
                >
                  <Star className="w-4 h-4 mr-2" />
                  {issue.rating ? "Chỉnh sửa đánh giá" : "Đánh giá & Đóng"}
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle>Chi tiết</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {issue.category && (
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-muted-foreground">Danh mục</div>
                    <div className="text-sm font-medium">{issue.category.name}</div>
                  </div>
                </div>
              )}

              {(issue.building || issue.room) && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-5 h-5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-xs text-muted-foreground">Vị trí</div>
                    <div className="text-sm font-medium">
                      {issue.building?.name}
                      {issue.room && ` - ${issue.room.name}`}
                    </div>
                  </div>
                </div>
              )}

              {issue.assigned_profile && (
                <div className="flex items-start gap-2">
                  <User className="w-5 h-5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-xs text-muted-foreground">Phân công cho</div>
                    <div className="text-sm font-medium">
                      {issue.assigned_profile.full_name || "Chưa rõ"}
                    </div>
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

              {(issue.estimated_cost || issue.actual_cost) && (
                <div className="flex items-start gap-2">
                  <DollarSign className="w-5 h-5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-xs text-muted-foreground">Chi phí</div>
                    {issue.estimated_cost && (
                      <div className="text-sm">
                        Dự kiến: {formatCurrency(issue.estimated_cost)}
                      </div>
                    )}
                    {issue.actual_cost && (
                      <div className="text-sm font-medium">
                        Thực tế: {formatCurrency(issue.actual_cost)}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {issue.resolved_at && (
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                  <div className="flex-1">
                    <div className="text-xs text-muted-foreground">Đã giải quyết</div>
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
                        <Star
                          key={i}
                          className={`w-4 h-4 ${
                            i < (issue.rating || 0)
                              ? "fill-yellow-400 text-yellow-400"
                              : "text-gray-300"
                          }`}
                        />
                      ))}
                    </div>
                    {issue.feedback && (
                      <div className="text-sm mt-1 text-muted-foreground italic">
                        "{issue.feedback}"
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Dialogs */}
      <AssignIssueDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        issueId={id || ""}
      />

      <IssueRatingDialog
        open={ratingDialogOpen}
        onOpenChange={setRatingDialogOpen}
        issueId={id || ""}
        currentRating={issue.rating}
        currentFeedback={issue.feedback}
      />
      </div>
    </MainLayout>
  );
};

export default IssueDetailPage;
