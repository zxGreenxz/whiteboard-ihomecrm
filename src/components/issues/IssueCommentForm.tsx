import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCreateComment } from "@/hooks/useIssues";
import { Send } from "lucide-react";

const commentSchema = z.object({
  comment: z.string().min(1, "Bình luận không được để trống"),
});

type CommentFormValues = z.infer<typeof commentSchema>;

interface IssueCommentFormProps {
  issueId: string;
}

export function IssueCommentForm({ issueId }: IssueCommentFormProps) {
  const createComment = useCreateComment();

  const form = useForm<CommentFormValues>({
    resolver: zodResolver(commentSchema),
    defaultValues: {
      comment: "",
    },
  });

  const onSubmit = async (data: CommentFormValues) => {
    try {
      await createComment.mutateAsync({
        issue_id: issueId,
        comment: data.comment,
        images: [],
      });
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

            <div className="flex justify-end">
              <Button type="submit" disabled={createComment.isPending}>
                <Send className="w-4 h-4 mr-2" />
                {createComment.isPending ? "Đang gửi..." : "Gửi bình luận"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
