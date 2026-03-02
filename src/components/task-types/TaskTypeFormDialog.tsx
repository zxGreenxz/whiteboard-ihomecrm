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
import {
  jobTypeFormSchema,
  type JobTypeFormValues,
  PRIORITY_OPTIONS,
} from "@/lib/jobTypeValidation";
import type { JobTypeWithRelations } from "@/types/jobTypes";

interface TaskTypeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobType?: JobTypeWithRelations | null;
  jobGroups: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  onSubmit: (values: JobTypeFormValues) => void;
  onCreateJobGroup: (name: string) => Promise<any>;
  isSubmitting?: boolean;
}

export default function TaskTypeFormDialog({
  open,
  onOpenChange,
  jobType,
  jobGroups,
  departments,
  onSubmit,
  onCreateJobGroup,
  isSubmitting = false,
}: TaskTypeFormDialogProps) {
  const isEditing = !!jobType;
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const form = useForm<JobTypeFormValues>({
    resolver: zodResolver(jobTypeFormSchema),
    defaultValues: {
      name: "",
      job_group_id: "",
      default_priority: "MEDIUM",
      customer_contact_deadline: 0,
      acceptance_deadline: 0,
      completion_deadline: 0,
      business_hours_only: false,
      default_department_id: "",
    },
  });

  // Reset form when dialog opens/closes or jobType changes
  useEffect(() => {
    if (open) {
      if (jobType) {
        form.reset({
          name: jobType.name,
          job_group_id: jobType.job_group_id ?? "",
          default_priority: jobType.default_priority ?? "MEDIUM",
          customer_contact_deadline: jobType.customer_contact_deadline ?? 0,
          acceptance_deadline: jobType.acceptance_deadline ?? 0,
          completion_deadline: jobType.completion_deadline ?? 0,
          business_hours_only: jobType.business_hours_only ?? false,
          default_department_id: jobType.default_department_id ?? "",
        });
      } else {
        form.reset({
          name: "",
          job_group_id: "",
          default_priority: "MEDIUM",
          customer_contact_deadline: 0,
          acceptance_deadline: 0,
          completion_deadline: 0,
          business_hours_only: false,
          default_department_id: "",
        });
      }
      setIsCreatingGroup(false);
      setNewGroupName("");
    }
  }, [open, jobType, form]);

  const handleJobGroupChange = (value: string) => {
    if (value === "__create_new__") {
      setIsCreatingGroup(true);
      return;
    }
    form.setValue("job_group_id", value, { shouldValidate: true });
  };

  const handleCreateGroup = async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    try {
      const created = await onCreateJobGroup(trimmed);
      if (created?.id) {
        form.setValue("job_group_id", created.id, { shouldValidate: true });
      }
      setIsCreatingGroup(false);
      setNewGroupName("");
    } catch {
      // Error handled by parent hook
    }
  };

  const handleCancelCreateGroup = () => {
    setIsCreatingGroup(false);
    setNewGroupName("");
  };

  const handleFormSubmit = (values: JobTypeFormValues) => {
    onSubmit(values);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-green-600 uppercase font-semibold">
            {isEditing ? "SỬA LOẠI CÔNG VIỆC" : "THÊM LOẠI CÔNG VIỆC"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleFormSubmit)} className="space-y-4">
            {/* Tên loại công việc */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên loại công việc *</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập tên loại công việc" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Row: Nhóm công việc + Mức độ ưu tiên */}
            <div className="grid grid-cols-2 gap-4">
              {/* Nhóm công việc */}
              <FormField
                control={form.control}
                name="job_group_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhóm công việc *</FormLabel>
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
                        <Button type="button" size="sm" variant="outline" onClick={handleCancelCreateGroup}>
                          Huỷ
                        </Button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <Select value={field.value} onValueChange={handleJobGroupChange}>
                          <FormControl>
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder="Chọn nhóm công việc" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {jobGroups.map((group) => (
                              <SelectItem key={group.id} value={group.id}>
                                {group.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="__create_new__">
                              + Thêm nhóm mới
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        {field.value && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 shrink-0"
                            onClick={() => form.setValue("job_group_id", "", { shouldValidate: true })}
                          >
                            ✕
                          </Button>
                        )}
                      </div>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Mức độ ưu tiên */}
              <FormField
                control={form.control}
                name="default_priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mức độ ưu tiên</FormLabel>
                    <div className="flex gap-1">
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder="Chọn mức độ ưu tiên" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PRIORITY_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {field.value && field.value !== "MEDIUM" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 shrink-0"
                          onClick={() => form.setValue("default_priority", "MEDIUM")}
                        >
                          ✕
                        </Button>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Deadline liên hệ KH */}
            <FormField
              control={form.control}
              name="customer_contact_deadline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Deadline liên hệ KH (tính theo phút, để 0 nếu không áp dụng)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Deadline tiếp nhận */}
            <FormField
              control={form.control}
              name="acceptance_deadline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Deadline tiếp nhận công việc (tính theo phút, để 0 nếu không áp dụng)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Deadline hoàn thành */}
            <FormField
              control={form.control}
              name="completion_deadline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Deadline hoàn thành công việc (tính theo phút, để 0 nếu không áp dụng)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Tính giờ hành chính */}
            <FormField
              control={form.control}
              name="business_hours_only"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <FormLabel className="cursor-pointer">Tính giờ hành chính (9h - 18h)</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {/* Bộ phận thực hiện */}
            <FormField
              control={form.control}
              name="default_department_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bộ phận thực hiện *</FormLabel>
                  <div className="flex gap-1">
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Chọn bộ phận" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {departments.map((dept) => (
                          <SelectItem key={dept.id} value={dept.id}>
                            {dept.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {field.value && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 shrink-0"
                        onClick={() => form.setValue("default_department_id", "", { shouldValidate: true })}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Buttons */}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Huỷ
              </Button>
              <Button
                type="submit"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Đang lưu..." : "Lưu"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
