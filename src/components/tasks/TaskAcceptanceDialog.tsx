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
  jobAcceptanceSchema,
  type JobAcceptanceFormValues,
} from "@/lib/jobValidation";
import { useUpdateJobStatus } from "@/hooks/useJobs";

interface TaskAcceptanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  onSuccess: () => void;
}

export default function TaskAcceptanceDialog({
  open,
  onOpenChange,
  jobId,
  onSuccess,
}: TaskAcceptanceDialogProps) {
  const updateJobStatus = useUpdateJobStatus();

  const form = useForm<JobAcceptanceFormValues>({
    resolver: zodResolver(jobAcceptanceSchema),
    defaultValues: {
      acceptance_result: null,
      customer_evaluation: null,
      customer_comments: null,
    },
  });

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      form.reset({
        acceptance_result: null,
        customer_evaluation: null,
        customer_comments: null,
      });
    }
  }, [open, form]);

  const handleSubmit = async (
    values: JobAcceptanceFormValues,
    status: "ACCEPTED" | "FAILED"
  ) => {
    try {
      await updateJobStatus.mutateAsync({
        id: jobId,
        status,
        extraData: {
          acceptance_result: values.acceptance_result,
          customer_evaluation: values.customer_evaluation,
          customer_comments: values.customer_comments,
          accepted_at: new Date().toISOString(),
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
            NGHIỆM THU CÔNG VIỆC
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form className="space-y-4">
            {/* Đánh giá kết quả */}
            <FormField
              control={form.control}
              name="acceptance_result"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Đánh giá kết quả</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Nhập đánh giá kết quả"
                      rows={3}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Đánh giá khách hàng */}
            <FormField
              control={form.control}
              name="customer_evaluation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Đánh giá khách hàng</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Nhập đánh giá khách hàng"
                      rows={3}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Ý kiến khách hàng */}
            <FormField
              control={form.control}
              name="customer_comments"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ý kiến khách hàng</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Nhập ý kiến khách hàng"
                      rows={3}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Buttons */}
            <DialogFooter className="gap-2">
              <Button
                type="button"
                className="bg-red-600 hover:bg-red-700 text-white"
                disabled={updateJobStatus.isPending}
                onClick={form.handleSubmit((values) =>
                  handleSubmit(values, "FAILED")
                )}
              >
                {updateJobStatus.isPending ? "Đang lưu..." : "Không đạt"}
              </Button>
              <Button
                type="button"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={updateJobStatus.isPending}
                onClick={form.handleSubmit((values) =>
                  handleSubmit(values, "ACCEPTED")
                )}
              >
                {updateJobStatus.isPending ? "Đang lưu..." : "Đạt"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
