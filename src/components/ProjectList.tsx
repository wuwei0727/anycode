import React, { useState } from "react";
import {
  FolderOpen,
  FileText,
  Settings,
  MoreVertical,
  Trash2,
  Archive,
  LayoutGrid,
  List,
  CheckSquare,
  Square,
  X,
  RefreshCw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { type EngineFilter } from "@/lib/api";
import { EngineFilter as EngineFilterComponent } from "@/components/EngineFilter";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UnifiedProject } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatAbsoluteDateTime } from "@/lib/date-utils";
import { Pagination } from "@/components/ui/pagination";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DeletedProjects } from "./DeletedProjects";
import { ProjectListSkeleton } from "@/components/skeletons/ProjectListSkeleton";

interface ProjectListProps {
  /**
   * Array of unified projects to display (supports multi-engine)
   */
  projects: UnifiedProject[];
  /**
   * Callback when a project is clicked
   */
  onProjectClick: (project: UnifiedProject) => void;
  /**
   * Callback when hooks configuration is clicked
   */
  onProjectSettings?: (project: UnifiedProject) => void;
  /**
   * Callback when a project is deleted
   */
  onProjectDelete?: (project: UnifiedProject) => Promise<void>;
  /**
   * Callback when multiple projects are deleted
   */
  onProjectsBatchDelete?: (projects: UnifiedProject[]) => Promise<void>;
  /**
   * Callback when projects are changed (for refresh)
   */
  onProjectsChanged?: () => void;
  /**
   * Whether the list is currently loading
   */
  loading?: boolean;
  /**
   * Optional className for styling
   */
  className?: string;
  /**
   * Current engine filter
   */
  engineFilter?: EngineFilter;
  /**
   * Callback when engine filter changes
   */
  onEngineFilterChange?: (filter: EngineFilter) => void;
}

const ITEMS_PER_PAGE = 12;

/**
 * Extracts the project name from the full path
 * Handles both Windows (\) and Unix (/) path separators
 */
const getProjectName = (path: string): string => {
  if (!path) return 'Unknown Project';
  
  // Normalize path separators and split
  const normalizedPath = path.replace(/\\/g, '/');
  const parts = normalizedPath.split('/').filter(Boolean);
  
  // Get the last non-empty part (directory name)
  const projectName = parts[parts.length - 1];
  
  // Fallback to the original path if we can't extract a name
  return projectName || path;
};

/**
 * ProjectList component - Displays a paginated list of projects with hover animations
 * 
 * @example
 * <ProjectList
 *   projects={projects}
 *   onProjectClick={(project) => console.log('Selected:', project)}
 * />
 */
