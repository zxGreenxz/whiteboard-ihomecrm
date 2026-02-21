# METER READING IMPLEMENTATION PLAN
## Kế hoạch hiện thực Flow "Ghi chỉ số"

**Based on:** docs.resident.vn/quan-ly-and-van-hanh/tai-chinh/ghi-chi-so
**Created:** 2025-11-21
**Status:** Ready for Implementation

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Database Migrations](#database-migrations)
3. [API Endpoints](#api-endpoints)
4. [Frontend Components](#frontend-components)
5. [Implementation Steps](#implementation-steps)
6. [Testing Plan](#testing-plan)
7. [Deployment Checklist](#deployment-checklist)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Hiện thực hoàn chỉnh flow "Ghi chỉ số" với 2 phương thức:
1. **Method 1:** Ghi chỉ số từng phòng (Individual)
2. **Method 2:** Nhập hàng loạt qua template (Batch Import)

### UI Reference
- **Danh sách:** Table với columns: Mã | Thao tác | Công tơ | Chỉ số đầu | Chỉ số cuối | Số tiêu thụ | Ngày chốt | Người chốt
- **Form:** Modal với filters (Tòa nhà, Phòng, Loại công tơ) + Table để nhập nhiều công tơ
- **Approval:** Workflow duyệt (UNAPPROVED → APPROVED)

### Tech Stack
- **Database:** Supabase PostgreSQL
- **Backend:** Supabase Functions / Edge Functions
- **Frontend:** React + TypeScript + Tailwind CSS
- **Forms:** React Hook Form + Zod
- **Tables:** TanStack Table
- **API:** TanStack Query (React Query)

---

## 💾 DATABASE MIGRATIONS

### ✅ Completed Migrations

#### 1. Migration 016: `meter_readings_enhancements.sql`
**Purpose:** Enhance existing meter_readings table with approval workflow

**Changes:**
```sql
-- New columns
building_id           UUID          -- For faster queries
room_id               UUID          -- For faster queries
settlement_month      TEXT          -- YYYY-MM format
status                TEXT          -- UNAPPROVED | APPROVED
approved_by           UUID
approved_at           TIMESTAMPTZ
updated_at            TIMESTAMPTZ
deleted_at            TIMESTAMPTZ
recorded_by           UUID

-- Indexes
idx_meter_readings_building_id
idx_meter_readings_room_id
idx_meter_readings_settlement_month
idx_meter_readings_status
idx_meter_readings_recorded_by

-- Functions
auto_populate_meter_reading_fields()  -- Auto-fill building_id, room_id, etc.
auto_populate_previous_reading()      -- Auto-get last reading
approve_meter_reading()               -- Single approval
bulk_approve_meter_readings()         -- Bulk approval
get_meter_reading_stats()             -- Statistics for dashboard

-- View
meter_readings_detailed               -- Detailed view with joins
```

#### 2. Migration 017: `meters_table.sql`
**Purpose:** Create meters (công tơ) table for physical meter management

**Schema:**
```sql
CREATE TABLE meters (
  id                    UUID PRIMARY KEY,
  user_id               UUID NOT NULL,
  code                  TEXT NOT NULL,        -- CTD-201, CTD-G01...
  building_id           UUID NOT NULL,
  room_id               UUID,                 -- NULL = common meter
  service_id            UUID NOT NULL,
  meter_type            meter_type NOT NULL,  -- ELECTRICITY, WATER, GAS
  name                  TEXT,                 -- Auto-generated
  installation_date     DATE,
  initial_reading       DECIMAL(10, 2),
  status                TEXT,                 -- ACTIVE, INACTIVE, BROKEN, REMOVED
  location_note         TEXT,
  manufacturer          TEXT,
  model                 TEXT,
  serial_number         TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,
  UNIQUE(user_id, code)
);

-- Functions
auto_generate_meter_name()            -- Auto-generate name from room + type
get_meters_without_readings()         -- Get unrecorded meters for month

-- View
meters_with_latest_reading            -- Meters with latest reading info
```

**Meter Code Examples:**
- `CTD-201`: Công tơ điện phòng 201
- `CTN-201`: Công tơ nước phòng 201
- `CTG-301`: Công tơ gas phòng 301

#### 3. Migration 018: `meter_readings_add_meter_link.sql`
**Purpose:** Link meter_readings with meters table

**Changes:**
```sql
-- New columns
meter_id              UUID          -- Link to meters table
reading_code          TEXT          -- CSS250700001, CSS250700128...

-- Indexes
idx_meter_readings_meter_id
idx_meter_readings_code (UNIQUE)

-- Functions
generate_meter_reading_code()         -- Generate CSS{YYMM}{sequence}
auto_generate_reading_code()          -- Trigger to auto-generate code
bulk_create_meter_readings()          -- Batch import function

-- Updated functions
auto_populate_meter_reading_fields()  -- Now handles meter_id
auto_populate_previous_reading()      -- Uses meter_id for accuracy

-- Updated view
meter_readings_detailed               -- Includes meter code/name
```

**Reading Code Format:** `CSS{YYMM}{sequence}`
- `CSS250700001`: Reading 1 of Nov 2025
- `CSS250700128`: Reading 128 of Nov 2025

---

## 🔌 API ENDPOINTS

### Base URL
```
/api/v1/meter-readings
/api/v1/meters
```

### Endpoints to Implement

#### 1. **Meters Management**

```typescript
// =============================================
// GET /api/v1/meters
// =============================================
// Get list of meters with filters
GET /api/v1/meters?building_id={uuid}&room_id={uuid}&meter_type={type}&status={status}

Response: {
  data: Meter[],
  count: number
}

// =============================================
// GET /api/v1/meters/{id}
// =============================================
// Get single meter with latest reading
GET /api/v1/meters/{id}

Response: {
  id: string,
  code: string,
  name: string,
  building_name: string,
  room_name: string,
  meter_type: 'ELECTRICITY' | 'WATER' | 'GAS',
  status: string,
  latest_reading: number,
  latest_reading_date: string,
  total_readings: number
}

// =============================================
// POST /api/v1/meters
// =============================================
// Create new meter
POST /api/v1/meters

Request: {
  code: string,
  building_id: string,
  room_id: string | null,
  service_id: string,
  meter_type: 'ELECTRICITY' | 'WATER' | 'GAS',
  installation_date?: string,
  initial_reading?: number,
  location_note?: string
}

Response: {
  id: string,
  code: string,
  name: string,
  status: 'ACTIVE'
}

// =============================================
// PUT /api/v1/meters/{id}
// =============================================
// Update meter
PUT /api/v1/meters/{id}

Request: {
  code?: string,
  status?: 'ACTIVE' | 'INACTIVE' | 'BROKEN' | 'REMOVED',
  location_note?: string,
  notes?: string
}

// =============================================
// DELETE /api/v1/meters/{id}
// =============================================
// Soft delete meter
DELETE /api/v1/meters/{id}

// =============================================
// GET /api/v1/meters/unrecorded
// =============================================
// Get meters without readings in month
GET /api/v1/meters/unrecorded?building_id={uuid}&room_id={uuid}&meter_type={type}&month=YYYY-MM

Response: {
  data: {
    meter_id: string,
    meter_code: string,
    meter_name: string,
    room_name: string,
    meter_type: string,
    last_reading: number,
    last_reading_date: string | null
  }[],
  count: number
}
```

#### 2. **Meter Readings Management**

```typescript
// =============================================
// GET /api/v1/meter-readings
// =============================================
// Get list of meter readings with filters
GET /api/v1/meter-readings?building_id={uuid}&room_id={uuid}&meter_type={type}&month={YYYY-MM}&status={status}

Response: {
  data: MeterReading[],
  count: number,
  pagination: {
    page: number,
    pageSize: number,
    total: number
  }
}

// =============================================
// GET /api/v1/meter-readings/{id}
// =============================================
// Get single meter reading
GET /api/v1/meter-readings/{id}

Response: {
  id: string,
  reading_code: string,
  meter_code: string,
  meter_name: string,
  building_name: string,
  room_name: string,
  meter_type: string,
  reading_date: string,
  previous_reading: number,
  current_reading: number,
  consumption: number,
  status: 'UNAPPROVED' | 'APPROVED',
  approved_by: string | null,
  approved_at: string | null,
  recorded_by: string,
  notes: string | null,
  meter_image_url: string | null
}

// =============================================
// POST /api/v1/meter-readings
// =============================================
// Create single meter reading
POST /api/v1/meter-readings

Request: {
  meter_id: string,
  reading_date: string,      // YYYY-MM-DD
  current_reading: number,
  notes?: string,
  meter_image_url?: string
}

Response: {
  id: string,
  reading_code: string,      // Auto-generated CSS...
  meter_code: string,
  previous_reading: number,  // Auto-filled
  current_reading: number,
  consumption: number,       // Auto-calculated
  status: 'UNAPPROVED'
}

// =============================================
// POST /api/v1/meter-readings/bulk
// =============================================
// Batch create meter readings
POST /api/v1/meter-readings/bulk

Request: {
  readings: {
    meter_code: string,      // Or meter_id
    reading_date: string,
    current_reading: number,
    notes?: string,
    meter_image_url?: string
  }[]
}

Response: {
  success: number,
  failed: number,
  results: {
    reading_code: string,
    meter_code: string,
    success: boolean,
    error_message?: string
  }[]
}

// =============================================
// PUT /api/v1/meter-readings/{id}
// =============================================
// Update meter reading (only if UNAPPROVED)
PUT /api/v1/meter-readings/{id}

Request: {
  current_reading?: number,
  notes?: string,
  meter_image_url?: string
}

// =============================================
// DELETE /api/v1/meter-readings/{id}
// =============================================
// Soft delete meter reading (only if UNAPPROVED)
DELETE /api/v1/meter-readings/{id}

// =============================================
// POST /api/v1/meter-readings/{id}/approve
// =============================================
// Approve single meter reading
POST /api/v1/meter-readings/{id}/approve

Response: {
  id: string,
  status: 'APPROVED',
  approved_by: string,
  approved_at: string
}

// =============================================
// POST /api/v1/meter-readings/approve-bulk
// =============================================
// Approve multiple meter readings
POST /api/v1/meter-readings/approve-bulk

Request: {
  reading_ids: string[]
}

Response: {
  approved_count: number,
  failed_count: number,
  results: {
    id: string,
    success: boolean,
    error_message?: string
  }[]
}

// =============================================
// GET /api/v1/meter-readings/stats
// =============================================
// Get statistics for dashboard
GET /api/v1/meter-readings/stats?building_id={uuid}&month={YYYY-MM}

Response: {
  total_readings: number,
  unapproved_count: number,
  approved_count: number,
  electricity_consumption: number,
  water_consumption: number,
  gas_consumption: number
}

// =============================================
// GET /api/v1/meter-readings/export
// =============================================
// Export meter readings to Excel/CSV
GET /api/v1/meter-readings/export?building_id={uuid}&month={YYYY-MM}&format={xlsx|csv}

Response: File download

// =============================================
// GET /api/v1/meter-readings/template
// =============================================
// Download import template
GET /api/v1/meter-readings/template

Response: Excel file with columns: meter_code, reading_date, current_reading, notes

// =============================================
// POST /api/v1/meter-readings/import
// =============================================
// Import meter readings from Excel/CSV
POST /api/v1/meter-readings/import

Request: FormData {
  file: File (xlsx or csv)
}

Response: {
  success: number,
  failed: number,
  errors: {
    row: number,
    meter_code: string,
    error: string
  }[]
}
```

---

## 🎨 FRONTEND COMPONENTS

### Component Structure

```
src/
├── features/
│   └── meter-readings/
│       ├── components/
│       │   ├── MeterReadingList.tsx          # Main list/table
│       │   ├── MeterReadingListItem.tsx      # Table row component
│       │   ├── MeterReadingForm.tsx          # Create/Edit form modal
│       │   ├── MeterReadingBulkForm.tsx      # Batch input form
│       │   ├── MeterReadingFilters.tsx       # Filters (building, room, type, month)
│       │   ├── MeterReadingStats.tsx         # Statistics cards
│       │   ├── MeterReadingApprovalButton.tsx
│       │   ├── MeterReadingImportDialog.tsx  # Import modal
│       │   └── MeterReadingExportButton.tsx
│       │
│       ├── hooks/
│       │   ├── useMeterReadings.ts           # React Query hooks
│       │   ├── useMeters.ts
│       │   ├── useMeterReadingMutations.ts
│       │   └── useMeterReadingStats.ts
│       │
│       ├── types/
│       │   └── meter-reading.types.ts
│       │
│       ├── utils/
│       │   ├── meter-reading-validation.ts   # Zod schemas
│       │   └── meter-reading-helpers.ts
│       │
│       └── pages/
│           └── MeterReadingsPage.tsx         # Main page
│
└── features/
    └── meters/
        ├── components/
        │   ├── MeterList.tsx
        │   ├── MeterForm.tsx
        │   └── MeterCard.tsx
        ├── hooks/
        │   └── useMeters.ts
        └── pages/
            └── MetersPage.tsx
```

### Key Components Detail

#### 1. **MeterReadingsPage.tsx**
```typescript
// Main page with list, filters, stats
export function MeterReadingsPage() {
  const [filters, setFilters] = useState<MeterReadingFilters>({
    building_id: null,
    room_id: null,
    meter_type: null,
    month: getCurrentMonth(), // YYYY-MM
    status: null
  });

  const { data: stats } = useMeterReadingStats(filters);
  const { data: readings, isLoading } = useMeterReadings(filters);

  return (
    <div>
      {/* Header with title + action buttons */}
      <Header
        title="Ghi chỉ số"
        actions={
          <>
            <ImportButton />
            <ExportButton />
            <CreateButton />
          </>
        }
      />

      {/* Statistics Cards */}
      <MeterReadingStats stats={stats} />

      {/* Filters */}
      <MeterReadingFilters filters={filters} onChange={setFilters} />

      {/* Table */}
      <MeterReadingList readings={readings} isLoading={isLoading} />
    </div>
  );
}
```

#### 2. **MeterReadingList.tsx**
```typescript
// Table with columns: Mã | Thao tác | Công tơ | Chỉ số đầu | Chỉ số cuối | Số tiêu thụ | Ngày chốt | Người chốt
import { useReactTable, getCoreRowModel, flexRender } from '@tanstack/react-table';

const columns: ColumnDef<MeterReading>[] = [
  {
    id: 'select',
    header: ({ table }) => <Checkbox {...selectAllProps} />,
    cell: ({ row }) => <Checkbox {...selectRowProps} />
  },
  {
    accessorKey: 'reading_code',
    header: 'Mã',
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'APPROVED' ? 'success' : 'warning'}>
        {row.original.reading_code}
      </Badge>
    )
  },
  {
    id: 'actions',
    header: 'Thao tác',
    cell: ({ row }) => (
      <div className="flex gap-1">
        <IconButton icon="eye" onClick={() => viewReading(row.original.id)} />
        <IconButton icon="edit" onClick={() => editReading(row.original.id)} disabled={row.original.status === 'APPROVED'} />
        <IconButton icon="trash" onClick={() => deleteReading(row.original.id)} disabled={row.original.status === 'APPROVED'} />
      </div>
    )
  },
  {
    accessorKey: 'meter_code',
    header: 'Công tơ'
  },
  {
    accessorKey: 'previous_reading',
    header: 'Chỉ số đầu',
    cell: ({ row }) => formatNumber(row.original.previous_reading)
  },
  {
    accessorKey: 'current_reading',
    header: 'Chỉ số cuối',
    cell: ({ row }) => formatNumber(row.original.current_reading)
  },
  {
    accessorKey: 'consumption',
    header: 'Số tiêu thụ',
    cell: ({ row }) => (
      <span className="font-semibold">{formatNumber(row.original.consumption)}</span>
    )
  },
  {
    accessorKey: 'reading_date',
    header: 'Ngày chốt',
    cell: ({ row }) => formatDate(row.original.reading_date)
  },
  {
    accessorKey: 'recorder_email',
    header: 'Người chốt'
  }
];

export function MeterReadingList({ readings, isLoading }) {
  const [rowSelection, setRowSelection] = useState({});
  const { mutate: bulkApprove } = useBulkApproveMeterReadings();

  const table = useReactTable({
    data: readings,
    columns,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel()
  });

  const handleBulkApprove = () => {
    const selectedIds = Object.keys(rowSelection);
    bulkApprove(selectedIds);
  };

  return (
    <div>
      {/* Bulk actions */}
      {Object.keys(rowSelection).length > 0 && (
        <div className="flex gap-2 mb-4">
          <Button onClick={handleBulkApprove} variant="primary">
            Duyệt ({Object.keys(rowSelection).length})
          </Button>
          <Button onClick={() => setRowSelection({})} variant="outline">
            Bỏ chọn
          </Button>
        </div>
      )}

      {/* Table */}
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(headerGroup => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map(header => (
                <TableHead key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map(row => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map(cell => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      <TablePagination table={table} />
    </div>
  );
}
```

#### 3. **MeterReadingForm.tsx**
```typescript
// Modal form for creating meter readings
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const formSchema = z.object({
  building_id: z.string().min(1, 'Chọn tòa nhà'),
  room_id: z.string().min(1, 'Chọn phòng').nullable(),
  meter_type: z.enum(['ELECTRICITY', 'WATER', 'GAS']).nullable(),
  settlement_month: z.string().regex(/^\d{4}-\d{2}$/, 'Format: YYYY-MM'),
  reading_date: z.string().min(1, 'Chọn ngày chốt'),
  show_unrecorded_only: z.boolean().default(false),
  readings: z.array(z.object({
    meter_id: z.string(),
    current_reading: z.number().min(0, 'Chỉ số >= 0'),
    notes: z.string().optional(),
    meter_image_url: z.string().optional()
  })).min(1, 'Nhập ít nhất 1 chỉ số')
});

export function MeterReadingForm({ isOpen, onClose }) {
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      building_id: '',
      room_id: null,
      meter_type: null,
      settlement_month: getCurrentMonth(),
      reading_date: getCurrentDate(),
      show_unrecorded_only: false,
      readings: []
    }
  });

  const building_id = form.watch('building_id');
  const room_id = form.watch('room_id');
  const meter_type = form.watch('meter_type');
  const settlement_month = form.watch('settlement_month');
  const show_unrecorded_only = form.watch('show_unrecorded_only');

  // Fetch meters based on filters
  const { data: meters } = useMetersWithoutReadings({
    building_id,
    room_id,
    meter_type,
    month: settlement_month,
    enabled: show_unrecorded_only
  });

  const { mutate: createBulkReadings } = useCreateBulkMeterReadings();

  const onSubmit = (data) => {
    createBulkReadings(data.readings, {
      onSuccess: () => {
        toast.success('Ghi chỉ số thành công');
        onClose();
      }
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>GHI CHỈ SỐ</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Filters */}
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="building_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tòa nhà</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn tòa nhà" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {buildings.map(b => (
                          <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="room_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phòng</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn phòng" />
                      </SelectTrigger>
                      <SelectContent>
                        {rooms.map(r => (
                          <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="meter_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại công tơ</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger>
                        <SelectValue placeholder="Loại công tơ" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ELECTRICITY">Điện</SelectItem>
                        <SelectItem value="WATER">Nước</SelectItem>
                        <SelectItem value="GAS">Gas</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="settlement_month"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tháng chốt *</FormLabel>
                    <FormControl>
                      <Input type="month" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="reading_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày chốt *</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="show_unrecorded_only"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                  <FormLabel className="!mt-0">
                    Chỉ hiện công tơ chưa chốt trong tháng
                  </FormLabel>
                </FormItem>
              )}
            />

            {/* Meters table */}
            <div className="border rounded-lg p-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tên công tơ</TableHead>
                    <TableHead>Chỉ số cũ</TableHead>
                    <TableHead>Chỉ số mới</TableHead>
                    <TableHead>Ngày chốt</TableHead>
                    <TableHead>Hình ảnh</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {meters?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        Không có bản ghi nào
                      </TableCell>
                    </TableRow>
                  ) : (
                    meters?.map((meter, index) => (
                      <TableRow key={meter.meter_id}>
                        <TableCell>{meter.meter_name}</TableCell>
                        <TableCell>{meter.last_reading || 0}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            min={meter.last_reading || 0}
                            {...form.register(`readings.${index}.current_reading`, {
                              valueAsNumber: true
                            })}
                          />
                        </TableCell>
                        <TableCell>{form.watch('reading_date')}</TableCell>
                        <TableCell>
                          <ImageUpload
                            onUpload={(url) => form.setValue(`readings.${index}.meter_image_url`, url)}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Actions */}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Hủy
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                Lưu
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

#### 4. **useMeterReadings.ts** (React Query Hook)
```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export function useMeterReadings(filters: MeterReadingFilters) {
  return useQuery({
    queryKey: ['meter-readings', filters],
    queryFn: async () => {
      let query = supabase
        .from('meter_readings_detailed')
        .select('*')
        .order('reading_date', { ascending: false });

      if (filters.building_id) {
        query = query.eq('building_id', filters.building_id);
      }
      if (filters.room_id) {
        query = query.eq('room_id', filters.room_id);
      }
      if (filters.meter_type) {
        query = query.eq('meter_type', filters.meter_type);
      }
      if (filters.month) {
        query = query.eq('settlement_month', filters.month);
      }
      if (filters.status) {
        query = query.eq('status', filters.status);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data;
    }
  });
}

export function useCreateMeterReading() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (reading: CreateMeterReadingInput) => {
      const { data, error } = await supabase
        .from('meter_readings')
        .insert(reading)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter-readings'] });
      queryClient.invalidateQueries({ queryKey: ['meter-reading-stats'] });
    }
  });
}

export function useCreateBulkMeterReadings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (readings: CreateMeterReadingInput[]) => {
      const { data, error } = await supabase.rpc('bulk_create_meter_readings', {
        p_readings: readings
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter-readings'] });
      queryClient.invalidateQueries({ queryKey: ['meter-reading-stats'] });
    }
  });
}

export function useApproveMeterReading() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (readingId: string) => {
      const { error } = await supabase.rpc('approve_meter_reading', {
        p_reading_id: readingId
      });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter-readings'] });
      queryClient.invalidateQueries({ queryKey: ['meter-reading-stats'] });
    }
  });
}

