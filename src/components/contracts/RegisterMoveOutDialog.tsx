import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateContract } from '@/hooks/useContracts';
import type { ContractWithRelations } from '@/hooks/useContracts';
import { LogOut } from 'lucide-react';

interface RegisterMoveOutDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    contract: ContractWithRelations | null;
}

const schema = z.object({
    expected_move_out_date: z.string().min(1, 'Vui lòng chọn ngày'),
    notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

const RegisterMoveOutDialog = ({ open, onOpenChange, contract }: RegisterMoveOutDialogProps) => {
    const updateContractMutation = useUpdateContract();

    const {
        register,
        handleSubmit,
        formState: { errors },
        reset,
    } = useForm<FormData>({
        resolver: zodResolver(schema),
    });

    const handleClose = () => {
        reset();
        onOpenChange(false);
    };

    const onSubmit = (data: FormData) => {
        if (!contract) return;

        updateContractMutation.mutate(
            {
                id: contract.id,
                expected_move_out_date: data.expected_move_out_date,
                notes: data.notes ? `${contract.notes || ''}\n[Đăng ký chuyển đi]: ${data.notes}` : contract.notes,
            } as any, // Cast to any because expected_move_out_date is new
            {
                onSuccess: () => {
                    handleClose();
                },
            }
        );
    };

    if (!contract) return null;

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <LogOut className="h-5 w-5" />
                        Đăng ký ngày chuyển đi
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                    <div className="space-y-2">
                        <Label>Ngày sẽ chuyển đi *</Label>
                        <Input type="date" {...register('expected_move_out_date')} />
                        {errors.expected_move_out_date && (
                            <p className="text-sm text-red-500">{errors.expected_move_out_date.message}</p>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label>Ghi chú</Label>
                        <Textarea {...register('notes')} placeholder="Ghi chú..." />
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={handleClose}>
                            Hủy
                        </Button>
                        <Button type="submit" disabled={updateContractMutation.isPending}>
                            {updateContractMutation.isPending ? 'Đang lưu...' : 'Lưu'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default RegisterMoveOutDialog;
