import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useUpdateIssue } from "@/hooks/useIssues";
import { Star } from "lucide-react";

const ratingSchema = z.object({
  rating: z.number().min(1, "Vui lòng chọn đánh giá").max(5),
  feedback: z.string().optional(),
});

type RatingFormValues = z.infer<typeof ratingSchema>;

interface IssueRatingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueId: string;
  currentRating?: number | null;
  currentFeedback?: string | null;
}

export function IssueRatingDialog({
  open,
  onOpenChange,
  issueId,
  currentRating,
  currentFeedback,
}: IssueRatingDialogProps) {
  const [hoveredStar, setHoveredStar] = useState(0);
  const updateIssue = useUpdateIssue();

  const form = useForm<RatingFormValues>({
    resolver: zodResolver(ratingSchema),
    defaultValues: {
      rating: currentRating || 0,
      feedback: currentFeedback || "",
    },
  });

  const selectedRating = form.watch("rating");

  const onSubmit = async (data: RatingFormValues) => {
    try {
      await updateIssue.mutateAsync({
        id: issueId,
        rating: data.rating,
        feedback: data.feedback || null,
        status: "CLOSED",
        closed_at: new Date().toISOString(),
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to rate issue:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Đánh giá giải quyết công việc</DialogTitle>
          <DialogDescription>
            Vui lòng đánh giá mức độ hài lòng về cách giải quyết công việc
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="rating"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Đánh giá *</FormLabel>
                  <FormControl>
                    <div className="flex gap-2 justify-center py-4">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => field.onChange(star)}
                          onMouseEnter={() => setHoveredStar(star)}
                          onMouseLeave={() => setHoveredStar(0)}
                          className="transition-transform hover:scale-110"
                        >
                          <Star
                            className={`w-10 h-10 ${
                              star <= (hoveredStar || selectedRating)
                                ? "fill-yellow-400 text-yellow-400"
                                : "text-gray-300"
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                  </FormControl>
                  <div className="text-center text-sm text-muted-foreground">
                    {selectedRating === 0 && "Chọn số sao"}
                    {selectedRating === 1 && "Rất không hài lòng"}
                    {selectedRating === 2 && "Không hài lòng"}
                    {selectedRating === 3 && "Bình thường"}
                    {selectedRating === 4 && "Hài lòng"}
                    {selectedRating === 5 && "Rất hài lòng"}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="feedback"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nhận xét (tùy chọn)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Nhập nhận xét của bạn về cách giải quyết công việc..."
                      className="min-h-[100px]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Hủy
              </Button>
              <Button type="submit" disabled={updateIssue.isPending}>
                {updateIssue.isPending ? "Đang gửi..." : "Gửi đánh giá"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