export function useBulkApproveMeterReadings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (readingIds: string[]) => {
      const { data, error } = await supabase.rpc('bulk_approve_meter_readings', {
        p_reading_ids: readingIds
      });

      if (error) throw error;
      return data; // Returns count of approved readings
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meter-readings'] });
      queryClient.invalidateQueries({ queryKey: ['meter-reading-stats'] });
    }
  });
}

export function useMeterReadingStats(filters: { building_id?: string; month?: string }) {
  return useQuery({
    queryKey: ['meter-reading-stats', filters],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_meter_reading_stats', {
        p_building_id: filters.building_id || null,
        p_month: filters.month || null
      });

      if (error) throw error;
      return data[0]; // Function returns single row
    }
  });
}

export function useMetersWithoutReadings(filters: {
  building_id?: string;
  room_id?: string;
  meter_type?: string;
  month?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['meters-without-readings', filters],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_meters_without_readings', {
        p_user_id: (await supabase.auth.getUser()).data.user?.id,
        p_building_id: filters.building_id || null,
        p_room_id: filters.room_id || null,
        p_meter_type: filters.meter_type || null,
        p_month: filters.month || null
      });

      if (error) throw error;
      return data;
    },
    enabled: filters.enabled !== false
  });
}
```

---

## 📝 IMPLEMENTATION STEPS

### Phase 1: Database Setup (Day 1)
**Status:** ✅ COMPLETED

- [x] Create migration 016: meter_readings enhancements
- [x] Create migration 017: meters table
- [x] Create migration 018: link meter_readings with meters
- [x] Test migrations locally
- [x] Deploy migrations to production

### Phase 2: Backend API (Day 2-3)

#### Step 1: Supabase RLS Policies
```sql
-- Verify RLS policies are enabled
-- meters: ✅ Already configured in migration 017
-- meter_readings: ✅ Already configured in migration 005 + 016
```

#### Step 2: Test Database Functions
```sql
-- Test in Supabase SQL Editor
SELECT * FROM get_meters_without_readings(
  auth.uid(),
  NULL, -- building_id
  NULL, -- room_id
  NULL, -- meter_type
  '2025-11' -- month
);

