// Map tên icon (theo Claude Design kit) → component lucide-react.
// Dùng cho tra cứu icon động: SAL_ICONS[name].
import {
  Wallet, HandCoins, Coins, Banknote, Receipt, Wrench, FileClock, FileText,
  CalendarCheck, Calendar, Target, Flame, TrendingUp, Rocket, Trophy, Medal,
  Zap, Star, Gift, Lock, Unlock, RefreshCw, Download, Plus, Minus, X, Check,
  CheckCircle, Circle, Clock, Hourglass, AlertTriangle, Info, ChevronLeft,
  ChevronRight, ChevronDown, Pencil, Trash2, MoreVertical, Search, Filter, Eye,
  Building2, Users, UserPlus, KeyRound, Sparkles, ArrowRight, ArrowUpRight, Home,
  Settings, Briefcase, PiggyBank, BarChart3, CalendarRange, type LucideIcon,
} from "lucide-react";

export const SAL_ICONS: Record<string, LucideIcon> = {
  Wallet, HandCoins, Coins, Banknote, Receipt, Wrench, FileClock, FileText,
  CalendarCheck, Calendar, Target, Flame, TrendingUp, Rocket, Trophy, Medal,
  Zap, Star, Gift, Lock, Unlock, RefreshCw, Download, Plus, Minus, X, Check,
  CheckCircle, Circle, Clock, Hourglass, AlertTriangle, Info, ChevronLeft,
  ChevronRight, ChevronDown, Pencil, Trash: Trash2, MoreVertical, Search, Filter,
  Eye, Building: Building2, Users, UserPlus, KeyRound, Sparkles, ArrowRight,
  ArrowUpRight, Home, Settings, Briefcase, PiggyBank, BarChart: BarChart3, CalendarRange,
};

export type SalIconName = keyof typeof SAL_ICONS;
