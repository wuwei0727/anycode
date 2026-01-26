import React, { useState, useEffect } from 'react';
import {
  FolderOpen,
  Settings,
  BarChart2,
  Terminal,
  Layers,
  Package,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Sparkles
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { View } from '@/types/navigation';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MultiEngineStatusIndicator } from '@/components/MultiEngineStatusIndicator';
import { UpdateBadge } from '@/components/common/UpdateBadge';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { SidebarNav, type SidebarNavItem } from "@/components/layout/SidebarNav";
import { BrandMark } from "@/components/icons/BrandMark";


interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  className?: string;
  onAboutClick?: () => void;
  onUpdateClick?: () => void;
}

const STORAGE_KEY = 'sidebar_expanded';

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onNavigate,
  className,
  onAboutClick,
  onUpdateClick
}) => {
  const { t } = useTranslation();

  // 展开/收起状态，从 localStorage 读取
  const [isExpanded, setIsExpanded] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null ? stored === 'true' : true; // 默认展开
  });

  // 持久化状态到 localStorage 并触发自定义事件
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isExpanded));
    // Dispatch custom event for AppLayout to sync sidebar width
    window.dispatchEvent(new CustomEvent('sidebar-expanded-change', { detail: isExpanded }));
  }, [isExpanded]);

  // 会话页面时自动收起
  useEffect(() => {
    if (currentView === 'claude-code-session' || currentView === 'claude-tab-manager') {
      setIsExpanded(false);
    }
  }, [currentView]);

  const mainNavItems: SidebarNavItem[] = [
    { view: 'projects', icon: FolderOpen, label: t('common.ccProjectsTitle') },
    { view: 'claude-tab-manager', icon: Terminal, label: '会话管理' },
    { view: 'prompts', icon: Sparkles, label: '提示词', hasInternalTabs: true },
    { view: 'usage-dashboard', icon: BarChart2, label: '使用统计' },
    { view: 'mcp', icon: Layers, label: 'MCP 工具' },
    { view: 'claude-extensions', icon: Package, label: '扩展' },
  ];

  const bottomNavItems: SidebarNavItem[] = [
    { view: 'settings', icon: Settings, label: t('navigation.settings') },
  ];

  return (
    <div
      className={cn(
        "flex flex-col py-4 h-full overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
        "bg-[var(--glass-bg)] backdrop-blur-[var(--glass-blur)] border-r border-[var(--glass-border)]",
        isExpanded ? "w-[12.5rem]" : "w-16",
        isExpanded ? "px-3" : "items-center",
        className
      )}
    >
      {/* Header */}
      <div className={cn("w-full mb-3", isExpanded ? "px-1" : "flex justify-center")}>
        <div className={cn("flex items-center", isExpanded ? "justify-between" : "justify-center")}>
          <div className={cn("flex items-center gap-2 text-foreground", !isExpanded && "justify-center")}>
            <BrandMark className={cn("text-primary", isExpanded ? "h-5 w-5" : "h-6 w-6")} />
            {isExpanded && <span className="text-sm font-semibold">菜单</span>}
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isExpanded ? "outline" : "ghost"}
                  size={isExpanded ? "sm" : "icon"}
                  onClick={() => setIsExpanded(!isExpanded)}
                  className={cn(
                    "rounded-xl",
                    isExpanded ? "h-8 px-3" : "h-10 w-10",
                    !isExpanded && "text-muted-foreground hover:text-foreground"
                  )}
                  aria-label={isExpanded ? "折叠侧边栏" : "展开侧边栏"}
                >
                  {isExpanded ? (
                    <>
                      折叠
                      <ChevronLeft className="ml-1.5 h-4 w-4" />
                    </>
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              {!isExpanded && (
                <TooltipContent side="right">
                  <p>展开侧边栏</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      
      {/* 主导航区域 */}
      <div className={cn("flex-1 flex flex-col w-full", isExpanded ? "space-y-1" : "items-center space-y-2")}>
        <SidebarNav
          items={mainNavItems}
          currentView={currentView}
          onNavigate={onNavigate}
          collapsed={!isExpanded}
          ariaLabel="Main Navigation"
        />
      </div>

      {/* 底部状态区域 */}
      <div className={cn(
        "flex flex-col w-full mt-auto pt-4 border-t border-[var(--glass-border)]",
        isExpanded ? "space-y-3" : "items-center"
      )}>
        {/* 多引擎状态指示器 */}
        <div className={cn(isExpanded ? "px-2" : "flex justify-center")}>
          <MultiEngineStatusIndicator
            onSettingsClick={() => onNavigate('settings')}
            compact={!isExpanded}
          />
        </div>

        {/* 更新徽章（展开模式） */}
        {isExpanded && (
          <div className="px-2">
            <UpdateBadge onClick={onUpdateClick} />
          </div>
        )}

        {/* 操作按钮行 */}
        <div className={cn(
          "flex items-center gap-1",
          isExpanded ? "justify-around px-2" : "flex-col"
        )}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <ThemeToggle size="sm" className="w-8 h-8" />
                </div>
              </TooltipTrigger>
              {!isExpanded && (
                <TooltipContent side="right">
                  <p>主题切换</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {onAboutClick && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onAboutClick}
                    className="w-8 h-8 text-muted-foreground hover:text-foreground"
                    aria-label="关于"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                {!isExpanded && (
                  <TooltipContent side="right">
                    <p>关于</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* 设置按钮 */}
        <div className={cn(
          "w-full pt-2 border-t border-[var(--glass-border)]",
          isExpanded ? "px-1" : "flex justify-center"
        )}>
          <SidebarNav
            items={bottomNavItems}
            currentView={currentView}
            onNavigate={onNavigate}
            collapsed={!isExpanded}
            ariaLabel="Bottom Navigation"
          />
        </div>
      </div>
    </div>
  );
};
