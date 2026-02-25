import { useFieldArray, useController, type Control } from 'react-hook-form';
import { Trash2, Plus } from 'lucide-react';
import type { CT01FormData } from '@/types/customer';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CT01FamilyMembersTableProps {
  control: Control<CT01FormData>;
}

const defaultMember = {
  full_name: '',
  date_of_birth: '',
  gender: '',
  id_number: '',
  occupation_workplace: '',
  relationship_to_declarant: '',
  relationship_to_household_head: '',
};

/** Controlled gender select for a single family member row */
function GenderSelect({
  control,
  index,
}: {
  control: Control<CT01FormData>;
  index: number;
}) {
  const { field } = useController({
    control,
    name: `family_members.${index}.gender`,
  });

  return (
    <Select value={field.value} onValueChange={field.onChange}>
      <SelectTrigger className="h-8 text-sm">
        <SelectValue placeholder="Chọn" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="Nam">Nam</SelectItem>
        <SelectItem value="Nữ">Nữ</SelectItem>
        <SelectItem value="Khác">Khác</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function CT01FamilyMembersTable({ control }: CT01FamilyMembersTableProps) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'family_members',
  });

  return (
    <div className="space-y-2">
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">STT</TableHead>
              <TableHead className="min-w-[160px]">Họ tên</TableHead>
              <TableHead className="min-w-[120px]">Ngày sinh</TableHead>
              <TableHead className="min-w-[100px]">Giới tính</TableHead>
              <TableHead className="min-w-[140px]">CMND/CCCD</TableHead>
              <TableHead className="min-w-[160px]">Nghề nghiệp</TableHead>
              <TableHead className="min-w-[160px]">Quan hệ với người khai</TableHead>
              <TableHead className="min-w-[160px]">Quan hệ với chủ hộ</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                  Chưa có thành viên nào
                </TableCell>
              </TableRow>
            )}
            {fields.map((field, index) => (
              <TableRow key={field.id}>
                <TableCell className="text-center text-sm">{index + 1}</TableCell>
                <TableCell>
                  <Input
                    {...control.register(`family_members.${index}.full_name`)}
                    placeholder="Họ và tên"
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    {...control.register(`family_members.${index}.date_of_birth`)}
                    type="date"
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <GenderSelect control={control} index={index} />
                </TableCell>
                <TableCell>
                  <Input
                    {...control.register(`family_members.${index}.id_number`)}
                    placeholder="Số CMND/CCCD"
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    {...control.register(`family_members.${index}.occupation_workplace`)}
                    placeholder="Nghề nghiệp / Nơi làm việc"
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    {...control.register(`family_members.${index}.relationship_to_declarant`)}
                    placeholder="Quan hệ với người khai"
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    {...control.register(`family_members.${index}.relationship_to_household_head`)}
                    placeholder="Quan hệ với chủ hộ"
                    className="h-8 text-sm"
                  />
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append(defaultMember)}
        className="gap-1"
      >
        <Plus className="h-4 w-4" />
        Thêm thành viên
      </Button>
    </div>
  );
}
