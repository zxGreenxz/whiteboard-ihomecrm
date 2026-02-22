import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateComment, useUpdateIssue } from "@/hooks/useIssues";
import { Send, ImagePlus, X } from "lucide-react";

const commentSchema = z.object({
  comment: z.string().min(1, "Ghi chú không được để trống"),
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
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [newImageUrl, setNewImageUrl] = useState("");

  const form = useForm<CommentFormValues>({
    resolver: zodResolver(commentSchema),
    defaultValues: {
      comment: "",
      newStatus: "NO_CHANGE",
    },
  });

  const handleAddImage = () => {
    if (newImageUrl.trim()) {
      setImageUrls((prev) => [...prev, newImageUrl.trim()]);
      setNewImageUrl("");
    }
  };

  const handleRemoveImage = (index: number) => {
    setImageUrls((prev) => prev.filter((_, i) => i !== index));
  };

  const onSubmit = async (data: CommentFormValues) => {
    try {
      await createComment.mutateAsync({
        issue_id: issueId,
        comment: data.comment,
        images: imageUrls.length > 0 ? imageUrls : [],
      });

      if (data.newStatus && data.newStatus !== "NO_CHANGE" && data.newStatus !== currentStatus) {
        await updateIssue.mutateAsync({
          id: issueId,
          status: data.newStatus,
          ...(data.newStatus === "RESOLVED" && { resolved_at: new Date().toISOString() }),
          ...(data.newStatus === "CLOSED" && { closed_at: new Date().toISOString() }),
        });
      }

      form.reset();
      setImageUrls([]);
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
                  <FormLabel>Thêm ghi chú tiến độ</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Nhập ghi chú cập nhật tiến độ..."
                      className="min-h-[80px]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Image URLs for progress update */}
            <div className="space-y-2">
              <FormLabel>Ảnh đính kèm</FormLabel>
              <div className="flex gap-2">
                <Input
                  value={newImageUrl}
                  onChange={(e) => setNewImageUrl(e.target.value)}
                  placeholder="Nhập URL ảnh..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddImage();
                    }
                  }}
                />
                <Button type="button" variant="outline" size="icon" onClick={handleAddImage}>
                  <ImagePlus className="w-4 h-4" />
                </Button>
              </div>
              {imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {imageUrls.map((url, index) => (
                    <div key={index} className="relative group">
                      <img
                        src={url}
                        alt={`Ảnh ${index + 1}`}
                        className="w-16 h-16 object-cover rounded border"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect fill='%23f3f4f6' width='64' height='64'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%239ca3af' font-size='10'%3EẢnh%3C/text%3E%3C/svg%3E";
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(index)}
                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

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
                        <SelectItem value="NO_CHANGE">Không thay đổi</SelectItem>
                        <SelectItem value="IN_PROGRESS">Đang xử lý</SelectItem>
                        <SelectItem value="RESOLVED">Hoàn thành</SelectItem>
                        <SelectItem value="CLOSED">Đã đóng</SelectItem>
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
                {createComment.isPending || updateIssue.isPending ? "Đang gửi..." : "Gửi cập nhật"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