SELECT * FROM get_meter_reading_stats(
  NULL, -- building_id
  '2025-11' -- month
);

SELECT approve_meter_reading('reading-uuid');

SELECT bulk_approve_meter_readings(ARRAY['uuid1', 'uuid2']);
```

#### Step 3: Create Supabase Edge Functions (Optional)
If you need custom business logic beyond direct Supabase queries:

```bash
# Create edge functions
supabase functions new meter-readings-import
supabase functions new meter-readings-export

# Deploy
supabase functions deploy meter-readings-import
supabase functions deploy meter-readings-export
```

### Phase 3: Frontend Components (Day 4-7)

#### Day 4: Setup & Base Components
- [ ] Create folder structure: `src/features/meter-readings/`
- [ ] Define TypeScript types in `meter-reading.types.ts`
- [ ] Create Zod validation schemas
- [ ] Setup React Query hooks (`useMeterReadings`, `useMeters`)
- [ ] Create base UI components:
  - [ ] `MeterReadingsPage.tsx` (main page layout)
  - [ ] `MeterReadingFilters.tsx` (building, room, type, month filters)

#### Day 5: List & Table
- [ ] Implement `MeterReadingList.tsx` with TanStack Table
- [ ] Add columns: Mã, Thao tác, Công tơ, Chỉ số đầu, Chỉ số cuối, Tiêu thụ, Ngày chốt, Người chốt
- [ ] Add row selection (checkboxes)
- [ ] Implement actions: View, Edit, Delete
- [ ] Add pagination
- [ ] Add bulk approval button (when rows selected)

#### Day 6: Create/Edit Form
- [ ] Implement `MeterReadingForm.tsx` modal
- [ ] Add cascading filters (Building → Room → Meter Type)
- [ ] Implement toggle "Chỉ hiện công tơ chưa chốt trong tháng"
- [ ] Fetch and display meters in table
- [ ] Allow input for multiple meters at once
- [ ] Add image upload for meter photos
- [ ] Implement form submission (bulk create)
- [ ] Add validation and error handling

#### Day 7: Import/Export & Stats
- [ ] Implement `MeterReadingStats.tsx` (statistics cards)
- [ ] Create `MeterReadingImportDialog.tsx`:
  - [ ] Download template button
  - [ ] File upload (Excel/CSV)
  - [ ] Preview imported data
  - [ ] Submit import
  - [ ] Show import results (success/failed)
- [ ] Create `MeterReadingExportButton.tsx`:
  - [ ] Export to Excel
  - [ ] Export to CSV
- [ ] Add loading states and error handling

### Phase 4: Meters Management (Day 8-9)

#### Day 8: Meters CRUD
- [ ] Create `src/features/meters/` folder structure
- [ ] Implement `MetersPage.tsx`
- [ ] Create `MeterList.tsx` (table of all meters)
- [ ] Create `MeterForm.tsx` (create/edit meter)
- [ ] Add meter status management (ACTIVE, INACTIVE, BROKEN, REMOVED)

#### Day 9: Meters Integration
- [ ] Link meters page to main navigation
- [ ] Add "Manage Meters" button in meter readings page
- [ ] Implement meter details view
- [ ] Show meter reading history for each meter

### Phase 5: Testing & Polish (Day 10-11)

#### Day 10: Testing
- [ ] Unit tests for utility functions
- [ ] Integration tests for React Query hooks
- [ ] Component tests for forms
- [ ] E2E tests for critical flows:
  - [ ] Create single meter reading
  - [ ] Bulk create meter readings
  - [ ] Approve single reading
  - [ ] Bulk approve readings
  - [ ] Import from Excel
  - [ ] Export to Excel

#### Day 11: Polish & Documentation
- [ ] Add loading skeletons
- [ ] Improve error messages
- [ ] Add success toasts
- [ ] Optimize performance (debounce filters, virtualization if needed)
- [ ] Write user documentation
- [ ] Record demo video

### Phase 6: Deployment (Day 12)
- [ ] Code review
- [ ] Merge to main branch
- [ ] Deploy database migrations
- [ ] Deploy frontend
- [ ] Monitor for errors
- [ ] Gather user feedback

---

## 🧪 TESTING PLAN

### Database Testing

#### Test Migrations
```sql
-- Test meter creation
INSERT INTO meters (user_id, code, building_id, room_id, service_id, meter_type)
VALUES (auth.uid(), 'TEST-001', 'building-uuid', 'room-uuid', 'service-uuid', 'ELECTRICITY');

