# AI Rules for Real Estate Management System

> ⚠ **FILE NÀY ĐÃ LỖI THỜI MỘT PHẦN — đọc [`docs/engineering/PROJECT_CONTRACT.md`](docs/engineering/PROJECT_CONTRACT.md) trước.**
>
> Bốn rule dưới đây **SAI với hệ thống hiện tại**, đừng làm theo:
> - "ALWAYS write TypeScript with strict mode enabled" — `tsconfig.app.json` đang `strict: false`;
>   ratchet thật là `ts-baseline.json` (Contract §7).
> - "STORE files in Supabase Storage buckets" — hệ thống dùng **Cloudflare R2**
>   (`src/lib/storage/r2Config.ts`).
> - "KEEP all route definitions in src/App.tsx" — đi ngược kế hoạch tách route + Capability Registry.
> - "NEVER write custom CSS files" — có page CSS cô lập có chủ đích (`networkCenter.css`).
>
> Phần còn lại (shadcn/ui, React Hook Form + Zod, hook `use*`, Sonner, lazy load, Lucide) vẫn đúng và
> đã được chép sang Contract §14. File này sẽ được rút gọn thành pointer sau khi Contract chạy ổn định.

## Tech Stack

- **React 18** with TypeScript for the frontend framework
- **Vite** as the build tool and development server
- **Supabase** for backend services including database, authentication, and storage
- **Tailwind CSS** for styling and responsive design
- **React Router** for client-side routing and navigation
- **shadcn/ui** component library built on Radix UI primitives
- **Lucide React** for consistent iconography
- **React Hook Form** with Zod for form validation and management
- **Recharts** for data visualization and charts
- **Sonner** for toast notifications and user feedback

## Library Usage Rules

### UI Components
- **ALWAYS** use shadcn/ui components as the foundation for all UI elements
- **NEVER** create custom UI components when shadcn/ui equivalents exist
- **USE** Radix UI primitives only when extending shadcn/ui components
- **PREFER** composition over inheritance when customizing components

### Forms & Validation
- **USE** React Hook Form for all form management
- **IMPLEMENT** Zod schemas for type-safe validation
- **NEVER** use uncontrolled inputs without React Hook Form
- **ALWAYS** provide clear error messages and validation states

### Data Fetching & State
- **USE** custom hooks (use*.ts) for all data operations
- **LEVERAGE** Supabase client for all API calls
- **NEVER** fetch data directly in components
- **IMPLEMENT** proper loading and error states in all hooks

### Styling & Design
- **USE** Tailwind CSS classes for all styling
- **NEVER** write custom CSS files except for global overrides
- **FOLLOW** responsive design principles with mobile-first approach
- **MAINTAIN** consistent spacing using Tailwind's scale

### Icons & Graphics
- **USE** Lucide React icons consistently throughout the app
- **NEVER** mix different icon libraries
- **PREFER** semantic icons that clearly communicate function
- **MAINTAIN** consistent icon sizes and colors

### Routing & Navigation
- **KEEP** all route definitions in src/App.tsx
- **USE** React Router's Navigate component for redirects
- **IMPLEMENT** proper route protection with ProtectedRoute component
- **MAINTAIN** clean URL structure with meaningful paths

### File Organization
- **ORGANIZE** pages in src/pages/ with feature-based subdirectories
- **PLACE** components in src/components/ with feature-based grouping
- **CREATE** hooks in src/hooks/ following the use* naming convention
- **SEPARATE** utilities and helpers in src/lib/

### Database & Storage
- **USE** Supabase for all database operations
- **IMPLEMENT** proper RLS (Row Level Security) policies
- **STORE** files in Supabase Storage buckets
- **NEVER** expose sensitive data in client-side code

### Error Handling & User Feedback
- **USE** Sonner for toast notifications
- **IMPLEMENT** proper error boundaries
- **PROVIDE** clear, actionable error messages
- **NEVER** show technical error details to end users

### Performance & Optimization
- **LAZY** load routes and heavy components
- **IMPLEMENT** proper memoization for expensive operations
- **OPTIMIZE** images and assets
- **MONITOR** bundle size and implement code splitting

## Development Guidelines

- **ALWAYS** write TypeScript with strict mode enabled
- **FOLLOW** existing code patterns and conventions
- **KEEP** components under 100 lines when possible
- **DOCUMENT** complex logic with clear comments
- **TEST** critical user flows and edge cases
- **MAINTAIN** consistent naming conventions across the codebase