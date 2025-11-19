# Supabase Migrations - iHomeCRM

## 📋 Overview

This directory contains all database migrations for the iHomeCRM property management system.

**Total Migrations**: 9
**Total Tables**: 30
**Total Enums**: 28
**Total Functions**: 8
**Total Triggers**: 28

---

## 🗂️ Migration Files

| File | Description | Tables Created |
|------|-------------|----------------|
| `001_extensions_and_enums.sql` | Database extensions & 28 enum types | - |
| `002_core_tables_part1.sql` | Core tables for assets | profiles, areas, buildings, rooms, beds |
| `003_core_tables_part2.sql` | Services and tenant management | services, tenants, deposits, vehicles |
| `004_contract_tables.sql` | Contract management | contracts, contract_services |
| `005_billing_tables.sql` | Billing and finance | invoices, invoice_items, payments, meter_readings, expenses |
| `006_asset_issue_tables.sql` | Inventory and issue tracking | asset_categories, suppliers, assets, asset_handovers, asset_movements, asset_maintenance, issue_categories, issues, issue_comments |
| `007_advanced_tables.sql` | Advanced features | leads, settings, signature_templates, code_sequences, notification_templates, notifications, notification_logs |
| `008_triggers_functions.sql` | Automation logic | 8 functions, 28 triggers |
| `009_seed_data.sql` | Sample data (optional) | - |

---

## 🚀 How to Run Migrations

### Option 1: Supabase Dashboard (Recommended)

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Copy and paste each migration file in order (001 → 009)
4. Run each migration

### Option 2: Supabase CLI

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Link to your project
supabase link --project-ref your-project-ref

# Run all migrations
supabase db push
```

### Option 3: Manual SQL

```bash
# Using psql
psql -h db.your-project-ref.supabase.co \
     -U postgres \
     -d postgres \
     -f supabase/migrations/001_extensions_and_enums.sql

# Repeat for each migration file
```

---

## 📊 Database Schema

### Entity Relationship Diagram

```
auth.users (Supabase)
    ├── profiles (user profiles)
    ├── areas (geographic zones)
    │   └── buildings (properties)
    │       └── rooms (rental units)
    │           └── beds (for dormitories)
    ├── services (electricity, water, etc.)
    ├── tenants (customers)
    │   ├── deposits (holding deposits)
    │   ├── vehicles (parking management)
    │   └── contracts (rental agreements)
    │       ├── contract_services
    │       ├── invoices
    │       │   ├── invoice_items
    │       │   └── payments
    │       └── meter_readings
    ├── assets (inventory)
    │   ├── asset_handovers
    │   ├── asset_movements
    │   └── asset_maintenance
    ├── issues (task tracking)
    │   └── issue_comments
    ├── leads (sales funnel)
    ├── notifications
    └── expenses (cash book)
```

---

## 🔐 Row Level Security (RLS)

All tables have RLS enabled with the following policies:

- **SELECT**: Users can only view their own data
- **INSERT**: Users can only insert with their own user_id
- **UPDATE**: Users can only update their own data
- **DELETE**: Users can only delete their own data

### Example Policy

```sql
CREATE POLICY "Users can view own buildings"
  ON buildings FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);
```

---

## ⚙️ Automation Features

### 1. Auto-Update Timestamps

All tables with `updated_at` automatically update on record modification.

### 2. Auto-Calculate Fields

- `buildings.total_rooms` - Auto-count rooms
- `contracts.deposit_remaining` - Auto-calculate remaining deposit
- `invoices.remaining_amount` - Auto-calculate unpaid amount
- `meter_readings.consumption` - Auto-calculate usage

### 3. Auto-Generate Numbers

- Invoice numbers: `INV-2024-00001`
- Contract numbers: `HD-2024-00001`
- Customizable via `code_sequences` table

### 4. Status Synchronization

- Room/bed status auto-updates based on contract status
- Invoice status auto-updates based on payments

---

## 🧪 Sample Data (Optional)

Migration `009_seed_data.sql` contains commented sample data for testing.

To use:

1. Open `009_seed_data.sql`
2. Uncomment the code block
3. Replace `'YOUR_USER_ID'` with your actual user ID
4. Run the migration

**Get your user ID**:

```sql
SELECT id FROM auth.users WHERE email = 'your@email.com';
```

---

## 📝 Migration Order

**IMPORTANT**: Run migrations in numerical order (001 → 009)

Dependencies:
```
001 (Enums)
  └── 002 (Core Part 1)
        ├── 003 (Core Part 2)
        │     └── 004 (Contracts)
        │           └── 005 (Billing)
        │           └── 006 (Assets/Issues)
        │           └── 007 (Advanced)
        └── 008 (Triggers/Functions)
              └── 009 (Seed Data - Optional)
```

---

## 🔍 Verification

After running all migrations, verify with:

```sql
-- Count tables
SELECT COUNT(*) FROM information_schema.tables
WHERE table_schema = 'public';
-- Should return: 30

-- Count enum types
SELECT COUNT(*) FROM pg_type
WHERE typtype = 'e';
-- Should return: 28

-- List all tables
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
AND rowsecurity = false;
-- Should return: 0 rows (all tables have RLS)
```

---

## 🛠️ Troubleshooting

### Error: "extension already exists"

This is safe to ignore. Extensions are checked with `IF NOT EXISTS`.

### Error: "relation already exists"

You may have run a migration twice. Either:
- Drop the table and re-run: `DROP TABLE table_name CASCADE;`
- Skip to the next migration

### Error: "foreign key violation"

Ensure you run migrations in order (001 → 009).

### Error: "permission denied for schema public"

Ensure you're connected as `postgres` user or have sufficient privileges.

---

## 📚 Documentation

For detailed schema documentation, see:
- [docs/01-DATABASE-SCHEMA.md](../docs/01-DATABASE-SCHEMA.md)
- [docs/README.md](../docs/README.md)

---

## 🔄 Future Migrations

To create new migrations:

1. Create new file: `010_your_migration.sql`
2. Follow naming convention: `###_description.sql`
3. Add rollback comments if needed
4. Test in development first
5. Commit to git

---

## ⚠️ Important Notes

- **Backup before running in production**
- Test migrations in staging environment first
- Migrations are **additive** - they don't delete existing data
- Migration `009_seed_data.sql` is commented by default
- All migrations are idempotent where possible (using `IF NOT EXISTS`)

---

**Last Updated**: 2025-11-18
**Schema Version**: 1.0.0
**Compatible with**: Supabase PostgreSQL 15+
