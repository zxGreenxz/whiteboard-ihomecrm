import { useEffect } from "react";
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
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  jobCompleteSchema,
  type JobCompleteFormValues,
} from "@/lib/jobValidation";
import { useUpdateJobStatus } from "@/hooks/useJobs";
import { useAuth } from "@/hooks/useAuth";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";

interface TaskCompleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  onSuccess: () => void;
}

export default function TaskCompleteDialog({
  open,
  onOpenChange,
  jobId,
  onSuccess,
}: TaskCompleteDialogProps) {
  const { data: authUser } = useAuth();
  const updateJobStatus = useUpdateJobStatus();

  const form = useForm<JobCompleteFormValues>({
    resolver: zodResolver(jobCompleteSchema),
    defaultValues: {
      completion_time: "",
      completion_description: null,
      completion_attachments: null,
    },
  });

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      form.reset({
        completion_time: "",
        completion_description: null,
        completion_attachments: null,
      });
    }
  }, [open, form]);

  const onSubmit = async (values: JobCompleteFormValues) => {
    try {
      await updateJobStatus.mutateAsync({
        id: jobId,
        status: "PENDING_ACCEPTANCE",
        extraData: {
          completion_time: values.completion_time,
          completion_description: values.completion_description,
          completion_attachments: values.completion_attachments,
        },
      });
      onOpenChange(false);
      onSuccess();
    } catch {
      // Error handled by hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-green-600 uppercase font-semibold">
            HOÀN THÀNH CÔNG VIỆC
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Thời gian hoàn thành */}
            <FormField
              control={form.control}
              name="completion_time"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Thời gian hoàn thành *</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Mô tả kết quả */}
            <FormField
              control={form.control}
              name="completion_description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả kết quả</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Nhập mô tả kết quả công việc"
                      rows={3}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Đính kèm */}
            <FormField
              control={form.control}
              name="completion_attachments"
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
                disabled={updateJobStatus.isPending}
              >
                {updateJobStatus.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
