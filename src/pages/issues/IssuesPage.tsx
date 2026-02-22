import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Plus, Filter, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useIssues, type IssueWithRelations } from "@/hooks/useIssues";
import { useTaskTypes } from "@/hooks/useTaskTypes";
import { useBuildings } from "@/hooks/useBuildings";
import { CreateIssueDialog } from "@/components/issues/CreateIssueDialog";
import { IssueCard } from "@/components/issues/IssueCard";
import EmptyState from "@/components/ui/EmptyState";
import { useNavigate } from "react-router-dom";

const ISSUE_STATUSES = [
  { value: "NEW", label: "Mới", color: "bg-blue-100 text-blue-800", count: 0 },
  { value: "ASSIGNED", label: "Đã phân công", color: "bg-purple-100 text-purple-800", count: 0 },
  { value: "IN_PROGRESS", label: "Đang xử lý", color: "bg-yellow-100 text-yellow-800", count: 0 },
  { value: "RESOLVED", label: "Hoàn thành", color: "bg-green-100 text-green-800", count: 0 },
  { value: "CLOSED", label: "Đã đóng", color: "bg-gray-100 text-gray-800", count: 0 },
];

const PRIORITY_CONFIG = {
  LOW: { label: "Thấp", color: "bg-gray-100 text-gray-800" },
  MEDIUM: { label: "Trung bình", color: "bg-blue-100 text-blue-800" },
  HIGH: { label: "Cao", color: "bg-orange-100 text-orange-800" },
  URGENT: { label: "Khẩn cấp", color: "bg-red-100 text-red-800" },
};

const IssuesPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<string>("ALL");
  const [taskTypeFilter, setTaskTypeFilter] = useState<string>("ALL");
  const [buildingFilter, setBuildingFilter] = useState<string>("ALL");

  const navigate = useNavigate();

  const { data: issues = [], isLoading } = useIssues({
    priority: priorityFilter !== "ALL" ? priorityFilter : undefined,
    building_id: buildingFilter !== "ALL" ? buildingFilter : undefined,
  });

  const { data: taskTypes = [] } = useTaskTypes();
  const { data: buildings = [] } = useBuildings();

  // Filter by task type on client side (category_id maps to task_type)
  const filteredIssues = taskTypeFilter !== "ALL"
    ? issues.filter((issue) => issue.category_id === taskTypeFilter)
    : issues;

  // Group issues by status
  const groupedIssues = ISSUE_STATUSES.map((status) => ({
    ...status,
    issues: filteredIssues.filter((issue) => issue.status === status.value),
    count: filteredIssues.filter((issue) => issue.status === status.value).length,
  }));

  // Calculate summary stats
  const totalIssues = filteredIssues.length;
  const urgentIssues = filteredIssues.filter((i) => i.priority === "URGENT").length;
  const assignedIssues = filteredIssues.filter((i) => i.assigned_to).length;

  const handleIssueClick = (issueId: string) => {
    navigate(`/tasks/${issueId}`);
  };

  if (isLoading) {
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

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <ClipboardList className="w-8 h-8" />
              Quản lý Công việc
            </h1>
            <p className="text-muted-foreground mt-1">
              Theo dõi và xử lý công việc từ khách hàng
            </p>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Tạo công việc
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Tổng công việc
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalIssues}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Công việc khẩn cấp
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{urgentIssues}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Đã phân công
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{assignedIssues}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex gap-4 items-center flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Lọc:</span>
          </div>

          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Mức độ ưu tiên" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả mức độ</SelectItem>
              {Object.entries(PRIORITY_CONFIG).map(([key, config]) => (
                <SelectItem key={key} value={key}>
                  {config.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={taskTypeFilter} onValueChange={setTaskTypeFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Loại công việc" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả loại</SelectItem>
              {taskTypes.map((taskType) => (
                <SelectItem key={taskType.id} value={taskType.id}>
                  <div className="flex items-center gap-2">
                    {taskType.color && (
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: taskType.color }}
                      />
                    )}
                    {taskType.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={buildingFilter} onValueChange={setBuildingFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Tòa nhà" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả tòa nhà</SelectItem>
              {buildings.map((building) => (
                <SelectItem key={building.id} value={building.id}>
                  {building.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(priorityFilter !== "ALL" || taskTypeFilter !== "ALL" || buildingFilter !== "ALL") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPriorityFilter("ALL");
                setTaskTypeFilter("ALL");
                setBuildingFilter("ALL");
              }}
            >
              Xóa bộ lọc
            </Button>
          )}
        </div>

        {/* Kanban Board */}
        {issues.length === 0 && priorityFilter === "ALL" && taskTypeFilter === "ALL" && buildingFilter === "ALL" ? (
          <EmptyState
            icon={ClipboardList}
            title="Chưa có công việc nào"
            description="Hãy tạo công việc đầu tiên để bắt đầu theo dõi và xử lý"
            actionLabel="Tạo công việc"
            onAction={() => setCreateDialogOpen(true)}
          />
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {groupedIssues.map((column) => (
            <div key={column.value} className="space-y-3">
              {/* Column Header */}
              <div className="flex items-center justify-between">
                <Badge className={column.color}>
                  {column.label}
                </Badge>
                <span className="text-sm text-muted-foreground font-medium">
                  {column.count}
                </span>
              </div>

              {/* Column Cards */}
              <div className="space-y-2 min-h-[200px] max-h-[600px] overflow-y-auto">
                {column.issues.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Không có công việc
                  </div>
                ) : (
                  column.issues.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      taskTypes={taskTypes}
                      onClick={() => handleIssueClick(issue.id)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
        )}

        {/* Dialogs */}
        <CreateIssueDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />
      </div>
    </MainLayout>
  );
};

export default IssuesPage;