-- Test meter reading creation with auto-fields
INSERT INTO meter_readings (user_id, meter_id, reading_date, current_reading)
VALUES (auth.uid(), 'meter-uuid', '2025-11-21', 100.5);

-- Verify auto-population
SELECT
  reading_code,     -- Should be auto-generated (CSS...)
  meter_id,         -- Should be provided
  previous_reading, -- Should be auto-populated from last reading
  consumption,      -- Should be auto-calculated
  settlement_month, -- Should be '2025-11'
  status           -- Should be 'UNAPPROVED'
FROM meter_readings
WHERE id = 'new-reading-uuid';

-- Test approval
SELECT approve_meter_reading('reading-uuid');

-- Verify approval
SELECT status, approved_by, approved_at
FROM meter_readings
WHERE id = 'reading-uuid';
-- status should be 'APPROVED', approved_by and approved_at should be set

-- Test get meters without readings
SELECT * FROM get_meters_without_readings(
  auth.uid(),
  'building-uuid',
  NULL,
  'ELECTRICITY',
  '2025-11'
);
-- Should return only meters without readings in Nov 2025

-- Test statistics
SELECT * FROM get_meter_reading_stats('building-uuid', '2025-11');
-- Should return correct counts and consumption totals
```

### API Testing

#### Use Postman/Insomnia/Thunder Client

```bash
# 1. Get meters without readings
GET /rest/v1/rpc/get_meters_without_readings
Body: {
  "p_user_id": "user-uuid",
  "p_building_id": "building-uuid",
  "p_month": "2025-11"
}

