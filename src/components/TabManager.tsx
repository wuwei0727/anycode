import React, { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Plus, MoreHorizontal, MessageSquare, ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { TabSessionWrapper } from './TabSessionWrapper';
import { useTabs } from '@/hooks/useTabs';
import { useSessionSync } from '@/hooks/useSessionSync'; // 🔧 NEW: 会话状态同步
import { selectProjectPath } from '@/lib/sessionHelpers';
import type { Session } from '@/lib/api';

interface TabManagerProps {
  onBack: () => void;
  className?: string;
  /**
   * 初始会话信息 - 从 SessionList 跳转时使用
   */
  initialSession?: Session;
  /**
   * 初始项目路径 - 创建新会话时使用
   */
  initialProjectPath?: string;
  /**
   * 🔧 FIX: 初始引擎类型 - 从项目列表新建会话时使用
   * 用于避免在不同引擎项目间切换时显示错误的引擎类型
   */
  initialEngine?: 'claude' | 'codex' | 'gemini';
}

/**
 * TabManager - 多标签页会话管理器
 * 支持多个 Claude Code 会话同时运行，后台保持状态
 */
export const TabManager: React.FC<TabManagerProps> = ({
  onBack,
  className,
  initialSession,
  initialProjectPath,
  initialEngine,
}) => {
  const {
    tabs,
    createNewTab,
    switchToTab,
    closeTab,
    updateTabStreamingStatus,
    reorderTabs, // 🔧 NEW: 拖拽排序
    detachTab,   // 🆕 多窗口支持
    createNewTabAsWindow, // 🆕 直接创建为独立窗口
  } = useTabs();

  // 🔧 NEW: 启用会话状态同步
  useSessionSync();

  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null); // 🔧 NEW: 拖拽悬停的位置
  const [tabToClose, setTabToClose] = useState<string | null>(null); // 🔧 NEW: 待关闭的标签页ID（需要确认）
  const [contextMenuTab, setContextMenuTab] = useState<string | null>(null); // 🆕 右键菜单的标签页ID
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // ✨ Phase 3: Simple initialization flag (no complex state machine)
  const initializedRef = useRef(false);

  // 拖拽处理
  const handleTabDragStart = useCallback((tabId: string) => {
    setDraggedTab(tabId);
  }, []);

  const handleTabDragEnd = useCallback(() => {
    setDraggedTab(null);
    setDragOverIndex(null); // 🔧 NEW: 清除拖拽悬停状态
  }, []);

  // 🔧 NEW: 拖拽悬停处理 - 计算drop位置
  const handleTabDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault(); // 必须阻止默认行为以允许drop
    setDragOverIndex(index);
  }, []);

  // 🔧 NEW: 拖拽放置处理 - 执行重排序
  const handleTabDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();

    if (!draggedTab) return;

    // 查找被拖拽标签页的索���
    const fromIndex = tabs.findIndex(t => t.id === draggedTab);
    if (fromIndex === -1 || fromIndex === targetIndex) {
      setDraggedTab(null);
      setDragOverIndex(null);
      return;
    }

    // 执行重排序
    reorderTabs(fromIndex, targetIndex);
    setDraggedTab(null);
    setDragOverIndex(null);
  }, [draggedTab, tabs, reorderTabs]);

  // 🔧 NEW: 处理标签页关闭（支持确认Dialog）
  const handleCloseTab = useCallback(async (tabId: string, force = false) => {
    const result = await closeTab(tabId, force);

    // 如果需要确认，显示Dialog
    if (result && typeof result === 'object' && 'needsConfirmation' in result && result.needsConfirmation) {
      setTabToClose(result.tabId || null);
    }
  }, [closeTab]);

  // 🆕 处理右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuTab(tabId);
  }, []);

  // 🆕 关闭其他标签页
  const handleCloseOtherTabs = useCallback(async (tabId: string) => {
    const otherTabs = tabs.filter(t => t.id !== tabId);
    for (const tab of otherTabs) {
      await closeTab(tab.id, true);
    }
    setContextMenuTab(null);
  }, [tabs, closeTab]);

  // 🆕 关闭右侧标签页
  const handleCloseTabsToRight = useCallback(async (tabId: string) => {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;
    
    const tabsToClose = tabs.slice(tabIndex + 1);
    for (const tab of tabsToClose) {
      await closeTab(tab.id, true);
    }
    setContextMenuTab(null);
  }, [tabs, closeTab]);

  // 🆕 关闭所有标签页
  const handleCloseAllTabs = useCallback(async () => {
    for (const tab of tabs) {
      await closeTab(tab.id, true);
    }
    setContextMenuTab(null);
  }, [tabs, closeTab]);

  // 🔧 NEW: 确认关闭标签页
  const confirmCloseTab = useCallback(async () => {
    if (tabToClose) {
      await closeTab(tabToClose, true); // force close
      setTabToClose(null);
    }
  }, [tabToClose, closeTab]);

  // 🆕 NEW: 将标签页弹出为独立窗口
  const handleDetachTab = useCallback(async (tabId: string) => {
    try {
      const windowLabel = await detachTab(tabId);
      if (windowLabel) {
        console.log('[TabManager] Tab detached to window:', windowLabel);
      }
    } catch (error) {
      console.error('[TabManager] Failed to detach tab:', error);
    }
  }, [detachTab]);

  // 🆕 NEW: 创建新会话并直接打开为独立窗口
  const handleCreateNewTabAsWindow = useCallback(async () => {
    try {
      // 🔧 UX: 如果当前已在某个项目上下文中，则直接复用该项目路径创建会话
      const activeTab = tabs.find(t => t.isActive);
      const preferredProjectPath =
        activeTab?.projectPath ||
        activeTab?.session?.project_path ||
        initialProjectPath;

      const projectPathToUse = preferredProjectPath || await selectProjectPath();
      if (!projectPathToUse) {
        console.log('[TabManager] User cancelled project selection');
        return;
      }

      const windowLabel = await createNewTabAsWindow(undefined, projectPathToUse);
      if (windowLabel) {
        console.log('[TabManager] Created new session window:', windowLabel);
      }
    } catch (error) {
      console.error('[TabManager] Failed to create new session window:', error);
    }
  }, [createNewTabAsWindow, tabs, initialProjectPath]);

  // 🔧 UX: 新建会话时优先复用当前标签页的项目路径，避免重复选择项目目录
  const handleCreateNewTab = useCallback(() => {
    const activeTab = tabs.find(t => t.isActive);
    const preferredProjectPath =
      activeTab?.projectPath ||
      activeTab?.session?.project_path ||
      initialProjectPath;

    if (preferredProjectPath) {
      createNewTab(undefined, preferredProjectPath);
      return;
    }

    // 无项目上下文时，保持原行为：创建空会话，由会话页引导选择项目
    createNewTab();
  }, [tabs, initialProjectPath, createNewTab]);

  // ✨ Phase 3: Simplified initialization (single responsibility, no race conditions)
  useEffect(() => {
    // Only run once for initial mount
    if (initializedRef.current) return;
    initializedRef.current = true;

    // 🔧 修复：新建操作应该覆盖已保存的标签页
    const isNewOperation = initialSession || initialProjectPath;

    // 🔧 FIX: 如果有 initialEngine，更新 localStorage 中的引擎配置
    // 这样可以确保新建会话时使用正确的引擎类型
    if (initialEngine && initialProjectPath) {
      try {
        const stored = localStorage.getItem('execution_engine_config');
        const config = stored ? JSON.parse(stored) : {
          engine: 'claude',
          codexMode: 'read-only',
          codexModel: 'gpt-5.2',
          codexReasoningMode: 'medium',
        };
        config.engine = initialEngine;
        localStorage.setItem('execution_engine_config', JSON.stringify(config));
        console.log('[TabManager] Updated engine config for new session:', initialEngine);
      } catch (error) {
        console.error('[TabManager] Failed to update engine config:', error);
      }
    }

    // Priority 1: Initial session provided (highest priority)
    if (initialSession) {
      console.log('[TabManager] Creating tab for initial session:', initialSession.id);
      createNewTab(initialSession);
      return;
    }

    // Priority 2: Initial project path provided
    if (initialProjectPath) {
      console.log('[TabManager] Creating tab for initial project:', initialProjectPath);
      createNewTab(undefined, initialProjectPath);
      return;
    }

    // Priority 3: Tabs restored from localStorage (only if no new operation)
    if (tabs.length > 0 && !isNewOperation) {
      console.log('[TabManager] Tabs restored from localStorage');
      return;
    }

    // Priority 4: No initial data - show empty state
    console.log('[TabManager] No initial data, showing empty state');
  }, []); // Empty deps - only run once on mount

  // 🔧 FIX: Handle new session/project after initial mount
  // This is needed because TabManager is now kept mounted across view switches
  const lastInitialSessionRef = useRef<string | undefined>(initialSession?.id);
  const lastInitialProjectPathRef = useRef<string | undefined>(initialProjectPath);

  useEffect(() => {
    // Skip if not initialized yet (let the initial useEffect handle it)
    if (!initializedRef.current) return;

    // Check if initialSession changed
    if (initialSession && initialSession.id !== lastInitialSessionRef.current) {
      console.log('[TabManager] New session received after mount:', initialSession.id);
      lastInitialSessionRef.current = initialSession.id;
      
      // Check if session already exists in tabs
      const existingTab = tabs.find(t => t.session?.id === initialSession.id);
      if (existingTab) {
        console.log('[TabManager] Session already exists, switching to tab:', existingTab.id);
        switchToTab(existingTab.id);
      } else {
        console.log('[TabManager] Creating new tab for session:', initialSession.id);
        createNewTab(initialSession);
      }
      return;
    }

    // Check if initialProjectPath changed
    if (initialProjectPath && initialProjectPath !== lastInitialProjectPathRef.current) {
      console.log('[TabManager] New project path received after mount:', initialProjectPath);
      lastInitialProjectPathRef.current = initialProjectPath;
      
      // 🔧 FIX: 如果有 initialEngine，更新 localStorage 中的引擎配置
      if (initialEngine) {
        try {
          const stored = localStorage.getItem('execution_engine_config');
          const config = stored ? JSON.parse(stored) : {
            engine: 'claude',
            codexMode: 'read-only',
            codexModel: 'gpt-5.2',
            codexReasoningMode: 'medium',
          };
          config.engine = initialEngine;
          localStorage.setItem('execution_engine_config', JSON.stringify(config));
          console.log('[TabManager] Updated engine config for new session (after mount):', initialEngine);
        } catch (error) {
          console.error('[TabManager] Failed to update engine config:', error);
        }
      }
      
      createNewTab(undefined, initialProjectPath);
    }
  }, [initialSession, initialProjectPath, initialEngine, tabs, switchToTab, createNewTab]);

  return (
    <TooltipProvider>
      <div className={cn("h-full flex flex-col bg-background", className)}>
        {/* 🎨 极简标签页栏 */}
        <div className="flex-shrink-0 border-b border-border bg-background">
          <div className="flex items-center h-12 px-4 gap-2">
            {/* 返回按钮 */}
            <Button
              variant="default"
              size="sm"
              onClick={onBack}
              className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-sm transition-all duration-200 hover:shadow-md border-0"
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              <span>返回</span>
            </Button>

            {/* 分隔线 */}
            <div className="h-4 w-px bg-border" />

            {/* 标签页容器 */}
            <div
              ref={tabsContainerRef}
              className="flex-1 flex items-center gap-2 overflow-x-auto scrollbar-thin"
            >
              <AnimatePresence mode="popLayout">
                {tabs.map((tab, index) => (
                  <DropdownMenu 
                    key={tab.id}
                    open={contextMenuTab === tab.id}
                    onOpenChange={(open) => !open && setContextMenuTab(null)}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <motion.div
                            layout
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className={cn(
                              "group relative flex items-center gap-2 px-3 py-1.5 rounded-lg min-w-[100px] max-w-[200px] flex-shrink-0 cursor-pointer",
                              "transition-all duration-200",
                              tab.isActive
                                ? "bg-primary/10 border-2 border-primary text-foreground shadow-sm font-medium"
                                : "bg-transparent border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/50 hover:border-border",
                              draggedTab === tab.id && "ring-2 ring-primary",
                              dragOverIndex === index && draggedTab !== tab.id && "border-primary"
                            )}
                            onClick={() => switchToTab(tab.id)}
                            onContextMenu={(e) => handleContextMenu(e, tab.id)}
                            draggable
                            onDragStart={() => handleTabDragStart(tab.id)}
                            onDragEnd={handleTabDragEnd}
                            onDragOver={(e) => handleTabDragOver(e, index)}
                            onDrop={(e) => handleTabDrop(e, index)}
                          >
                        {/* 会话状态指示器 - 极简 */}
                        <div className="flex-shrink-0">
                          {tab.state === 'streaming' ? (
                            <motion.div
                              animate={{ opacity: [1, 0.4, 1] }}
                              transition={{ duration: 1.5, repeat: Infinity }}
                              className="h-1.5 w-1.5 bg-success rounded-full"
                            />
                          ) : tab.hasUnsavedChanges ? (
                            <div className="h-1.5 w-1.5 bg-warning rounded-full" />
                          ) : null}
                        </div>

                        {/* 标签页标题 */}
                        <span className="flex-1 truncate text-sm">
                          {tab.title}
                        </span>

                        {/* 弹出窗口按钮 - 仅在 hover 时显示 */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              className={cn(
                                "flex-shrink-0 h-5 w-5 rounded flex items-center justify-center",
                                "opacity-0 group-hover:opacity-100 transition-opacity",
                                "hover:bg-muted-foreground/20"
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDetachTab(tab.id);
                              }}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <span className="text-xs">在新窗口中打开</span>
                          </TooltipContent>
                        </Tooltip>

                        {/* 关闭按钮 - 仅在 hover 时显示 */}
                        <button
                          className={cn(
                            "flex-shrink-0 h-5 w-5 rounded flex items-center justify-center",
                            "opacity-0 group-hover:opacity-100 transition-opacity",
                            "hover:bg-muted-foreground/20"
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseTab(tab.id);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </motion.div>
                    </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-sm">
                      <div className="space-y-1 text-xs">
                        <div className="font-medium">{tab.title}</div>
                        {tab.session && (
                          <>
                            <div className="text-muted-foreground">
                              会话 ID: {tab.session.id}
                            </div>
                            <div className="text-muted-foreground">
                              项目: {tab.projectPath || tab.session.project_path}
                            </div>
                            <div className="text-muted-foreground">
                              创建时间: {new Date(tab.session.created_at * 1000).toLocaleString('zh-CN')}
                            </div>
                          </>
                        )}
                        {!tab.session && tab.projectPath && (
                          <div className="text-muted-foreground">
                            项目: {tab.projectPath}
                          </div>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>

                  {/* 右键菜单 */}
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuItem onClick={() => {
                      switchToTab(tab.id);
                      setContextMenuTab(null);
                    }}>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      切换到此标签
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      handleDetachTab(tab.id);
                      setContextMenuTab(null);
                    }}>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      在新窗口中打开
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => {
                      handleCloseTab(tab.id);
                      setContextMenuTab(null);
                    }}>
                      <X className="h-4 w-4 mr-2" />
                      关闭标签
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleCloseOtherTabs(tab.id)}
                      disabled={tabs.length <= 1}
                    >
                      <X className="h-4 w-4 mr-2" />
                      关闭其他标签
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleCloseTabsToRight(tab.id)}
                      disabled={index >= tabs.length - 1}
                    >
                      <X className="h-4 w-4 mr-2" />
                      关闭右侧标签
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem 
                      onClick={handleCloseAllTabs}
                      className="text-destructive focus:text-destructive"
                    >
                      <X className="h-4 w-4 mr-2" />
                      关闭所有标签
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                ))}
              </AnimatePresence>

              {/* 新建标签页按钮 */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="flex-shrink-0 h-7 w-7 rounded flex items-center justify-center hover:bg-muted transition-colors"
                    onClick={handleCreateNewTab}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>新建会话</TooltipContent>
              </Tooltip>
            </div>

            {/* 分隔线 */}
            <div className="h-4 w-px bg-border" />

            {/* 标签页菜单 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="h-7 w-7 rounded flex items-center justify-center hover:bg-muted transition-colors">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleCreateNewTab}>
                  <Plus className="h-4 w-4 mr-2" />
                  新建会话
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleCreateNewTabAsWindow}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  新建会话（独立窗口）
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => tabs.forEach(tab => closeTab(tab.id, true))}
                  disabled={tabs.length === 0}
                >
                  关闭所有标签页
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => tabs.filter(tab => !tab.isActive).forEach(tab => closeTab(tab.id, true))}
                  disabled={tabs.length <= 1}
                >
                  关闭其他标签页
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 标签页内容区域 */}
        <div className="flex-1 relative overflow-hidden">
          {/* 🔧 STATE PRESERVATION: 渲染所有标签页但隐藏非活跃标签页 */}
          {/* 这样可以保持组件状态（包括输入框内容），避免切换标签页时状态丢失 */}
          {tabs.map((tab) => {
            return (
              <div
                key={tab.id}
                className={cn(
                  "absolute inset-0",
                  !tab.isActive && "hidden"
                )}
              >
                <TabSessionWrapper
                  tabId={tab.id}
                  session={tab.session}
                  initialProjectPath={tab.projectPath}
                  isActive={tab.isActive}
                  onStreamingChange={(isStreaming, sessionId) =>
                    updateTabStreamingStatus(tab.id, isStreaming, sessionId)
                  }
                />
              </div>
            );
          })}

          {/* 🎨 现代化空状态设计 */}
          {tabs.length === 0 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="flex items-center justify-center h-full"
            >
              <div className="text-center max-w-md px-8">
                {/* 图标 */}
                <motion.div
                  initial={{ y: -20 }}
                  animate={{ y: 0 }}
                  transition={{ 
                    type: "spring",
                    stiffness: 200,
                    damping: 20,
                    delay: 0.1
                  }}
                  className="mb-6"
                >
                  <div className="inline-flex p-6 rounded-2xl bg-muted/50 border border-border/50">
                    <MessageSquare className="h-16 w-16 text-muted-foreground/70" strokeWidth={1.5} />
                  </div>
                </motion.div>

                {/* 标题和描述 */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mb-8"
                >
                  <h3 className="text-2xl font-bold mb-3 text-foreground">
                    暂无活跃会话
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    所有标签页已关闭。创建新会话开始工作，或返回主界面查看项目。
                  </p>
                </motion.div>

                {/* 操作按钮 */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="flex flex-col gap-3"
                >
                  <Button
                    size="lg"
                    onClick={handleCreateNewTab}
                    className="w-full shadow-md hover:shadow-lg"
                  >
                    <Plus className="h-5 w-5 mr-2" />
                    创建新会话
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={onBack}
                    className="w-full"
                  >
                    <ArrowLeft className="h-5 w-5 mr-2" />
                    返回主界面
                  </Button>
                </motion.div>
              </div>
            </motion.div>
          )}
        </div>

        {/* 🔧 NEW: 自定义关闭确认Dialog */}
        <Dialog open={tabToClose !== null} onOpenChange={(open) => !open && setTabToClose(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>确认关闭标签页</DialogTitle>
              <DialogDescription>
                此会话有未保存的更改，确定要关闭吗？关闭后更改将丢失。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTabToClose(null)}>
                取消
              </Button>
              <Button variant="destructive" onClick={confirmCloseTab}>
                确认关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
};
