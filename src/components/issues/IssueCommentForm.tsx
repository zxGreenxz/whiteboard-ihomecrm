import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateComment, useUpdateIssue } from "@/hooks/useIssues";
import { Send } from "lucide-react";

const commentSchema = z.object({
  comment: z.string().min(1, "Bình luận không được để trống"),
  newStatus: z.string().optional(),
});

type CommentFormValues = z.infer<typeof commentSchema>;

interface IssueCommentFormProps {
  issueId: string;
  currentStatus?: string;
  canChangeStatus?: boolean;
}

export function IssueCommentForm({ issueId, currentStatus, canChangeStatus = true }: IssueCommentFormProps) {
  const createComment = useCreateComment();
  const updateIssue = useUpdateIssue();

  const form = useForm<CommentFormValues>({
    resolver: zodResolver(commentSchema),
    defaultValues: {
      comment: "",
      newStatus: "",
    },
  });

  const onSubmit = async (data: CommentFormValues) => {
    try {
      // Create comment first
      await createComment.mutateAsync({
        issue_id: issueId,
        comment: data.comment,
        images: [],
      });

      // Update status if changed
      if (data.newStatus && data.newStatus !== currentStatus) {
        await updateIssue.mutateAsync({
          id: issueId,
          status: data.newStatus,
          ...(data.newStatus === "RESOLVED" && { resolved_at: new Date().toISOString() }),
          ...(data.newStatus === "CLOSED" && { closed_at: new Date().toISOString() }),
        });
      }

      form.reset();
    } catch (error) {
      console.error("Failed to create comment:", error);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="comment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Thêm bình luận</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Nhập bình luận hoặc cập nhật tiến độ..."
                      className="min-h-[80px]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {canChangeStatus && (
              <FormField
                control={form.control}
                name="newStatus"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cập nhật trạng thái (tùy chọn)</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Giữ nguyên trạng thái" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">Không thay đổi</SelectItem>
                        <SelectItem value="IN_PROGRESS">Đang xử lý</SelectItem>
                        <SelectItem value="RESOLVED">Đã giải quyết</SelectItem>
                        <SelectItem value="CLOSED">Đóng sự cố</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={createComment.isPending || updateIssue.isPending}>
                <Send className="w-4 h-4 mr-2" />
                {createComment.isPending || updateIssue.isPending ? "Đang gửi..." : "Gửi bình luận"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