# 2. Create meter reading
POST /rest/v1/meter_readings
Body: {
  "meter_id": "meter-uuid",
  "reading_date": "2025-11-21",
  "current_reading": 150.5,
  "notes": "Test reading"
}

# 3. Get meter readings with filters
GET /rest/v1/meter_readings_detailed?settlement_month=eq.2025-11&status=eq.UNAPPROVED

# 4. Approve reading
POST /rest/v1/rpc/approve_meter_reading
Body: {
  "p_reading_id": "reading-uuid"
}

# 5. Bulk approve
POST /rest/v1/rpc/bulk_approve_meter_readings
Body: {
  "p_reading_ids": ["uuid1", "uuid2", "uuid3"]
}

# 6. Get statistics
POST /rest/v1/rpc/get_meter_reading_stats
Body: {
  "p_building_id": "building-uuid",
  "p_month": "2025-11"
}
```

### Frontend Testing

#### Manual Testing Checklist

**Meter Reading List:**
- [ ] List loads with correct data
- [ ] Filters work correctly (building, room, meter type, month, status)
- [ ] Search works
- [ ] Sorting works
- [ ] Pagination works
- [ ] Row selection works
- [ ] Actions (view, edit, delete) work
- [ ] Bulk approve works
- [ ] Export works

**Create Meter Reading:**
- [ ] Modal opens/closes correctly
- [ ] Building filter loads buildings
- [ ] Selecting building loads rooms
- [ ] Selecting room + meter type loads meters
- [ ] Toggle "unrecorded only" filters correctly
- [ ] Previous reading shows correctly for each meter
- [ ] Current reading input validates (>= previous)
- [ ] Image upload works
- [ ] Form submission creates readings
- [ ] Success message displays
- [ ] List refreshes with new readings

**Import:**
- [ ] Template download works
- [ ] File upload accepts Excel/CSV
- [ ] Preview shows correct data
- [ ] Import processes file
- [ ] Results show success/failed counts
- [ ] Error messages are clear
- [ ] List refreshes after import

**Approval:**
- [ ] Single approve button works
- [ ] Bulk approve works for selected rows
- [ ] Approved readings show green badge
- [ ] Edit/delete disabled for approved readings
- [ ] Statistics update after approval

**Statistics:**
- [ ] Total readings count correct
- [ ] Unapproved count correct
- [ ] Approved count correct
- [ ] Consumption totals correct by type
- [ ] Stats update when filters change

#### Automated Tests (Jest + React Testing Library)

```typescript
// Example: MeterReadingForm.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeterReadingForm } from './MeterReadingForm';

