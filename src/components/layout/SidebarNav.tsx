import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { View } from "@/types/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface SidebarNavItem {
  view: View;
  icon: React.ElementType;
  label: string;
  shortcut?: string;
  hasInternalTabs?: boolean;
}

interface SidebarNavProps {
  items: SidebarNavItem[];
  currentView: View;
  onNavigate: (view: View) => void;
  collapsed: boolean;
  className?: string;
  ariaLabel?: string;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({
  items,
  currentView,
  onNavigate,
  collapsed,
  className,
  ariaLabel = "Sidebar Navigation",
}) => {
  return (
    <TooltipProvider delayDuration={0}>
      <nav
        className={cn(
          "flex flex-col w-full",
          collapsed ? "items-center space-y-2" : "space-y-1",
          className
        )}
        aria-label={ariaLabel}
      >
        {items.map((item) => {
          const isActive = currentView === item.view;
          const Icon = item.icon;

          const content = (
            <button
              type="button"
              onClick={() => onNavigate(item.view)}
              className={cn(
                "group relative flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition",
                "hover:bg-zinc-100/80 focus-visible:ring-2 focus-visible:ring-zinc-400/60 outline-none",
                isActive ? "bg-indigo-50 text-zinc-900" : "text-zinc-600",
                "w-full",
                collapsed ? "justify-center px-2" : ""
              )}
            >
              {/* Left highlight bar */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full transition-opacity",
                  isActive ? "opacity-100 bg-indigo-500" : "opacity-0"
                )}
              />

              <span
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-2xl border bg-white shrink-0",
                  isActive
                    ? "border-indigo-200 text-indigo-600"
                    : "border-zinc-200 text-zinc-600"
                )}
                aria-hidden="true"
              >
                <Icon
                  className="h-5 w-5"
                  strokeWidth={isActive ? 2.5 : 2}
                />
              </span>

              {!collapsed && (
                <>
                  <span className="truncate text-[14px] font-medium">{item.label}</span>
                  {item.hasInternalTabs && (
                    <span className="ml-auto grid h-7 w-7 place-items-center rounded-xl text-zinc-500">
                      <ChevronDown className="h-4 w-4 opacity-70" />
                    </span>
                  )}
                </>
              )}
              {collapsed && <span className="sr-only">{item.label}</span>}
            </button>
          );

          if (!collapsed) return content;

          return (
            <Tooltip key={item.view}>
              <TooltipTrigger asChild>{content}</TooltipTrigger>
              <TooltipContent
                side="right"
                sideOffset={10}
                className="rounded-lg bg-zinc-900 px-2 py-1 text-xs text-white shadow"
              >
                {item.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    </TooltipProvider>
  );
};
