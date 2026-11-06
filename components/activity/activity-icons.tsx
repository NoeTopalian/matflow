import { createElement } from "react";
import {
  Award,
  BadgeCheck,
  BellRing,
  Calendar,
  CalendarCheck,
  CalendarX,
  CircleAlert,
  CirclePause,
  CircleX,
  ClipboardCheck,
  ClipboardX,
  CreditCard,
  FileSignature,
  History,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Lock,
  Medal,
  Megaphone,
  Repeat,
  RotateCcw,
  Settings,
  ShieldCheck,
  Tag,
  Target,
  Ticket,
  TriangleAlert,
  Undo2,
  Upload,
  UserMinus,
  UserPen,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * The icon each activity type names (lib/activity-types.ts keeps the name as
 * text so that file stays free of React). A static map, never a dynamic
 * lookup into the library: only these icons are bundled, and a type that
 * names an icon missing here fails tests/unit/activity-timeline-view.test.tsx.
 */
export const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  Award,
  BadgeCheck,
  BellRing,
  Calendar,
  CalendarCheck,
  CalendarX,
  CircleAlert,
  CirclePause,
  CircleX,
  ClipboardCheck,
  ClipboardX,
  CreditCard,
  FileSignature,
  History,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Lock,
  Medal,
  Megaphone,
  Repeat,
  RotateCcw,
  Settings,
  ShieldCheck,
  Tag,
  Target,
  Ticket,
  TriangleAlert,
  Undo2,
  Upload,
  UserMinus,
  UserPen,
  UserPlus,
  Users,
  Wallet,
};

/**
 * An activity type's icon, by the name the taxonomy gives it. A name this build does not know (a link from a newer
 * release) draws the neutral History icon rather than nothing.
 */
export function ActivityIcon({ name, className }: { name: string | undefined; className?: string }) {
  return createElement((name && ACTIVITY_ICONS[name]) || History, { className, "aria-hidden": true });
}