describe('MeterReadingForm', () => {
  it('should render form with all fields', () => {
    render(<MeterReadingForm isOpen={true} onClose={jest.fn()} />);

    expect(screen.getByLabelText('Tòa nhà')).toBeInTheDocument();
    expect(screen.getByLabelText('Phòng')).toBeInTheDocument();
    expect(screen.getByLabelText('Loại công tơ')).toBeInTheDocument();
    expect(screen.getByLabelText('Tháng chốt')).toBeInTheDocument();
    expect(screen.getByLabelText('Ngày chốt')).toBeInTheDocument();
  });

  it('should load meters when filters change', async () => {
    const { getByLabelText } = render(<MeterReadingForm isOpen={true} onClose={jest.fn()} />);

    // Select building
    await userEvent.selectOptions(getByLabelText('Tòa nhà'), 'building-1');

    // Wait for meters to load
    await waitFor(() => {
      expect(screen.getByText('CTD-201')).toBeInTheDocument();
    });
  });

  it('should validate current reading >= previous reading', async () => {
    render(<MeterReadingForm isOpen={true} onClose={jest.fn()} />);

    // Enter current reading < previous
    const input = screen.getByLabelText('Chỉ số mới');
    await userEvent.type(input, '50'); // Previous is 100

    // Try to submit
    await userEvent.click(screen.getByText('Lưu'));

    // Should show validation error
    expect(screen.getByText('Chỉ số mới phải >= chỉ số cũ')).toBeInTheDocument();
  });

  it('should submit form successfully', async () => {
    const onClose = jest.fn();
    const { getByLabelText, getByText } = render(
      <MeterReadingForm isOpen={true} onClose={onClose} />
    );

    // Fill form
    await userEvent.selectOptions(getByLabelText('Tòa nhà'), 'building-1');
    await userEvent.type(getByLabelText('Chỉ số mới'), '150');

    // Submit
    await userEvent.click(getByText('Lưu'));

    // Should close and show success
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
```

---

## ✅ DEPLOYMENT CHECKLIST

### Pre-Deployment
- [ ] All migrations tested locally
- [ ] All API endpoints tested
- [ ] All frontend components tested
- [ ] Code reviewed and approved
- [ ] Documentation updated
- [ ] Demo video recorded

### Database Deployment
- [ ] Backup production database
- [ ] Run migrations in staging environment
- [ ] Verify migrations in staging
- [ ] Run migrations in production
- [ ] Verify migrations in production
- [ ] Test database functions in production

### Frontend Deployment
- [ ] Build frontend (`npm run build`)
- [ ] Test build locally
- [ ] Deploy to staging
- [ ] Test in staging environment
- [ ] Deploy to production
- [ ] Test in production environment

### Post-Deployment
- [ ] Monitor error logs
- [ ] Check performance metrics
- [ ] Gather user feedback
- [ ] Create issues for bugs/improvements
- [ ] Update changelog

---

## 📚 REFERENCE LINKS

- **UI Design:** https://docs.resident.vn/quan-ly-and-van-hanh/tai-chinh/ghi-chi-so
- **Database Migrations:**
  - `supabase/migrations/016_meter_readings_enhancements.sql`
  - `supabase/migrations/017_meters_table.sql`
  - `supabase/migrations/018_meter_readings_add_meter_link.sql`
- **Supabase Docs:** https://supabase.com/docs
- **TanStack Table:** https://tanstack.com/table
- **React Hook Form:** https://react-hook-form.com
- **Zod:** https://zod.dev

---

## 🎯 SUCCESS METRICS

### Must Have (MVP)
- ✅ Users can create meter readings individually
- ✅ Users can view list of meter readings with filters
- ✅ Users can approve meter readings (single and bulk)
- ✅ System auto-calculates previous reading and consumption
- ✅ System auto-generates reading codes

### Should Have
- ✅ Users can import meter readings from Excel
- ✅ Users can export meter readings to Excel
- ✅ Dashboard shows statistics (total, approved, unapproved, consumption)
- ✅ Users can manage meters (CRUD)
- ✅ Form shows only unrecorded meters when toggle enabled

### Nice to Have
- ⏳ Mobile app for meter reading (future)
- ⏳ OCR for automatic meter reading from photos (future)
- ⏳ Email/SMS notifications for unrecorded meters (future)
- ⏳ Automatic meter reading schedule reminders (future)

---

**Last Updated:** 2025-11-21
**Status:** Ready for Implementation
**Estimated Timeline:** 12 days
