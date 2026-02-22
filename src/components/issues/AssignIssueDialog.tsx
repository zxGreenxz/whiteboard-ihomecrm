import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useAssignIssue } from "@/hooks/useIssues";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const assignSchema = z.object({
  assigned_to: z.string().min(1, "Phải chọn người xử lý"),
  due_date: z.string().optional(),
  estimated_cost: z.number().min(0, "Chi phí phải >= 0").optional(),
});

type AssignFormValues = z.infer<typeof assignSchema>;

interface AssignIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueId: string;
}

export function AssignIssueDialog({ open, onOpenChange, issueId }: AssignIssueDialogProps) {
  const assignIssue = useAssignIssue();

  // Fetch staff/profiles for assignment
  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles-for-assignment"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq('user_id', user.id);

      if (error) throw error;
      return data || [];
    },
  });

  const form = useForm<AssignFormValues>({
    resolver: zodResolver(assignSchema),
    defaultValues: {
      assigned_to: "",
      due_date: "",
      estimated_cost: 0,
    },
  });

  const onSubmit = async (data: AssignFormValues) => {
    try {
      await assignIssue.mutateAsync({
        id: issueId,
        assigned_to: data.assigned_to,
        due_date: data.due_date || undefined,
        estimated_cost: data.estimated_cost || undefined,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to assign issue:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Phân công công việc</DialogTitle>
          <DialogDescription>Chỉ định nhân viên xử lý công việc này</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="assigned_to"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phân công cho *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn nhân viên" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.full_name || profile.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="due_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hạn hoàn thành</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="estimated_cost"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Chi phí dự kiến (VNĐ)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Hủy
              </Button>
              <Button type="submit" disabled={assignIssue.isPending}>
                {assignIssue.isPending ? "Đang phân công..." : "Phân công"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
