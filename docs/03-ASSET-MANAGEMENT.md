# ASSET MANAGEMENT
## Buildings, Rooms, Beds & Services Management

---

## 📋 MỤC LỤC

1. [Tổng quan](#tổng-quan)
2. [Building Hierarchy](#building-hierarchy)
3. [Flow tạo Building](#flow-tạo-building)
4. [Flow tạo Room](#flow-tạo-room)
5. [Flow tạo Bed](#flow-tạo-bed-ktxsleepbox)
6. [Flow quản lý Services](#flow-quản-lý-services)
7. [Import/Export Excel](#importexport-excel)
8. [Building Map Visualization](#building-map-visualization)
9. [Component Examples](#component-examples)
10. [API Integration & Hooks](#api-integration--hooks)
11. [Testing Checklist](#testing-checklist)

---

## 🎯 TỔNG QUAN

### Mục tiêu
Xây dựng hệ thống quản lý tài sản bất động sản với hierarchy Building → Room → Bed

### Tính năng
- ✅ Quản lý Buildings (tòa nhà, khu vực)
- ✅ Quản lý Rooms (phòng, căn hộ)
- ✅ Quản lý Beds (giường, chỗ ở cho KTX/Sleepbox)
- ✅ 4 loại Services: Fixed, Per Person, Per Room, Meter Reading
- ✅ Import/Export Excel
- ✅ Building Map visualization
- ✅ Pricing & Amenities management

### Database Schema

```
Buildings (Tòa nhà)
├── id (UUID)
├── organization_id (FK)
├── name (String)
├── address (String)
├── map_latitude, map_longitude (Decimal)
├── total_rooms (Integer)
├── created_at, updated_at

Rooms (Phòng)
├── id (UUID)
├── building_id (FK)
├── room_number (String, unique per building)
├── room_type (studio, 1bed, 2bed, dormitory)
├── floor (Integer)
├── area (Decimal, m²)
├── capacity (Integer, max persons)
├── status (available, occupied, maintenance)
├── base_price (Decimal)
├── created_at, updated_at

Beds (Giường - cho KTX/Sleepbox)
├── id (UUID)
├── room_id (FK)
├── bed_number (String)
├── bed_type (single, double, bunk)
├── status (available, occupied)
├── created_at, updated_at

Services (Dịch vụ)
├── id (UUID)
├── organization_id (FK)
├── name (String)
├── service_type (FIXED, PER_PERSON, PER_ROOM, METER_READING)
├── price (Decimal)
├── description (Text)
├── created_at, updated_at
```

---

## 🏢 BUILDING HIERARCHY

```
Organization
    │
    ├─→ Building 1 (Tòa A)
    │       │
    │       ├─→ Room 1A (studio)
    │       │       ├─→ Service: WiFi (PER_ROOM)
    │       │       └─→ Service: Cleaning (FIXED)
    │       │
    │       ├─→ Room 2A (2-bed)
    │       │       ├─→ Bed 2A-1 (single)
    │       │       └─→ Bed 2A-2 (double)
    │       │
    │       └─→ Room 3A (dormitory, 6-bed)
    │               ├─→ Bed 3A-1 (bunk)
    │               ├─→ Bed 3A-2 (bunk)
    │               └─→ ... (6 beds total)
    │
    └─→ Building 2 (Tòa B)
            └─→ Room 1B
```

---

## 📝 FLOW TẠO BUILDING

### User Journey

```
Vào trang Buildings
      │
      ├─→ Click "Thêm Tòa nhà mới"
      │
      ├─→ Form nhập thông tin:
      │   ├─ Tên tòa nhà (*)
      │   ├─ Địa chỉ (*)
      │   ├─ Vị trí (tọa độ GPS)
      │   ├─ Số phòng tối đa
      │   └─ Mô tả
      │
      ├─→ Validate & Submit
      │   ├─ Gọi API: POST /buildings
      │   └─ Tạo record trong database
      │
      ├─→ Thành công
      │   ├─ Hiển thị toast "Tạo thành công"
      │   └─ Redirect → Building Detail
      │
      └─→ Thất bại
          └─ Hiển thị lỗi
```

### Validation Schema

```typescript
const createBuildingSchema = z.object({
  name: z.string().min(1, 'Tên tòa nhà không được rỗng'),
  address: z.string().min(10, 'Địa chỉ phải có ít nhất 10 ký tự'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  total_rooms: z.number().int().min(1).optional(),
  description: z.string().optional(),
});
```

### API Flow

```typescript
// Request
POST /buildings
{
  "name": "Tòa nhà A",
  "address": "123 Nguyễn Huệ, Q.1, TP.HCM",
  "latitude": 10.7769,
  "longitude": 106.6955,
  "total_rooms": 20,
  "description": "Tòa nhà cao cấp"
}

// Response (201)
{
  "id": "uuid",
  "organization_id": "org-uuid",
  "name": "Tòa nhà A",
  "address": "123 Nguyễn Huệ",
  "latitude": 10.7769,
  "longitude": 106.6955,
  "total_rooms": 20,
  "created_at": "2025-11-18T10:00:00Z"
}
```

---

## 🚪 FLOW TẠO ROOM

### User Journey

```
Vào trang Rooms (của 1 Building)
      │
      ├─→ Click "Thêm Phòng mới"
      │
      ├─→ Form nhập thông tin:
      │   ├─ Số phòng (*) - auto suggestion
      │   ├─ Loại phòng (*) - dropdown
      │   ├─ Tầng (*)
      │   ├─ Diện tích (m²)
      │   ├─ Sức chứa người (*)
      │   ├─ Giá cơ sở
      │   ├─ Tiện nghi - checkbox list
      │   │   ├─ WiFi
      │   │   ├─ AC
      │   │   ├─ TV
      │   │   └─ ...
      │   └─ Dịch vụ bao gồm - multiselect
      │
      ├─→ Validate & Submit
      │   └─ Gọi API: POST /rooms
      │
      └─→ Thành công
          └─ Redirect → Room Detail
```

### Validation Schema

```typescript
const createRoomSchema = z.object({
  building_id: z.string().uuid('Building ID không hợp lệ'),
  room_number: z.string().min(1, 'Số phòng không được rỗng'),
  room_type: z.enum(['studio', '1bed', '2bed', 'dormitory']),
  floor: z.number().int().min(0),
  area: z.number().min(10, 'Diện tích tối thiểu 10m²'),
  capacity: z.number().int().min(1),
  base_price: z.number().min(0).optional(),
  amenities: z.array(z.string()).optional(),
  included_services: z.array(z.string()).optional(),
});
```

---

## 🛏️ FLOW TẠO BED (KTX/SLEEPBOX)

### Use Case
Dùng cho mô hình KTX (ký túc xá) hoặc Sleepbox - nhiều giường trong 1 phòng

### User Journey

```
Vào trang Beds (của 1 Room)
      │
      ├─→ Click "Thêm Giường mới"
      │
      ├─→ Form nhập thông tin:
      │   ├─ Số giường (*) - auto (B1, B2, ...)
      │   ├─ Loại giường (*) - single, double, bunk
      │   ├─ Giá (nếu khác phòng)
      │   └─ Ghi chú
      │
      ├─→ Submit & Add Multiple
      │   ├─ Add 1 giường
      │   └─ Option "Thêm tiếp" hoặc "Tạo xong"
      │
      └─→ Hiển thị danh sách giường
          └─ Cho phép chỉnh sửa/xóa
```

### Bulk Create Example

```typescript
// Tạo 6 giường cho 1 phòng dormitory
const beds = [
  { room_id: 'room-uuid', bed_number: 'B1', bed_type: 'bunk' },
  { room_id: 'room-uuid', bed_number: 'B2', bed_type: 'bunk' },
  // ... B3-B6
];

POST /beds/bulk
{
  "beds": beds
}
```

---

## 🔧 FLOW QUẢN LÝ SERVICES

### 4 Loại Services

```
1. FIXED (Cố định)
   └─ Giá: Số tiền cố định
   └─ Ví dụ: Internet = 100.000/tháng
   └─ Tính toán: 100.000

2. PER_PERSON (Theo người)
   └─ Giá: Tiền/người
   └─ Ví dụ: Cleaning = 10.000/người/tháng
   └─ Tính toán: 10.000 x số người

3. PER_ROOM (Theo phòng)
   └─ Giá: Tiền/phòng
   └─ Ví dụ: WiFi = 50.000/phòng/tháng
   └─ Tính toán: 50.000

4. METER_READING (Theo chỉ số)
   └─ Giá: Tiền/đơn vị (kWh, m³)
   └─ Ví dụ: Điện = 5.000/kWh
   └─ Tính toán: Chỉ số sau - Chỉ số trước
```

### Create Service Form

```typescript
const createServiceSchema = z.object({
  name: z.string().min(1, 'Tên dịch vụ không được rỗng'),
  service_type: z.enum(['FIXED', 'PER_PERSON', 'PER_ROOM', 'METER_READING']),
  price: z.number().min(0),
  unit: z.string().optional(), // e.g., 'kWh', 'm³'
  description: z.string().optional(),
  is_active: z.boolean().default(true),
});
```

---

## 📊 IMPORT/EXPORT EXCEL

### Import Buildings

```
Columns:
├─ Tên tòa nhà (Name)
├─ Địa chỉ (Address)
├─ Tọa độ (Latitude, Longitude)
├─ Số phòng (Total Rooms)
└─ Mô tả (Description)

Example:
Name              | Address          | Lat      | Lon      | Rooms
Tòa A             | 123 Nguyễn Huệ   | 10.7769  | 106.6955 | 20
Tòa B             | 456 Lê Lợi       | 10.7770  | 106.6956 | 15
```

### Import Rooms

```
Columns:
├─ Tòa nhà (Building Name)
├─ Số phòng (Room Number)
├─ Loại phòng (Room Type)
├─ Tầng (Floor)
├─ Diện tích (Area m²)
├─ Sức chứa (Capacity)
├─ Giá cơ sở (Base Price)
└─ Tiện nghi (Amenities)

Example:
Building | Room | Type      | Floor | Area | Capacity | Price
Tòa A    | 101  | studio    | 1     | 25   | 1        | 3000000
Tòa A    | 102  | 1bed      | 1     | 35   | 2        | 4500000
```

### Export Implementation

```typescript
// Using SheetJS (xlsx)
import { utils, writeFile } from 'xlsx';

const exportBuildings = (buildings: Building[]) => {
  const ws = utils.json_to_sheet(buildings);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Buildings');
  writeFile(wb, 'buildings.xlsx');
};

const exportRooms = (rooms: Room[]) => {
  const data = rooms.map(r => ({
    'Tòa nhà': r.building.name,
    'Số phòng': r.room_number,
    'Loại': r.room_type,
    'Tầng': r.floor,
    'Diện tích': r.area,
    'Sức chứa': r.capacity,
    'Giá': r.base_price,
  }));

  const ws = utils.json_to_sheet(data);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Rooms');
  writeFile(wb, 'rooms.xlsx');
};

const importRooms = async (file: File) => {
  const workbook = await readFile(file);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = utils.sheet_to_json(sheet);
  // Validate & insert to DB
};
```

---

## 🗺️ BUILDING MAP VISUALIZATION

### Using Leaflet + React-Leaflet

```typescript
// Map Component
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

export function BuildingMap({ buildings }: { buildings: Building[] }) {
  const center: [number, number] = [10.7769, 106.6955]; // HCM default

  return (
    <MapContainer center={center} zoom={13} style={{ height: '500px' }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap contributors'
      />
      {buildings.map(building => (
        <Marker
          key={building.id}
          position={[building.latitude, building.longitude]}
        >
          <Popup>
            <div className="font-bold">{building.name}</div>
            <div className="text-sm">{building.address}</div>
            <div className="text-sm">Phòng: {building.total_rooms}</div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
```

---

## 💻 COMPONENT EXAMPLES

### CreateBuildingDialog

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useCreateBuilding } from '@/hooks/useBuildings';

const schema = z.object({
  name: z.string().min(1, 'Tên không được rỗng'),
  address: z.string().min(10, 'Địa chỉ ít nhất 10 ký tự'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  total_rooms: z.number().int().positive().optional(),
  description: z.string().optional(),
});

export function CreateBuildingDialog({ open, onOpenChange }: Props) {
  const { mutate: createBuilding, isPending } = useCreateBuilding();

  const form = useForm({
    resolver: zodResolver(schema),
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    createBuilding(data, {
      onSuccess: () => {
        toast.success('Tạo tòa nhà thành công');
        onOpenChange(false);
        form.reset();
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thêm Tòa nhà mới</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên tòa nhà *</FormLabel>
                  <FormControl>
                    <Input placeholder="Tòa A, Tòa B, ..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Địa chỉ *</FormLabel>
                  <FormControl>
                    <Input placeholder="123 Nguyễn Huệ, Q.1, TP.HCM" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="latitude"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Latitude</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.0001" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="longitude"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Longitude</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.0001" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="total_rooms"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Số phòng tối đa</FormLabel>
                  <FormControl>
                    <Input type="number" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Mô tả chi tiết tòa nhà" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? 'Đang tạo...' : 'Tạo Tòa nhà'}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

### CreateRoomDialog

```typescript
export function CreateRoomDialog({ buildingId, open, onOpenChange }: Props) {
  const form = useForm({
    resolver: zodResolver(createRoomSchema),
    defaultValues: {
      building_id: buildingId,
      room_type: 'studio',
      amenities: [],
      included_services: [],
    },
  });

  const { mutate: createRoom, isPending } = useCreateRoom();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Thêm Phòng mới</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit((data) => createRoom(data))} className="space-y-4">
            {/* Số phòng */}
            <FormField control={form.control} name="room_number" render={/* ... */} />

            {/* Loại phòng */}
            <FormField
              control={form.control}
              name="room_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Loại phòng *</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="studio">Studio</SelectItem>
                      <SelectItem value="1bed">1 giường</SelectItem>
                      <SelectItem value="2bed">2 giường</SelectItem>
                      <SelectItem value="dormitory">Ký túc xá</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />

            {/* Tiện nghi - Checkbox */}
            <FormField
              control={form.control}
              name="amenities"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tiện nghi</FormLabel>
                  <div className="space-y-2">
                    {['WiFi', 'AC', 'TV', 'Refrigerator', 'Washing Machine'].map(amenity => (
                      <div key={amenity} className="flex items-center">
                        <input
                          type="checkbox"
                          value={amenity}
                          checked={field.value.includes(amenity)}
                          onChange={(e) => {
                            const value = e.target.value;
                            field.onChange(
                              e.target.checked
                                ? [...field.value, value]
                                : field.value.filter(a => a !== value)
                            );
                          }}
                        />
                        <label className="ml-2">{amenity}</label>
                      </div>
                    ))}
                  </div>
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? 'Đang tạo...' : 'Tạo Phòng'}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

---

## 🔌 API INTEGRATION & HOOKS

### useBuildings Hook

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export function useBuildings(organizationId: string) {
  return useQuery({
    queryKey: ['buildings', organizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('buildings')
        .select('*')
        .eq('organization_id', organizationId)
        .order('name');

      if (error) throw error;
      return data;
    },
  });
}

export function useCreateBuilding() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: CreateBuildingInput) => {
      const { data: building, error } = await supabase
        .from('buildings')
        .insert([
          {
            ...data,
            organization_id: user?.user_metadata?.organization_id,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      return building;
    },
    onSuccess: (newBuilding) => {
      queryClient.invalidateQueries({ queryKey: ['buildings'] });
    },
  });
}

export function useUpdateBuilding(buildingId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: UpdateBuildingInput) => {
      const { data: updated, error } = await supabase
        .from('buildings')
        .update(data)
        .eq('id', buildingId)
        .select()
        .single();

      if (error) throw error;
      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buildings', buildingId] });
    },
  });
}

export function useDeleteBuilding() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (buildingId: string) => {
      const { error } = await supabase
        .from('buildings')
        .delete()
        .eq('id', buildingId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buildings'] });
    },
  });
}
```

### useRooms Hook

```typescript
export function useRooms(buildingId: string) {
  return useQuery({
    queryKey: ['rooms', buildingId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select(`
          *,
          building:buildings(name),
          beds:beds(*)
        `)
        .eq('building_id', buildingId)
        .order('room_number');

      if (error) throw error;
      return data;
    },
  });
}

export function useCreateRoom() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateRoomInput) => {
      const { data: room, error } = await supabase
        .from('rooms')
        .insert([data])
        .select()
        .single();

      if (error) throw error;
      return room;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['rooms', variables.building_id] });
    },
  });
}
```

### useServices Hook

```typescript
export function useServices(organizationId: string) {
  return useQuery({
    queryKey: ['services', organizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('services')
        .select('*')
        .eq('organization_id', organizationId)
        .order('name');

      if (error) throw error;
      return data;
    },
  });
}

export function useCreateService() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: CreateServiceInput) => {
      const { data: service, error } = await supabase
        .from('services')
        .insert([
          {
            ...data,
            organization_id: user?.user_metadata?.organization_id,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      return service;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
    },
  });
}
```

---

## 🧪 TESTING CHECKLIST

### Buildings
- [ ] Tạo building với đầy đủ thông tin
- [ ] Tạo building chỉ với required fields
- [ ] Validate tọa độ GPS (lat/long)
- [ ] Xóa building - hiển thị confirmation dialog
- [ ] Xóa building - kiểm tra cascade delete (xóa rooms, beds)
- [ ] Edit building thông tin
- [ ] View building detail với danh sách rooms

### Rooms
- [ ] Tạo room với tất cả loại phòng (studio, 1bed, 2bed, dormitory)
- [ ] Validate số phòng unique trong building
- [ ] Thêm tiện nghi multiple
- [ ] Thêm dịch vụ bao gồm
- [ ] Xem danh sách beds trong room
- [ ] Update room status (available, occupied, maintenance)
- [ ] Upload room image/gallery

### Beds
- [ ] Tạo single bed
- [ ] Tạo double bed, bunk bed
- [ ] Bulk create beds cho dormitory (6-8 beds)
- [ ] Update bed status
- [ ] Delete bed - check availability
- [ ] Link bed → tenant

### Services
- [ ] Tạo FIXED service (Internet)
- [ ] Tạo PER_PERSON service (Cleaning)
- [ ] Tạo PER_ROOM service (WiFi)
- [ ] Tạo METER_READING service (Electricity)
- [ ] Tính giá dựa trên service_type
- [ ] Apply service tới room/building
- [ ] Remove service từ room

### Import/Export
- [ ] Export Buildings tới Excel
- [ ] Export Rooms tới Excel
- [ ] Import Buildings từ Excel (validate dữ liệu)
- [ ] Import Rooms từ Excel (validate dữ liệu)
- [ ] Handle error: duplicate room number
- [ ] Handle error: building not found

### Map
- [ ] Hiển thị map với markers
- [ ] Click marker → show popup
- [ ] Zoom/Pan map
- [ ] Filter buildings trên map
- [ ] Show building stats (tổng phòng, occupied)

---

## 📝 NOTES

### Key Implementation Points
1. Validate room_number unique per building using DB constraint
2. Auto-calculate room status based on bed occupancy
3. For METER_READING services, create separate table for meter readings
4. Store amenities as JSON array
5. Use Zod for both client & server validation

### Performance Optimization
- Paginate rooms list (default 10 per page)
- Use Select nested queries efficiently
- Implement caching with React Query
- Lazy load map component

### Error Handling
```typescript
function handleAssetError(error: any) {
  if (error.message.includes('duplicate key')) {
    return 'Số phòng này đã tồn tại trong tòa nhà';
  }
  if (error.message.includes('foreign key')) {
    return 'Tòa nhà không tồn tại';
  }
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}
```

---

## 🎯 NEXT STEPS

1. ✅ Create asset management structure
2. 📄 Continue to [04-TENANT-MANAGEMENT.md](./04-TENANT-MANAGEMENT.md)
3. 🔜 Implement Meter Reading feature
4. 🔜 Add Building Statistics dashboard

---

**Last updated**: 2025-11-18
**Version**: 1.0.0
**Previous**: [02-AUTH-FLOW.md](./02-AUTH-FLOW.md) | **Next**: [04-TENANT-MANAGEMENT.md](./04-TENANT-MANAGEMENT.md)
