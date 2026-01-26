import React, { useState, useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence, Transition } from "framer-motion"; // ✨ Added for transitions
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ProjectList } from "@/components/ProjectList";
import { SessionList } from "@/components/SessionList";
import { RunningClaudeSessions } from "@/components/RunningClaudeSessions";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { CodexPromptManager } from "@/components/CodexPromptManager";
import { GeminiMarkdownEditor } from "@/components/GeminiMarkdownEditor";
import { PromptCenter } from "@/components/PromptCenter";
import { ClaudeFileEditor } from "@/components/ClaudeFileEditor";
import { Settings } from "@/components/Settings";
import { ClaudeCodeSession } from "@/components/ClaudeCodeSession";
import { TabManager } from "@/components/TabManager";
import { UsageDashboard } from "@/components/UsageDashboard";
import { MCPManager } from "@/components/MCPManager";
import { ClaudeBinaryDialog } from "@/components/dialogs/ClaudeBinaryDialog";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProjectSettings } from '@/components/ProjectSettings';
import { EnhancedHooksManager } from '@/components/EnhancedHooksManager';
import { ClaudeExtensionsManager } from '@/components/ClaudeExtensionsManager';
import { ProjectCardSkeleton, SessionListItemSkeleton } from '@/components/ui/skeleton';
import { useNavigation } from '@/contexts/NavigationContext';
import { useProject } from '@/contexts/ProjectContext';
import { useTabs } from '@/hooks/useTabs';
import { useGlobalKeyboardShortcuts } from '@/hooks/useGlobalKeyboardShortcuts';
import { cn } from '@/lib/utils';

// ✨ View transition variants
const pageVariants = {
  initial: { opacity: 0, y: 10 },
  in: { opacity: 1, y: 0 },
  out: { opacity: 0, y: -10 }
};

const pageTransition: Transition = {
  type: "tween",
  ease: "anticipate",
  duration: 0.3
};

