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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import { moveOutFormSchema } from "@/lib/contractValidation";
import type { MoveOutFormData } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import { useRegisterMoveOut } from "@/hooks/useContractOperations";

interface MoveOutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

export function MoveOutDialog({ open, onOpenChange, contract }: MoveOutDialogProps) {
  const registerMoveOut = useRegisterMoveOut();

  const form = useForm<MoveOutFormData>({
    resolver: zodResolver(moveOutFormSchema),
    defaultValues: {
      expected_move_out_date: "",
      notes: "",
    },
  });

  // Reset form when dialog opens or contract changes
  useEffect(() => {
    if (open) {
      form.reset({
        expected_move_out_date: contract.expected_move_out_date ?? "",
        notes: "",
      });
    }
  }, [open, contract, form]);

  const onSubmit = (data: MoveOutFormData) => {
    registerMoveOut.mutate(
      {
        contractId: contract.id,
        expectedMoveOutDate: data.expected_move_out_date,
        notes: data.notes,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Đăng ký ngày chuyển đi</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Expected move out date */}
            <FormField
              control={form.control}
              name="expected_move_out_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Ngày dự kiến chuyển đi <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Ghi chú về việc chuyển đi..."
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={registerMoveOut.isPending}>
                {registerMoveOut.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Đăng ký
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
