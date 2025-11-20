# iHomeCRM - Whiteboard Property Management System

## 📋 Project Overview

**iHomeCRM** is a comprehensive property management system designed for managing rental properties, including rooms, beds, tenants, contracts, invoices, and payments. This system provides a complete solution for landlords and property managers to efficiently operate their rental business.

**Project URL**: https://lovable.dev/projects/f1b45a3e-07a6-4cd1-8f1c-53fb41947a58

## ✨ Key Features

### Core Management
- 🏢 **Master Data**: Areas, Buildings, Rooms, Beds, Services
- 👥 **Customer Management**: Leads, Deposits, Contracts, Tenants, Vehicles
- 💰 **Finance**: Meter Readings, Invoices, Payments, Cash Book
- 🛠️ **Assets & Issues**: Asset tracking, Issue management with workflows
- 📊 **Reports**: Real Estate, Finance, and Task reports (15+ report types)

### Phase 20 Advanced Features

#### 🔔 Notifications System (Phase 20A)
- Real-time in-app notifications with 60-second polling
- 7 notification types: New Invoice, Payment Reminder, Overdue Invoice, Contract Expiring, Issue Resolved, General Announcement, Custom
- Unread count badge on notification bell
- Mark as read/delete functionality
- Notification helpers for automated triggers
- See: [`PHASE-20-COMPLETE.md`](./PHASE-20-COMPLETE.md) for full details

#### ⚙️ Settings & Code Generation (Phase 20B)
- **Company Settings**: Business information, logo, contact details
- **Contract Settings**: 13+ contract rules (deposit policy, advance notice, extension rules)
- **Invoice Settings**: 11+ invoice rules (due date, overdue fees, tax settings)
- **Payment Settings**: Bank info, payment methods, transaction tracking
- **Notification Settings**: Channel preferences (email, SMS, in-app) and triggers
- **Code Generation**: Auto-generate codes for 12 entity types with customizable formats
  - Format variables: `{YYYY}`, `{YY}`, `{MM}`, `{DD}`, `{####}`
  - Reset periods: DAILY, MONTHLY, YEARLY, NEVER
  - Examples: `HD-2025-0001`, `INV-2511-0001`, `CONTRACT-25-0123`

#### 📄 Templates & Signatures (Phase 20C)
- **Document Templates**: Upload DOCX templates for contracts, invoices, receipts
- **Template Variables**: 30+ dynamic variables like `{company_name}`, `{tenant_name}`, `{total_amount}`
- **Digital Signatures**: Three signature methods
  - **Upload**: PNG/JPG image files
  - **Draw**: HTML5 canvas for hand-drawn signatures
  - **Text**: Text-based signatures with 4 font styles

#### 👥 Staff Management (Phase 20D)
- Multi-user support with RBAC (Role-Based Access Control)
- 4 roles: ADMIN, MANAGER, STAFF, VIEWER
- Permission-based access control
- Staff invitation and management

#### 🛡️ Error Handling & Resilience
- Global ErrorBoundary component
- User-friendly error messages
- Graceful error recovery with retry options
- Development-mode error details

## 🚀 Technology Stack

### Frontend
- **React 18** - UI framework
- **TypeScript** - Type-safe development
- **Vite** - Build tool and dev server
- **TanStack React Query** - Data fetching and caching
- **React Router v6** - Client-side routing
- **React Hook Form** - Form management
- **Zod** - Schema validation
- **date-fns** - Date manipulation
- **Recharts** - Data visualization

### UI Components & Styling
- **shadcn/ui** - High-quality component library
- **Tailwind CSS** - Utility-first CSS
- **Lucide React** - Icon library
- **Radix UI** - Headless UI primitives

### Backend & Database
- **Supabase** - Backend as a Service
  - PostgreSQL database
  - Authentication
  - Storage for files
  - Row Level Security (RLS)

### Development Tools
- **ESLint** - Code linting
- **PostCSS** - CSS processing
- **Git** - Version control

## 📦 Installation & Setup

### Prerequisites
- Node.js 18+ and npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)
- Supabase account and project

### Step 1: Clone the Repository
```bash
git clone <YOUR_GIT_URL>
cd whiteboard-ihomecrm
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Environment Setup
Create a `.env.local` file in the root directory:
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Step 4: Database Setup
Run the SQL migrations in your Supabase project to create all necessary tables. See `database-schema.sql` or refer to previous phase documentation for schema details.

### Step 5: Start Development Server
```bash
npm run dev
```

The application will be available at `http://localhost:5173`

## 📁 Project Structure

