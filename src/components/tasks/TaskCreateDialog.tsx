import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { jobCreateSchema, type JobCreateFormValues } from "@/lib/jobValidation";
import { JOB_PRIORITIES, PRIORITY_LABELS } from "@/types/jobs";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useBeds } from "@/hooks/useBeds";
import { useJobGroups, useCreateJobGroup } from "@/hooks/useJobGroups";
import { useJobTypes, useCreateJobType } from "@/hooks/useJobTypes";
import { useCreateJob, useProfiles } from "@/hooks/useJobs";
import { useAuth } from "@/hooks/useAuth";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";

interface TaskCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export default function TaskCreateDialog({
  open,
  onOpenChange,
  onSuccess,
}: TaskCreateDialogProps) {
  const { data: authUser } = useAuth();
  const { data: buildings = [] } = useBuildings();
  const { data: jobGroups = [] } = useJobGroups();
  const { data: jobTypes = [] } = useJobTypes();
  const { data: profiles = [] } = useProfiles();
  const createJob = useCreateJob();
  const createJobGroup = useCreateJobGroup();
  const createJobType = useCreateJobType();

  // Cascading dropdown state
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | undefined>(undefined);
  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);

  const { data: rooms = [] } = useRooms(selectedBuildingId);
  const { data: beds = [] } = useBeds(selectedRoomId);

  // Inline creation state
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [isCreatingType, setIsCreatingType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");

  const form = useForm<JobCreateFormValues>({
    resolver: zodResolver(jobCreateSchema),
    defaultValues: {
      title: "",
      description: null,
      priority: "NORMAL",
      visible_to_customer: false,
    },
  });

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      form.reset({
        title: "",
        description: null,
        priority: "NORMAL",
        visible_to_customer: false,
      });
      setSelectedBuildingId(undefined);
      setSelectedRoomId(undefined);
      setIsCreatingGroup(false);
      setNewGroupName("");
      setIsCreatingType(false);
      setNewTypeName("");
    }
  }, [open, form]);

  // Cascading: building change → reset room & bed
  const handleBuildingChange = (value: string) => {
    const buildingId = value === "__none__" ? undefined : value;
    setSelectedBuildingId(buildingId);
    setSelectedRoomId(undefined);
    form.setValue("building_id", buildingId ?? null, { shouldValidate: true });
    form.setValue("room_id", null);
    form.setValue("bed_id", null);
  };

  // Cascading: room change → reset bed
  const handleRoomChange = (value: string) => {
    const roomId = value === "__none__" ? undefined : value;
    setSelectedRoomId(roomId);
    form.setValue("room_id", roomId ?? null, { shouldValidate: true });
    form.setValue("bed_id", null);
  };

  const handleBedChange = (value: string) => {
    form.setValue("bed_id", value === "__none__" ? null : value, { shouldValidate: true });
  };

  // Inline creation: Job Group
  const handleJobGroupChange = (value: string) => {
    if (value === "__create_new__") {
      setIsCreatingGroup(true);
      return;
    }
    form.setValue("job_group_id", value === "__none__" ? null : value, { shouldValidate: true });
  };

  const handleCreateGroup = async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    try {
      const created = await createJobGroup.mutateAsync(trimmed);
      if (created?.id) {
        form.setValue("job_group_id", created.id, { shouldValidate: true });
      }
      setIsCreatingGroup(false);
      setNewGroupName("");
    } catch {
      // Error handled by hook
    }
  };

  // Inline creation: Job Type
  const handleJobTypeChange = (value: string) => {
    if (value === "__create_new__") {
      setIsCreatingType(true);
      return;
    }
    form.setValue("job_type_id", value === "__none__" ? null : value, { shouldValidate: true });
  };

  const handleCreateType = async () => {
    const trimmed = newTypeName.trim();
    if (!trimmed) return;
    try {
      const created = await createJobType.mutateAsync({ name: trimmed });
      if (created?.id) {
        form.setValue("job_type_id", created.id, { shouldValidate: true });
      }
      setIsCreatingType(false);
      setNewTypeName("");
    } catch {
      // Error handled by hook
    }
  };

  const onSubmit = async (values: JobCreateFormValues) => {
    try {
      await createJob.mutateAsync(values);
      onOpenChange(false);
      onSuccess();
    } catch {
      // Error handled by hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-green-600 uppercase font-semibold">
            THÊM CÔNG VIỆC
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Row 1: Căn hộ / Phòng / Giường */}
            <div className="grid grid-cols-3 gap-4">
              {/* Căn hộ */}
              <FormItem>
                <FormLabel>Căn hộ</FormLabel>
                <Select
                  value={selectedBuildingId ?? "__none__"}
                  onValueChange={handleBuildingChange}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn căn hộ" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">-- Chọn căn hộ --</SelectItem>
                    {buildings.map((b: any) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>

              {/* Phòng */}
              <FormItem>
                <FormLabel>Phòng</FormLabel>
                <Select
                  value={form.watch("room_id") ?? "__none__"}
                  onValueChange={handleRoomChange}
                  disabled={!selectedBuildingId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn phòng" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">-- Chọn phòng --</SelectItem>
                    {rooms.map((r: any) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>

              {/* Giường */}
              <FormItem>
                <FormLabel>Giường</FormLabel>
                <Select
                  value={form.watch("bed_id") ?? "__none__"}
                  onValueChange={handleBedChange}
                  disabled={!selectedRoomId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn giường" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">-- Chọn giường --</SelectItem>
                    {beds.map((b: any) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>
            </div>

            {/* Tiêu đề */}
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tiêu đề *</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập tiêu đề công việc" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Mô tả */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Nhập mô tả công việc"
                      rows={3}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Row: Nhóm công việc + Loại công việc */}
            <div className="grid grid-cols-2 gap-4">
              {/* Nhóm công việc */}
              <FormField
                control={form.control}
                name="job_group_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhóm công việc</FormLabel>
                    {isCreatingGroup ? (
                      <div className="flex gap-2">
                        <Input
                          placeholder="Tên nhóm mới"
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleCreateGroup();
                            }
                          }}
                        />
                        <Button type="button" size="sm" onClick={handleCreateGroup}>
                          Lưu
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsCreatingGroup(false);
                            setNewGroupName("");
                          }}
                        >
                          Huỷ
                        </Button>
                      </div>
                    ) : (
                      <Select
                        value={field.value ?? "__none__"}
                        onValueChange={handleJobGroupChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn nhóm công việc" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">-- Chọn nhóm --</SelectItem>
                          {jobGroups.map((g: any) => (
                            <SelectItem key={g.id} value={g.id}>
                              {g.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="__create_new__">
                            + Thêm nhóm mới
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Loại công việc */}
              <FormField
                control={form.control}
                name="job_type_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại công việc</FormLabel>
                    {isCreatingType ? (
                      <div className="flex gap-2">
                        <Input
                          placeholder="Tên loại mới"
                          value={newTypeName}
                          onChange={(e) => setNewTypeName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleCreateType();
                            }
                          }}
                        />
                        <Button type="button" size="sm" onClick={handleCreateType}>
                          Lưu
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsCreatingType(false);
                            setNewTypeName("");
                          }}
                        >
                          Huỷ
                        </Button>
                      </div>
                    ) : (
                      <Select
                        value={field.value ?? "__none__"}
                        onValueChange={handleJobTypeChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn loại công việc" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">-- Chọn loại --</SelectItem>
                          {jobTypes.map((t: any) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="__create_new__">
                            + Thêm loại mới
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Row: Mức độ ưu tiên + Người thực hiện */}
            <div className="grid grid-cols-2 gap-4">
              {/* Mức độ ưu tiên */}
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mức độ ưu tiên</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn mức độ ưu tiên" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {JOB_PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Người thực hiện */}
              <FormField
                control={form.control}
                name="assignee_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Người thực hiện</FormLabel>
                    <Select
                      value={field.value ?? "__none__"}
                      onValueChange={(v) =>
                        field.onChange(v === "__none__" ? null : v)
                      }
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn người thực hiện" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">-- Chọn người --</SelectItem>
                        {profiles.map((p: any) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.full_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Hạn hoàn thành */}
            <FormField
              control={form.control}
              name="deadline"
              render={({ field }) => {
                // Convert ISO string to datetime-local format for display
                const displayValue = field.value
                  ? field.value.slice(0, 16)
                  : "";
                return (
                  <FormItem>
                    <FormLabel>Hạn hoàn thành</FormLabel>
                    <FormControl>
                      <Input
                        type="datetime-local"
                        value={displayValue}
                        onChange={(e) => {
                          if (e.target.value) {
                            // Convert datetime-local to ISO string
                            field.onChange(
                              new Date(e.target.value).toISOString()
                            );
                          } else {
                            field.onChange(null);
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            {/* Hiển thị với khách hàng */}
            <FormField
              control={form.control}
              name="visible_to_customer"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <FormLabel className="cursor-pointer">
                    Hiển thị với khách hàng
                  </FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            {/* Đính kèm */}
            <FormField
              control={form.control}
              name="attachments"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Đính kèm</FormLabel>
                  <FormControl>
                    <AttachmentUpload
                      attachments={field.value ?? []}
                      onChange={field.onChange}
                      userId={authUser?.id ?? ""}
                      bucket="job-attachments"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Buttons */}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Huỷ
              </Button>
              <Button
                type="submit"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={createJob.isPending}
              >
                {createJob.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