export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  onProjectClick,
  onProjectSettings,
  onProjectDelete,
  onProjectsBatchDelete,
  onProjectsChanged,
  loading,
  className,
  engineFilter = 'all',
  onEngineFilterChange,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [batchDeleteDialogOpen, setBatchDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<UnifiedProject | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState("active");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  
  // Calculate pagination
  const totalPages = Math.ceil(projects.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const currentProjects = projects.slice(startIndex, endIndex);
  


  // Reset to page 1 if projects change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [projects.length]);

  const handleDeleteProject = (project: UnifiedProject) => {
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!projectToDelete || !onProjectDelete) return;
    
    setIsDeleting(true);
    try {
      await onProjectDelete(projectToDelete);
      setDeleteDialogOpen(false);
      setProjectToDelete(null);
    } catch (error) {
      console.error('Failed to delete project:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteDialogOpen(false);
    setProjectToDelete(null);
  };

  // Toggle project selection
  const toggleProjectSelection = (projectPath: string) => {
    setSelectedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectPath)) {
        newSet.delete(projectPath);
      } else {
        newSet.add(projectPath);
      }
      return newSet;
    });
  };

  // Select all projects on current page
  const selectAllOnPage = () => {
    const allPaths = currentProjects.map(p => p.path);
    const allSelected = allPaths.every(path => selectedProjects.has(path));
    
    if (allSelected) {
      // Deselect all on current page
      setSelectedProjects(prev => {
        const newSet = new Set(prev);
        allPaths.forEach(path => newSet.delete(path));
        return newSet;
      });
    } else {
      // Select all on current page
      setSelectedProjects(prev => {
        const newSet = new Set(prev);
        allPaths.forEach(path => newSet.add(path));
        return newSet;
      });
    }
  };

  // Exit select mode
  const exitSelectMode = () => {
    setIsSelectMode(false);
    setSelectedProjects(new Set());
  };

  // Confirm batch delete
  const confirmBatchDelete = async () => {
    if (selectedProjects.size === 0 || !onProjectsBatchDelete) return;
    
    setIsDeleting(true);
    try {
      const projectsToDelete = projects.filter(p => selectedProjects.has(p.path));
      await onProjectsBatchDelete(projectsToDelete);
      setBatchDeleteDialogOpen(false);
      exitSelectMode();
    } catch (error) {
      console.error('Failed to batch delete projects:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  /**
   * Get session breakdown by engine for a unified project
   */
  const getSessionBreakdown = (project: UnifiedProject): { claude: number; codex: number; gemini: number; total: number } => {
    return {
      claude: project.engines.claude?.sessionCount || 0,
      codex: project.engines.codex?.sessionCount || 0,
      gemini: project.engines.gemini?.sessionCount || 0,
      total: project.totalSessions,
    };
  };

  const getSessionCountForFilter = (
    breakdown: { claude: number; codex: number; gemini: number; total: number },
    filter: EngineFilter
  ): number => {
    switch (filter) {
      case 'claude':
        return breakdown.claude;
      case 'codex':
        return breakdown.codex;
      case 'gemini':
        return breakdown.gemini;
      case 'all':
      default:
        return breakdown.total;
    }
  };

  const ProjectGrid = () => {
    if (loading) {
      return <ProjectListSkeleton />;
    }

    return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2 gap-4">
        {/* Engine Filter */}
        {onEngineFilterChange && !isSelectMode && (
          <EngineFilterComponent
            value={engineFilter}
            onChange={onEngineFilterChange}
          />
        )}

        {/* 刷新按钮 */}
        {!isSelectMode && onProjectsChanged && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onProjectsChanged}
              className="h-8"
              title="刷新项目列表"
            >
              <RefreshCw className="h-4 w-4 mr-1.5" />
              刷新
            </Button>
          </div>
        )}

        {/* Select Mode Controls */}
        {isSelectMode && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={selectAllOnPage}
              className="h-8"
            >
              {currentProjects.every(p => selectedProjects.has(p.path)) ? (
                <>
                  <CheckSquare className="h-4 w-4 mr-1.5" />
                  取消全选
                </>
              ) : (
                <>
                  <Square className="h-4 w-4 mr-1.5" />
                  全选本页
                </>
              )}
            </Button>
            <span className="text-sm text-muted-foreground">
              已选择 {selectedProjects.size} 个项目
            </span>
            {selectedProjects.size > 0 && onProjectsBatchDelete && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBatchDeleteDialogOpen(true)}
                className="h-8"
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                批量删除
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={exitSelectMode}
              className="h-8 w-8"
              title="退出选择模式"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        
        {/* View Mode Toggle & Select Mode Button */}
        <div className="flex items-center gap-2">
          {!isSelectMode && onProjectsBatchDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSelectMode(true)}
              className="h-8"
            >
              <CheckSquare className="h-4 w-4 mr-1.5" />
              批量操作
            </Button>
          )}
          <div className="flex items-center bg-muted/50 rounded-lg p-1">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setViewMode("grid")}
              className="h-7 w-7"
              title="网格视图"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setViewMode("list")}
              className="h-7 w-7"
              title="列表视图"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Empty state when no projects */}
      {currentProjects.length === 0 ? (
        <div className="py-12 text-center">
          <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">
            {engineFilter === 'all' 
              ? '暂无项目' 
              : `暂无 ${engineFilter === 'claude' ? 'Claude' : engineFilter === 'codex' ? 'Codex' : 'Gemini'} 项目`}
          </p>
          {engineFilter !== 'all' && (
            <p className="text-xs text-muted-foreground mt-1">
              尝试切换到其他引擎筛选器查看更多项目
            </p>
          )}
        </div>
      ) : (
        <>
          <div
            className={cn(
              "grid gap-3",
              viewMode === "grid"
                ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
                : "grid-cols-1"
            )}
            role="list"
            aria-label="项目列表"
          >
            {currentProjects.map((project) => {
              const projectName = project.name || getProjectName(project.path);
              const sessionBreakdown = getSessionBreakdown(project);
          const sessionCount = getSessionCountForFilter(sessionBreakdown, engineFilter);
          const isSelected = selectedProjects.has(project.path);

          return (
            <div
              key={project.path}
              role="listitem"
              tabIndex={0}
              onClick={() => {
                if (isSelectMode) {
                  toggleProjectSelection(project.path);
                } else {
                  onProjectClick(project);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isSelectMode) {
                    toggleProjectSelection(project.path);
                  } else {
                    onProjectClick(project);
                  }
                }
              }}
              className={cn(
                "w-full text-left rounded-lg bg-card border transition-all duration-200 group cursor-pointer relative",
                viewMode === "grid" ? "px-5 py-4" : "px-4 py-3 flex items-center gap-4",
                isSelectMode && isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border/40 hover:border-primary/50 hover:bg-muted/40 hover:shadow-md"
              )}
              aria-label={`项目 ${projectName}，包含 ${sessionCount} 个会话，最后活动于 ${formatAbsoluteDateTime(project.lastActivity)}`}
            >
              {/* 主要信息区：项目图标 + 项目名称 */}
              <div className={cn("flex items-start gap-3", viewMode === "grid" ? "mb-2" : "flex-1 items-center mb-0")}>
                {/* 选择模式下显示复选框 */}
                {isSelectMode ? (
                  <div className="p-2 rounded-md shrink-0">
                    {isSelected ? (
                      <CheckSquare className="h-5 w-5 text-primary" aria-hidden="true" />
                    ) : (
                      <Square className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                    )}
                  </div>
                ) : (
                  <div className="p-2 rounded-md bg-primary/10 text-primary shrink-0">
                    <FolderOpen className="h-5 w-5" aria-hidden="true" />
                  </div>
                )}
                <div className={cn("min-w-0", viewMode === "grid" ? "flex-1 pr-20" : "flex-1")}>
                  <h3 className="font-semibold text-base truncate text-foreground group-hover:text-primary transition-colors">
                    {projectName}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {viewMode === "grid" ? formatAbsoluteDateTime(project.lastActivity) : project.path}
                  </p>
                </div>
              </div>

              {/* 路径信息 (仅网格视图) */}
              {viewMode === "grid" && (
                <p
                  className="text-xs text-muted-foreground truncate font-mono"
                  aria-label={`路径: ${project.path}`}
                  title={project.path}
                >
                  {project.path}
                </p>
              )}

              {/* 列表视图的额外信息 */}
              {viewMode === "list" && (
                <div className="text-xs text-muted-foreground hidden md:block w-32 text-right">
                  {formatAbsoluteDateTime(project.lastActivity)}
                </div>
              )}

              {/* 右上角：会话数徽章 + 操作菜单 */}
              <div className={cn(
                "flex items-center gap-2",
                viewMode === "grid" ? "absolute top-4 right-4" : ""
              )}>
                {/* 会话数徽章 with Tooltip */}
                {sessionCount > 0 && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          className="flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 text-primary rounded-full cursor-default hover:bg-primary/20 transition-colors"
                          aria-label={`${sessionCount} 个会话`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="text-sm font-medium">{sessionCount}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="p-0">
                        <div className="px-3 py-2 space-y-1.5 min-w-[140px]">
                          <p className="text-xs font-medium text-foreground border-b border-border pb-1.5 mb-1.5">会话明细</p>
                          {engineFilter === 'all' ? (
                            <>
                              {sessionBreakdown.claude > 0 && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground">Claude Code</span>
                                  <span className="font-medium">{sessionBreakdown.claude}</span>
                                </div>
                              )}
                              {sessionBreakdown.codex > 0 && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground">Codex</span>
                                  <span className="font-medium">{sessionBreakdown.codex}</span>
                                </div>
                              )}
                              {sessionBreakdown.gemini > 0 && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground">Gemini</span>
                                  <span className="font-medium">{sessionBreakdown.gemini}</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">
                                {engineFilter === 'claude' ? 'Claude Code' : engineFilter === 'codex' ? 'Codex' : 'Gemini'}
                              </span>
                              <span className="font-medium">{sessionCount}</span>
                            </div>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* 操作菜单 */}
                {(onProjectSettings || onProjectDelete) && (
                  <div className={cn(
                    "transition-opacity",
                    viewMode === "grid" ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" : "opacity-100"
                  )}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="h-8 w-8 hover:bg-muted"
                          aria-label={`${projectName} 项目操作菜单`}
                        >
                          <MoreVertical className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {onProjectSettings && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              onProjectSettings(project);
                            }}
                          >
                            <Settings className="h-4 w-4 mr-2" aria-hidden="true" />
                            Hooks 配置
                          </DropdownMenuItem>
                        )}
                        {onProjectSettings && onProjectDelete && (
                          <DropdownMenuSeparator />
                        )}
                        {onProjectDelete && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteProject(project);
                            }}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" aria-hidden="true" />
                            删除项目
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>
          );
            })}
          </div>
          
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
          />
        </>
      )}
    </div>
  );
  };

  return (
    <div className={cn("space-y-4", className)}>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="active" className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            活跃项目
          </TabsTrigger>
          <TabsTrigger value="deleted" className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            已删除项目
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="active" className="mt-6">
          <ProjectGrid />
        </TabsContent>
        
        <TabsContent value="deleted" className="mt-6">
          <DeletedProjects onProjectRestored={onProjectsChanged} />
        </TabsContent>
      </Tabs>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除项目</DialogTitle>
            <DialogDescription>
              您确定要删除项目 "{projectToDelete ? getProjectName(projectToDelete.path) : ""}" 吗？
              这将删除所有相关的会话数据和Todo文件，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={cancelDelete}
              disabled={isDeleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Delete Confirmation Dialog */}
      <Dialog open={batchDeleteDialogOpen} onOpenChange={setBatchDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认批量删除</DialogTitle>
            <DialogDescription>
              您确定要删除选中的 {selectedProjects.size} 个项目吗？
              这将删除所有相关的会话数据和Todo文件，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmBatchDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "删除中..." : `删除 ${selectedProjects.size} 个项目`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}; 