```
whiteboard-ihomecrm/
├── src/
│   ├── components/          # Reusable UI components
│   │   ├── layout/         # Header, Sidebar, NotificationBell
│   │   ├── ui/             # shadcn/ui components
│   │   ├── auth/           # ProtectedRoute, PublicRoute
│   │   └── ErrorBoundary.tsx
│   ├── pages/              # Page components
│   │   ├── auth/           # Register, Login, ForgotPassword
│   │   ├── areas/          # Areas management
│   │   ├── buildings/      # Buildings management
│   │   ├── rooms/          # Rooms management
│   │   ├── beds/           # Beds management
│   │   ├── contracts/      # Contracts management
│   │   ├── invoices/       # Invoices management
│   │   ├── payments/       # Payments management
│   │   ├── issues/         # Issues management
│   │   ├── reports/        # Reports pages
│   │   └── settings/       # Settings pages
│   ├── hooks/              # Custom React hooks
│   │   ├── useAuth.ts
│   │   ├── useNotifications.ts
│   │   ├── useSettings.ts
│   │   ├── useCodeGeneration.ts
│   │   ├── useTemplates.ts
│   │   └── ... (entity-specific hooks)
│   ├── lib/                # Utilities and helpers
│   │   ├── supabase.ts     # Supabase client
│   │   ├── utils.ts        # Common utilities
│   │   └── notificationHelpers.ts
│   ├── types/              # TypeScript type definitions
│   ├── App.tsx             # Main app component
│   └── main.tsx            # Entry point
├── public/                 # Static assets
├── PHASE-20-COMPLETE.md    # Phase 20 detailed documentation
├── IMPLEMENTATION-PLAN.md  # Full project implementation plan
└── package.json
```

## 🎯 Usage

### Authentication
1. Register a new account at `/register`
2. Login at `/login`
3. Recover password at `/forgot-password`

### Master Data Setup
1. Create **Areas** (geographical zones)
2. Create **Buildings** within areas
3. Create **Rooms** within buildings
4. Create **Beds** within rooms (for bed rentals)
5. Create **Services** (electricity, water, internet, etc.)

### Customer Management
1. Capture **Leads** from prospects
2. Collect **Deposits** from interested tenants
3. Create **Contracts** for confirmed rentals
4. Manage **Tenants** information
5. Track **Vehicles** registered to tenants

### Finance Operations
1. Record **Meter Readings** (electricity, water)
2. Generate **Invoices** (manual or auto-generated)
3. Process **Payments** from tenants
4. Track **Cash Book** for all transactions

### Reports & Analytics
- **Real Estate Reports**: Vacant Rooms, Expiring Contracts, Occupancy, etc.
- **Finance Reports**: Cash Flow, Debt, Deposits, Profit Distribution
- **Task Reports**: Tasks Overview, By Staff, By Room

### Settings Configuration
1. Navigate to **Settings > General** to configure company info and system rules
2. Navigate to **Settings > Templates** to upload document templates
3. Navigate to **Settings > Signatures** to create digital signatures
4. Navigate to **Settings > Staff** to manage team members (requires RBAC setup)

## 📖 Documentation

- **[PHASE-20-COMPLETE.md](./PHASE-20-COMPLETE.md)** - Detailed Phase 20 documentation (~800 lines)
  - Feature specifications
  - API references
  - Usage examples
  - Integration guides
  - Testing checklist

- **[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)** - Full project implementation plan
  - All 20 phases breakdown
  - Database schema
  - Feature roadmap

## 🔧 Development

### Available Scripts
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build
npm run lint         # Run ESLint
```

### Code Style
- Use TypeScript for all new files
- Follow React best practices
- Use functional components with hooks
- Implement proper error handling
- Add loading states for async operations

### Git Workflow
1. Create feature branches from `main`
2. Commit with descriptive messages
3. Push changes to remote
4. Create pull requests for review

## 🚀 Deployment

### Deploy with Lovable
1. Open [Lovable Project](https://lovable.dev/projects/f1b45a3e-07a6-4cd1-8f1c-53fb41947a58)
2. Click **Share → Publish**
3. Your app will be deployed automatically

### Custom Domain
Navigate to **Project > Settings > Domains** and click **Connect Domain**.

Read more: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)

### Manual Deployment
```bash
npm run build
# Deploy the 'dist' folder to your hosting provider
```

Compatible with:
- Vercel
- Netlify
- AWS Amplify
- Cloudflare Pages

## 🧪 Testing

### Phase 20 Testing Checklist
- [ ] Notification bell shows unread count
- [ ] Notifications mark as read correctly
- [ ] Settings save and persist across sessions
- [ ] Code generation produces unique codes
- [ ] Template upload works with DOCX files
- [ ] Signature canvas allows drawing
- [ ] Staff page displays roles correctly
- [ ] ErrorBoundary catches and displays errors

## 🤝 Contributing

This is a private project managed through Lovable. Changes can be made via:
1. **Lovable UI** - Direct prompting
2. **Local IDE** - Clone, edit, push
3. **GitHub** - Edit files directly
4. **GitHub Codespaces** - Cloud development environment

## 📊 Project Metrics (Phase 20)

- **Total Lines of Code**: ~5,800 lines
- **New Components**: 8 major components
- **New Hooks**: 4 comprehensive hooks
- **New Pages**: 4 settings pages
- **Features Implemented**: 35+ features

## 🐛 Known Issues & Limitations

1. **Templates Table**: Requires database migration (table not yet created)
2. **Signature Storage**: Currently uses mock data, needs integration with `signature_templates` table
3. **Staff RBAC**: Full multi-tenant RBAC system requires additional backend setup
4. **Notification Read Status**: Currently tracked in localStorage, should migrate to database
5. **Email/SMS Notifications**: Configured in settings but not yet implemented (requires external service integration)

## 📝 License

This project is proprietary and confidential.

## 📞 Support

For support and questions, contact the development team or visit the [Lovable Project](https://lovable.dev/projects/f1b45a3e-07a6-4cd1-8f1c-53fb41947a58).

---

**Last Updated**: Phase 20 Complete - January 2025

**Current Version**: Phase 20 (Notifications, Settings, Templates, Signatures, Staff Management)
