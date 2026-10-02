import {QueryRegion} from '@/components/errors/QueryRegion';
import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';
import {validateInputDrafts} from '@/lib/inputDraftValidation';
import { useRef, useState } from "react";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import {
  Phone,
  Mail,
  MessageSquare,
  MessageCircle,
  Users,
  Eye,
  FileText,
  RefreshCw,
  Clock,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useLeadActivities,
  useCreateLeadActivity,
  useDeleteLeadActivity,
  type LeadActivity,
} from "@/hooks/useLeadActivities";
import { LEAD_ACTIVITY_TYPES, type LeadActivityType } from "@/lib/leadHelpers";

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Phone,
  Mail,
  MessageSquare,
  MessageCircle,
  Users,
  Eye,
  FileText,
  RefreshCw,
  Clock,
  Plus,
};

interface LeadActivityTimelineProps {
  leadId: string;
}

export function LeadActivityTimeline({ leadId }: LeadActivityTimelineProps) {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [activityType, setActivityType] = useState<LeadActivityType>("NOTE");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");

  const activitiesQuery=useLeadActivities(leadId);
  const {data:activities=[]}=activitiesQuery;
  const [failure,setFailure]=useState('');
  const [blocked,setBlocked]=useState(false);
  const [deleteFailures,setDeleteFailures]=useState<Record<string,{message:string;blocked:boolean}>>({});
  const busy=useRef(false);
  const root=useRef<HTMLDivElement>(null);
  const createActivity = useCreateLeadActivity();
  const deleteActivity = useDeleteLeadActivity();

  const handleAddActivity = async () => {
    if(busy.current || blocked || createActivity.isPending || activitiesQuery.isError || activitiesQuery.isLoading || !validateInputDrafts(root.current))return;
    if(scheduledAt && !Number.isFinite(Date.parse(scheduledAt))){setFailure('Nhập lịch hẹn hợp lệ.');root.current?.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.focus();return;}
    busy.current=true;
    try{
      await createActivity.mutateAsync({lead_id:leadId,activity_type:activityType,description:description || null,notes:notes || null,scheduled_at:scheduledAt || null,completed_at:scheduledAt ? null : new Date().toISOString()});
      setAddDialogOpen(false);setDescription('');setNotes('');setScheduledAt('');setActivityType('NOTE');setFailure('');
    }catch(error){setFailure(recordWriteMessage(error,'thêm hoạt động khách hẹn'));setBlocked(recordWriteBlocked(error));}
    finally{busy.current=false;}
  };
  const handleDeleteActivity = async (activity:LeadActivity) => {
    if(busy.current || deleteActivity.isPending || deleteFailures[activity.id]?.blocked || activitiesQuery.isError)return;
    if(!confirm('Bạn có chắc muốn xóa hoạt động này?'))return;
    busy.current=true;
    try{await deleteActivity.mutateAsync({activityId:activity.id,leadId});}
    catch(error){setDeleteFailures(previous=>({...previous,[activity.id]:{message:recordWriteMessage(error,'xoá hoạt động khách hẹn'),blocked:recordWriteBlocked(error)}}));}
    finally{busy.current=false;}
  };

  const getActivityIcon = (type: LeadActivityType) => {
    const config = LEAD_ACTIVITY_TYPES[type];
    const IconComponent = iconMap[config?.icon || "FileText"];
    return IconComponent;
  };

  const getActivityColor = (type: LeadActivityType) => {
    const colors: Record<string, string> = {
      blue: "bg-blue-100 text-blue-600",
      purple: "bg-purple-100 text-purple-600",
      green: "bg-green-100 text-green-600",
      orange: "bg-orange-100 text-orange-600",
      teal: "bg-teal-100 text-teal-600",
      gray: "bg-gray-100 text-gray-600",
      indigo: "bg-indigo-100 text-indigo-600",
      yellow: "bg-yellow-100 text-yellow-600",
    };
    const config = LEAD_ACTIVITY_TYPES[type];
    return colors[config?.color || "gray"];
  };

  // Chủ chốt 02/10/2026: khung thẻ (tiêu đề + nút Thêm) hiện ngay, lịch sử là khối xám;
  // form thêm vẫn khoá tới khi lịch sử về (fieldset bên dưới).
  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">Lịch sử hoạt động</CardTitle>
          <Button size="sm" onClick={() => setAddDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm
          </Button>
        </CardHeader>
        <CardContent>
          <QueryRegion label="lịch sử hoạt động khách hẹn" queries={[activitiesQuery]} skeleton="list" rows={3}>
          {activities.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              Chưa có hoạt động nào
            </p>
          ) : (
            <div className="space-y-4">
              {activities.map((activity, index) => {
                const IconComponent = getActivityIcon(activity.activity_type);
                const colorClass = getActivityColor(activity.activity_type);
                const config = LEAD_ACTIVITY_TYPES[activity.activity_type];

                return (
                  <div key={activity.id} className="flex gap-3">
                    {/* Timeline line */}
                    <div className="flex flex-col items-center">
                      <div className={`p-2 rounded-full ${colorClass}`}>
                        <IconComponent className="h-4 w-4" />
                      </div>
                      {index < activities.length - 1 && (
                        <div className="w-px h-full bg-gray-200 my-1" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 pb-4">
                      {deleteFailures[activity.id] && <p role="alert" className="text-destructive">{deleteFailures[activity.id].message}</p>}
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium text-sm">
                            {config?.label || activity.activity_type}
                          </p>
                          {activity.description && (
                            <p className="text-sm text-gray-600 mt-0.5">
                              {activity.description}
                            </p>
                          )}
                          {activity.notes && (
                            <p className="text-sm text-gray-500 mt-1 italic">
                              "{activity.notes}"
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {format(new Date(activity.created_at), "dd/MM/yyyy HH:mm", {
                              locale: vi,
                            })}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-gray-400 hover:text-red-500"
                          disabled={deleteActivity.isPending || !!deleteFailures[activity.id]?.blocked}
                          onClick={() => {void handleDeleteActivity(activity);}}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </QueryRegion>
        </CardContent>
      </Card>

      {/* Add Activity Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={next=>{if(!busy.current && !createActivity.isPending)setAddDialogOpen(next);}}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Thêm hoạt động</DialogTitle>
          </DialogHeader>

          {failure && <p role="alert" className="text-destructive">{failure}</p>}
          <div ref={root}>
          <fieldset disabled={createActivity.isPending || blocked || activitiesQuery.isError || activitiesQuery.isLoading} className="space-y-4">
            <div className="space-y-2">
              <Label>Loại hoạt động</Label>
              <Select
                value={activityType}
                onValueChange={(v) => setActivityType(v as LeadActivityType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LEAD_ACTIVITY_TYPES).map(([key, config]) => (
                    <SelectItem key={key} value={key}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Mô tả</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="VD: Đã gọi điện tư vấn..."
              />
            </div>

            <div className="space-y-2">
              <Label>Ghi chú</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ghi chú thêm..."
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Lịch hẹn (nếu có)</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
          </fieldset>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Hủy
            </Button>
            <Button onClick={handleAddActivity} disabled={createActivity.isPending || blocked || activitiesQuery.isError || activitiesQuery.isLoading}>
              {createActivity.isPending ? "Đang lưu..." : "Lưu"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