export const ViewRouter: React.FC = () => {
  const { t } = useTranslation();
  const { currentView, navigateTo, viewParams, setNavigationInterceptor, goBack } = useNavigation();
  const {
    projects, filteredProjects, selectedProject, selectedUnifiedProject, sessions, loading, error,
    loadProjects, selectUnifiedProject, deleteProject, clearSelection, refreshSessions,
    engineFilter, setEngineFilter
  } = useProject();
  const { openSessionInBackground, switchToTab } = useTabs();

  const [showClaudeBinaryDialog, setShowClaudeBinaryDialog] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [showNavigationConfirm, setShowNavigationConfirm] = useState(false);
  const [pendingView, setPendingView] = useState<any | null>(null); // Store pending view for confirmation
  
  // 会话列表刷新状态
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  
  // 处理会话列表刷新
  const handleRefreshSessions = async () => {
    setIsRefreshingSessions(true);
    try {
      await refreshSessions();
      setToast({ message: '会话列表已刷新', type: 'success' });
    } catch (err) {
      console.error('Failed to refresh sessions:', err);
      setToast({ message: '刷新失败', type: 'error' });
    } finally {
      setIsRefreshingSessions(false);
    }
  };

  // Load projects on mount if in projects view
  const hasLoadedProjectsRef = useRef(false);
  useEffect(() => {
    if (currentView === "projects" && !hasLoadedProjectsRef.current) {
      loadProjects();
      hasLoadedProjectsRef.current = true;
    }
  }, [currentView, loadProjects]);

  // Global keyboard shortcuts
  useGlobalKeyboardShortcuts({
    onOpenSettings: () => {
      navigateTo('settings');
    },
    enabled: currentView !== 'claude-code-session',
  });

  // Listen for open-prompt-api-settings
  useEffect(() => {
    const handleOpenPromptAPISettings = () => {
      navigateTo("settings", { initialTab: "prompt-api" });
    };
    window.addEventListener('open-prompt-api-settings', handleOpenPromptAPISettings as EventListener);
    return () => window.removeEventListener('open-prompt-api-settings', handleOpenPromptAPISettings as EventListener);
  }, [currentView, navigateTo]);

  // Listen for claude-session-selected
  useEffect(() => {
    const handleSessionSelected = (event: CustomEvent) => {
      const { session } = event.detail;
      const result = openSessionInBackground(session);
      switchToTab(result.tabId);
      navigateTo("claude-tab-manager");

      if (result.isNew) {
        setToast({ message: `会话 ${session.id.slice(-8)} 已打开`, type: "success" });
      } else {
        setToast({ message: `已切换到会话 ${session.id.slice(-8)}`, type: "info" });
      }
    };

    const handleClaudeNotFound = () => {
      setShowClaudeBinaryDialog(true);
    };

    window.addEventListener('claude-session-selected', handleSessionSelected as EventListener);
    window.addEventListener('claude-not-found', handleClaudeNotFound as EventListener);
    return () => {
      window.removeEventListener('claude-session-selected', handleSessionSelected as EventListener);
      window.removeEventListener('claude-not-found', handleClaudeNotFound as EventListener);
    };
  }, [openSessionInBackground, switchToTab, navigateTo]);

  // Listen for completion events from all engines
  useEffect(() => {
    let unlistenClaude: UnlistenFn | null = null;
    let unlistenCodex: UnlistenFn | null = null;
    let unlistenGemini: UnlistenFn | null = null;
    
    const setupListeners = async () => {
      // Claude completion events
      unlistenClaude = await listen<boolean>('claude-complete', async (event) => {
        if (event.payload === true) {
          loadProjects(); // Refresh projects to update counts/timestamps
          if (selectedProject) {
            refreshSessions();
          }
        }
      });

      // Codex completion events
      unlistenCodex = await listen<boolean>('codex-complete', async (event) => {
        if (event.payload === true) {
          loadProjects(); // Refresh projects to update counts/timestamps
          if (selectedProject) {
            refreshSessions();
          }
        }
      });

      // Gemini completion events
      unlistenGemini = await listen<boolean>('gemini-complete', async (event) => {
        if (event.payload === true) {
          loadProjects(); // Refresh projects to update counts/timestamps
          if (selectedProject) {
            refreshSessions();
          }
        }
      });
    };
    
    setupListeners();
    
    return () => {
      if (unlistenClaude) unlistenClaude();
      if (unlistenCodex) unlistenCodex();
      if (unlistenGemini) unlistenGemini();
    };
  }, [loadProjects, selectedProject, refreshSessions]);

  // Handlers
  const handleSessionDelete = async (sessionId: string, projectId: string) => {
    try {
      // Find the session to check its engine type
      const session = sessions.find(s => s.id === sessionId);
      const engine = (session as any)?.engine;

      if (engine === 'codex') {
        // Delete Codex session
        await api.deleteCodexSession(sessionId);
      } else if (engine === 'gemini') {
        // Delete Gemini session - need project path from selectedProject
        if (selectedProject) {
          await api.deleteGeminiSession(selectedProject.path, sessionId);
        } else {
          throw new Error('No project selected for Gemini session deletion');
        }
      } else {
        // Delete Claude session
        await api.deleteSession(sessionId, projectId);
      }

      refreshSessions();
      setToast({ message: `会话已成功删除`, type: "success" });
    } catch (err) {
      console.error("Failed to delete session:", err);
      setToast({ message: `删除会话失败`, type: "error" });
      // Still refresh sessions to reflect any state changes
      refreshSessions();
    }
  };

  const handleSessionsBatchDelete = async (sessionIds: string[], projectId: string) => {
    try {
      // Separate Claude, Codex and Gemini sessions
      const claudeSessionIds: string[] = [];
      const codexSessionIds: string[] = [];
      const geminiSessionIds: string[] = [];

      sessionIds.forEach(id => {
        const session = sessions.find(s => s.id === id);
        if (session) {
          const engine = (session as any).engine;
          if (engine === 'codex') {
            codexSessionIds.push(id);
          } else if (engine === 'gemini') {
            geminiSessionIds.push(id);
          } else {
            claudeSessionIds.push(id);
          }
        }
      });

      // 并行删除所有类型的会话
      const deletePromises: Promise<any>[] = [];

      // Codex 会话并行删除
      if (codexSessionIds.length > 0) {
        deletePromises.push(
          Promise.all(codexSessionIds.map(id => api.deleteCodexSession(id)))
        );
      }

      // Gemini 会话并行删除
      if (geminiSessionIds.length > 0 && selectedProject) {
        deletePromises.push(
          Promise.all(geminiSessionIds.map(id => api.deleteGeminiSession(selectedProject.path, id)))
        );
      }

      // Claude 会话批量删除
      if (claudeSessionIds.length > 0) {
        deletePromises.push(api.deleteSessionsBatch(claudeSessionIds, projectId));
      }

      // 等待所有删除操作完成
      await Promise.all(deletePromises);

      refreshSessions();
      setToast({ message: `成功删除 ${sessionIds.length} 个会话`, type: "success" });
    } catch (err) {
      console.error("Failed to batch delete sessions:", err);
      setToast({ message: `批量删除会话失败`, type: "error" });
      // Still refresh to reflect any partial deletions
      refreshSessions();
    }
  };

  const handleSessionConvert = async (sessionId: string, targetEngine: 'claude' | 'codex', projectId: string, projectPath: string) => {
    try {
      const result = await api.convertSession(sessionId, targetEngine, projectId, projectPath);

      if (result.success) {
        refreshSessions();
        setToast({
          message: `会话已成功转换到 ${targetEngine === 'claude' ? 'Claude' : 'Codex'}！新会话 ID: ${result.newSessionId.substring(0, 8)}...`,
          type: "success"
        });
      } else {
        setToast({ message: `转换失败: ${result.error || '未知错误'}`, type: "error" });
      }
    } catch (err) {
      console.error("Failed to convert session:", err);
      setToast({ message: `转换会话失败: ${err}`, type: "error" });
    }
  };

  const handleUnifiedProjectDelete = async (project: import('@/lib/api').UnifiedProject) => {
    try {
      // Delete Claude project if exists
      if (project.engines.claude?.projectId) {
        const claudeProject = projects.find(p => p.id === project.engines.claude?.projectId);
        if (claudeProject) {
          await deleteProject(claudeProject);
        }
      }
      
      // Delete Codex sessions if exists (Codex-only project)
      if (project.engines.codex && project.engines.codex.sessionCount > 0 && !project.engines.claude) {
        // Get all Codex sessions for this project and delete them
        const codexSessions = await api.listCodexSessionsForProject(project.path);
        await Promise.all(codexSessions.map(s => api.deleteCodexSession(s.id)));
      }
      
      // Refresh project list
      await loadProjects();
      setToast({ message: `项目 "${project.name}" 已删除成功`, type: "success" });
    } catch (err) {
      console.error("Failed to delete project:", err);
      setToast({ message: `删除项目失败: ${err}`, type: "error" });
    }
  };

  const handleUnifiedProjectsBatchDelete = async (projectsToDelete: import('@/lib/api').UnifiedProject[]) => {
    try {
      let deletedCount = 0;
      
      for (const project of projectsToDelete) {
        // Delete Claude project if exists
        if (project.engines.claude?.projectId) {
          const claudeProject = projects.find(p => p.id === project.engines.claude?.projectId);
          if (claudeProject) {
            await deleteProject(claudeProject);
            deletedCount++;
          }
        }
        
        // Delete Codex sessions if exists (Codex-only project)
        if (project.engines.codex && project.engines.codex.sessionCount > 0 && !project.engines.claude) {
          const codexSessions = await api.listCodexSessionsForProject(project.path);
          await Promise.all(codexSessions.map(s => api.deleteCodexSession(s.id)));
          deletedCount++;
        }
      }
      
      // Refresh project list
      await loadProjects();
      setToast({ message: `成功删除 ${deletedCount} 个项目`, type: "success" });
    } catch (err) {
      console.error("Failed to batch delete projects:", err);
      setToast({ message: `批量删除项目失败: ${err}`, type: "error" });
    }
  };

  // Render Logic
  const renderContent = () => {
    switch (currentView) {
      case "enhanced-hooks-manager":
        return (
          <EnhancedHooksManager
            onBack={goBack}
            projectPath={viewParams.projectPath}
          />
        );

      case "claude-extensions":
        return (
          <div className="flex-1 overflow-y-auto">
            <div className="container mx-auto p-6">
              <ClaudeExtensionsManager
                projectPath={viewParams.projectPath}
                onBack={goBack}
              />
            </div>
          </div>
        );

      case "editor":
        return (
          <div className="flex-1 overflow-hidden">
            <MarkdownEditor onBack={goBack} />
          </div>
        );

      case "codex-editor":
        return (
          <div className="flex-1 overflow-hidden">
            <CodexPromptManager 
              onBack={goBack} 
            />
          </div>
        );

      case "gemini-editor":
        return (
          <div className="flex-1 overflow-hidden">
            <GeminiMarkdownEditor onBack={goBack} />
          </div>
        );

      case "prompts":
        return (
          <div className="flex-1 overflow-y-auto">
            <div className="container mx-auto p-6">
              <PromptCenter onBack={goBack} defaultEngine="codex" />
            </div>
          </div>
        );

      case "settings":
        return (
          <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
            <Settings 
              onBack={goBack} 
              initialTab={viewParams.initialTab}
            />
          </div>
        );

      case "projects":
        return (
          <div className="flex-1 overflow-y-auto">
            <div className="container mx-auto p-6">
              {!selectedProject && (
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h1 className="text-3xl font-bold tracking-tight">{t('common.ccProjectsTitle')}</h1>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('common.browseClaudeSessions')}
                    </p>
                  </div>
                  <Button
                    onClick={() => navigateTo("claude-tab-manager", { initialProjectPath: "__NEW_PROJECT__" })}
                    size="default"
                    className="flex-shrink-0 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-sm transition-all duration-200 hover:shadow-md"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t('common.newProject')}
                  </Button>
                </div>
              )}

              {error && (
                <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive max-w-2xl">
                  {error}
                </div>
              )}

              {loading && (
                <>
                  {(selectedProject || selectedUnifiedProject) ? (
                    <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                      {[...Array(8)].map((_, i) => (
                        <SessionListItemSkeleton key={i} />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {[...Array(6)].map((_, i) => (
                        <ProjectCardSkeleton key={i} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {!loading && (
                <>
                  {(selectedProject || selectedUnifiedProject) ? (
                    <div>
                      <SessionList
                        sessions={sessions}
                        projectPath={selectedUnifiedProject?.path || selectedProject?.path || ''}
                        onBack={clearSelection}
                        onEditClaudeFile={(file) => navigateTo("claude-file-editor", { file })}
                        onSessionDelete={handleSessionDelete}
                        onSessionsBatchDelete={handleSessionsBatchDelete}
                        onSessionConvert={handleSessionConvert}
                        initialEngineFilter={engineFilter}
                        onRefresh={handleRefreshSessions}
                        isRefreshing={isRefreshingSessions}
                        onSessionClick={(session) => {
                          const result = openSessionInBackground(session);
                          switchToTab(result.tabId);
                          navigateTo("claude-tab-manager");
                          if (result.isNew) {
                            setToast({ message: `会话 ${session.id.slice(-8)} 已打开`, type: "success" });
                          } else {
                            setToast({ message: `已切换到会话 ${session.id.slice(-8)}`, type: "info" });
                          }
                        }}
                        onNewSession={(projectPath) => {
                          // 🔧 FIX: 传递当前引擎筛选器，避免新建会话时显示错误的引擎类型
                          const initialEngine = engineFilter !== 'all' ? engineFilter : undefined;
                          navigateTo("claude-tab-manager", { initialProjectPath: projectPath, initialEngine });
                        }}
                      />
                    </div>
                  ) : (
                    <div>
                      <RunningClaudeSessions
                        onSessionClick={(session) => {
                          const result = openSessionInBackground(session);
                          switchToTab(result.tabId);
                          navigateTo("claude-tab-manager");
                          if (result.isNew) {
                            setToast({ message: `会话 ${session.id.slice(-8)} 已打开`, type: "success" });
                          } else {
                            setToast({ message: `已切换到会话 ${session.id.slice(-8)}`, type: "info" });
                          }
                        }}
                      />

                      <ProjectList
                        projects={filteredProjects}
                        onProjectClick={selectUnifiedProject}
                        onProjectSettings={(project) => navigateTo("project-settings", { project })}
                        onProjectDelete={handleUnifiedProjectDelete}
                        onProjectsBatchDelete={handleUnifiedProjectsBatchDelete}
                        onProjectsChanged={loadProjects}
                        loading={loading}
                        engineFilter={engineFilter}
                        onEngineFilterChange={setEngineFilter}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );

      case "claude-file-editor":
        return viewParams.file ? (
          <ClaudeFileEditor
            file={viewParams.file}
            onBack={goBack}
          />
        ) : null;

      case "claude-code-session":
        return (
          <ClaudeCodeSession
            session={viewParams.initialSession}
            initialProjectPath={viewParams.initialProjectPath}
            onStreamingChange={(isStreaming) => {
              // Navigation protection
              if (isStreaming) {
                setNavigationInterceptor((nextView) => {
                  setPendingView(nextView);
                  setShowNavigationConfirm(true);
                  return false;
                });
              } else {
                setNavigationInterceptor(null);
              }
            }}
          />
        );

      case "claude-tab-manager":
        // 🔧 FIX: TabManager is now rendered outside AnimatePresence to preserve state
        // Return null here as it's handled separately
        return null;

      case "usage-dashboard":
        return <UsageDashboard onBack={goBack} />;

      case "mcp":
        return <MCPManager onBack={goBack} />;

      case "project-settings":
        if (viewParams.project) {
          return (
            <ProjectSettings
              project={viewParams.project}
              onBack={goBack}
            />
          );
        }
        break;

      default:
        return null;
    }
  };

  // 🔧 FIX: Track if TabManager has ever been visited to keep it mounted
  // This prevents session history from being lost due to component unmount
  const [hasVisitedTabManager, setHasVisitedTabManager] = useState(false);
  
  // Update hasVisitedTabManager when navigating to claude-tab-manager
  useEffect(() => {
    if (currentView === 'claude-tab-manager') {
      setHasVisitedTabManager(true);
    }
  }, [currentView]);

  // Check if we should show TabManager (either current view or has been visited)
  const showTabManager = currentView === 'claude-tab-manager' || hasVisitedTabManager;

  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-hidden relative">
      {/* 🔧 FIX: Keep TabManager mounted but hidden to preserve session state */}
      {/* TabManager uses flex layout instead of absolute to properly respect parent width */}
      {showTabManager && (
        <div 
          className={cn(
            "flex-1 flex flex-col h-full w-full overflow-hidden",
            currentView !== 'claude-tab-manager' && "hidden"
          )}
        >
          <TabManager
            initialSession={currentView === 'claude-tab-manager' ? viewParams.initialSession : undefined}
            initialProjectPath={currentView === 'claude-tab-manager' ? viewParams.initialProjectPath : undefined}
            initialEngine={currentView === 'claude-tab-manager' ? viewParams.initialEngine : undefined}
            onBack={() => navigateTo("projects")}
          />
        </div>
      )}

      {/* ✨ AnimatePresence for smooth page transitions (excluding TabManager) */}
      {currentView !== 'claude-tab-manager' && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={currentView}
            initial="initial"
            animate="in"
            exit="out"
            variants={pageVariants}
            transition={pageTransition}
            className="flex-1 flex flex-col h-full overflow-hidden"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      )}

      <ClaudeBinaryDialog
        open={showClaudeBinaryDialog}
        onOpenChange={setShowClaudeBinaryDialog}
        onSuccess={() => {
          setToast({ message: t('messages.saved'), type: "success" });
          window.location.reload();
        }}
        onError={(message) => setToast({ message, type: "error" })}
      />

      <Dialog open={showNavigationConfirm} onOpenChange={setShowNavigationConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认离开</DialogTitle>
            <DialogDescription>
              Claude 正在处理您的请求。确定要离开当前会话吗？这将中断正在进行的对话。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowNavigationConfirm(false);
              setPendingView(null);
            }}>
              取消
            </Button>
            <Button onClick={() => {
              setNavigationInterceptor(null); // Clear interceptor to allow navigation
              setShowNavigationConfirm(false);
              if (pendingView) {
                navigateTo(pendingView);
              }
            }}>
              确定离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </ToastContainer>
    </div>
  );
};
