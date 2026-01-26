import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Trash2, 
  RotateCcw, 
  FolderOpen, 
  AlertTriangle,
  Archive,
  CheckCircle2,
  CheckSquare,
  Square,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import * as api from "@/lib/api";
import type { Project } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DeletedProjectsProps {
  /**
   * Callback when a project is restored
   */
  onProjectRestored?: () => void;
  /**
   * Optional className for styling
   */
  className?: string;
}

/**
 * Component for managing deleted/hidden projects
 * Allows users to restore or permanently delete projects
 */
export const DeletedProjects: React.FC<DeletedProjectsProps> = ({
  onProjectRestored,
  className
}) => {
  const [deletedProjects, setDeletedProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [permanentDeleteDialog, setPermanentDeleteDialog] = useState<{
    open: boolean;
    projectId: string | null;
  }>({ open: false, projectId: null });
  const [batchRestoreDialog, setBatchRestoreDialog] = useState(false);
  const [batchDeleteDialog, setBatchDeleteDialog] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);

  // Load hidden projects with intelligent path detection
  const loadDeletedProjects = async () => {
    try {
      setLoading(true);
      
      // Get list of hidden project IDs (now with intelligent directory validation)
      const hiddenIds = await api.api.listHiddenProjects();
      
      if (hiddenIds.length === 0) {
        setDeletedProjects([]);
        setLoading(false);
        return;
      }
      
      // Create project objects with improved path decoding
      const projects: Project[] = [];
      
      for (const projectId of hiddenIds) {
        // Improved path decoding logic
        let decodedPath = projectId;
        
        // Handle single-dash format (Claude CLI standard)
        if (projectId.includes('-') && !projectId.includes('--')) {
          decodedPath = projectId
            .replace(/-/g, '/')
            .replace(/^C\//, 'C:/')
            .replace(/^\/+/, '/');
        }
        // Handle double-dash format (legacy claude-workbench)
        else if (projectId.includes('--')) {
          decodedPath = projectId
            .replace(/--/g, '/')
            .replace(/^C\//, 'C:/')
            .replace(/^\/+/, '/');
        }
        
        // Create project (format type will be determined in UI)
        
        projects.push({
          id: projectId,
          path: decodedPath,
          sessions: [],
          created_at: Date.now() / 1000
        });
      }
      
      setDeletedProjects(projects);
    } catch (error) {
      console.error("Failed to load deleted projects:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDeletedProjects();
  }, []);

  // Restore a project
  const handleRestore = async (projectId: string) => {
    try {
      setRestoring(projectId);
      await api.api.restoreProject(projectId);
      
      // Show success message
      setSuccessMessage(`项目已成功恢复`);
      setTimeout(() => setSuccessMessage(null), 3000);
      
      // Reload the list
      await loadDeletedProjects();
      
      // Notify parent component
      if (onProjectRestored) {
        onProjectRestored();
      }
    } catch (error) {
      console.error("Failed to restore project:", error);
    } finally {
      setRestoring(null);
    }
  };

  // Permanently delete a project (remove from file system)
  const handlePermanentDelete = async () => {
    if (!permanentDeleteDialog.projectId) return;

    try {
      setLoading(true);

      // Permanently delete the project files
      await api.api.deleteProjectPermanently(permanentDeleteDialog.projectId);

      // Show success message
      setSuccessMessage(`项目已永久删除`);
      setTimeout(() => setSuccessMessage(null), 3000);

      setPermanentDeleteDialog({ open: false, projectId: null });
      await loadDeletedProjects();

      // Note: We don't call onProjectRestored() here because:
      // 1. The project is permanently deleted, not restored
      // 2. Calling it would trigger unnecessary parent re-renders
      // 3. The deleted projects list is already updated via loadDeletedProjects()
    } catch (error) {
      console.error("Failed to permanently delete project:", error);
      setSuccessMessage(`删除失败: ${error}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } finally {
      setLoading(false);
    }
  };

  // Toggle project selection
  const toggleProjectSelection = (projectId: string) => {
    setSelectedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
      } else {
        newSet.add(projectId);
      }
      return newSet;
    });
  };

  // Select all projects
  const selectAllProjects = () => {
    const allIds = deletedProjects.map(p => p.id);
    const allSelected = allIds.every(id => selectedProjects.has(id));
    
    if (allSelected) {
      setSelectedProjects(new Set());
    } else {
      setSelectedProjects(new Set(allIds));
    }
  };

  // Exit select mode
  const exitSelectMode = () => {
    setIsSelectMode(false);
    setSelectedProjects(new Set());
  };

  // Batch restore projects
  const handleBatchRestore = async () => {
    if (selectedProjects.size === 0) return;
    
    setIsProcessing(true);
    try {
      let restoredCount = 0;
      
      for (const projectId of selectedProjects) {
        await api.api.restoreProject(projectId);
        restoredCount++;
      }
      
      setSuccessMessage(`成功恢复 ${restoredCount} 个项目`);
      setTimeout(() => setSuccessMessage(null), 3000);
      
      setBatchRestoreDialog(false);
      exitSelectMode();
      await loadDeletedProjects();
      
      if (onProjectRestored) {
        onProjectRestored();
      }
    } catch (error) {
      console.error("Failed to batch restore projects:", error);
      setSuccessMessage(`批量恢复失败: ${error}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } finally {
      setIsProcessing(false);
    }
  };

  // Batch permanently delete projects
  const handleBatchPermanentDelete = async () => {
    if (selectedProjects.size === 0) return;
    
    setIsProcessing(true);
    try {
      let deletedCount = 0;
      
      for (const projectId of selectedProjects) {
        await api.api.deleteProjectPermanently(projectId);
        deletedCount++;
      }
      
      setSuccessMessage(`成功永久删除 ${deletedCount} 个项目`);
      setTimeout(() => setSuccessMessage(null), 3000);
      
      setBatchDeleteDialog(false);
      exitSelectMode();
      await loadDeletedProjects();
    } catch (error) {
      console.error("Failed to batch delete projects:", error);
      setSuccessMessage(`批量删除失败: ${error}`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (deletedProjects.length === 0) {
    return (
      <div className="text-center py-12">
        <Archive className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium mb-2">没有已删除的项目</h3>
        <p className="text-sm text-muted-foreground">
          当你删除项目时，它们会显示在这里以便恢复
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* Success message */}
      <AnimatePresence>
        {successMessage && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                {successMessage}
              </AlertDescription>
            </Alert>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info alert */}
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>已删除的项目</AlertTitle>
        <AlertDescription>
          这些项目已被隐藏但文件仍然保留。你可以恢复它们或永久删除。
        </AlertDescription>
      </Alert>

      {/* Batch operation controls */}
      {deletedProjects.length > 0 && (
        <div className="flex items-center justify-between gap-4 p-4 bg-muted/30 rounded-lg">
          {isSelectMode ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={selectAllProjects}
                className="h-8"
              >
                {deletedProjects.every(p => selectedProjects.has(p.id)) ? (
                  <>
                    <CheckSquare className="h-4 w-4 mr-1.5" />
                    取消全选
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4 mr-1.5" />
                    全选
                  </>
                )}
              </Button>
              <span className="text-sm text-muted-foreground">
                已选择 {selectedProjects.size} 个项目
              </span>
              {selectedProjects.size > 0 && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBatchRestoreDialog(true)}
                    className="h-8"
                    disabled={isProcessing}
                  >
                    <RotateCcw className="h-4 w-4 mr-1.5" />
                    批量恢复
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setBatchDeleteDialog(true)}
                    className="h-8"
                    disabled={isProcessing}
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    批量删除
                  </Button>
                </>
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
          ) : (
            <div className="flex items-center justify-between w-full">
              <span className="text-sm text-muted-foreground">
                共 {deletedProjects.length} 个已删除项目
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsSelectMode(true)}
                className="h-8"
              >
                <CheckSquare className="h-4 w-4 mr-1.5" />
                批量操作
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Deleted projects list */}
      <div className="space-y-3">
        {deletedProjects.map((project, index) => (
          <motion.div
            key={project.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: index * 0.05 }}
          >
            <Card 
              className={cn(
                "p-4 cursor-pointer transition-all duration-200",
                isSelectMode && selectedProjects.has(project.id)
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/40"
              )}
              onClick={() => {
                if (isSelectMode) {
                  toggleProjectSelection(project.id);
                }
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {isSelectMode ? (
                    <div className="shrink-0">
                      {selectedProjects.has(project.id) ? (
                        <CheckSquare className="h-5 w-5 text-primary" />
                      ) : (
                        <Square className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                  ) : (
                    <FolderOpen className="h-5 w-5 text-muted-foreground shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {project.path.split(/[\\\/]/).pop() || project.path}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {project.path}
                    </p>
                  </div>
                </div>
                
                {!isSelectMode && (
                  <div className="flex items-center gap-2 ml-4">
                    <Badge variant="secondary" className="shrink-0">
                      已删除
                    </Badge>
                    
                    {/* Format indicator for debugging */}
                    {project.id.includes('--') && (
                      <Badge variant="outline" className="shrink-0 text-xs">
                        旧格式
                      </Badge>
                    )}
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRestore(project.id);
                      }}
                      disabled={restoring === project.id}
                      className="shrink-0"
                    >
                      {restoring === project.id ? (
                        <>
                          <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary mr-2" />
                          恢复中...
                        </>
                      ) : (
                        <>
                          <RotateCcw className="h-4 w-4 mr-2" />
                          恢复
                        </>
                      )}
                    </Button>
                    
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPermanentDeleteDialog({ 
                          open: true, 
                          projectId: project.id 
                        });
                      }}
                      className="shrink-0 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Permanent delete confirmation dialog */}
      <Dialog 
        open={permanentDeleteDialog.open} 
        onOpenChange={(open) => setPermanentDeleteDialog({ 
          open, 
          projectId: null 
        })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久删除项目？</DialogTitle>
            <DialogDescription>
              此操作将永久删除项目及其所有文件。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPermanentDeleteDialog({ 
                open: false, 
                projectId: null 
              })}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handlePermanentDelete}
            >
              永久删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch restore confirmation dialog */}
      <Dialog open={batchRestoreDialog} onOpenChange={setBatchRestoreDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量恢复项目</DialogTitle>
            <DialogDescription>
              您确定要恢复选中的 {selectedProjects.size} 个项目吗？
              这些项目将重新出现在活跃项目列表中。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchRestoreDialog(false)}
              disabled={isProcessing}
            >
              取消
            </Button>
            <Button
              onClick={handleBatchRestore}
              disabled={isProcessing}
            >
              {isProcessing ? "恢复中..." : `恢复 ${selectedProjects.size} 个项目`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch permanent delete confirmation dialog */}
      <Dialog open={batchDeleteDialog} onOpenChange={setBatchDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量永久删除</DialogTitle>
            <DialogDescription>
              您确定要永久删除选中的 {selectedProjects.size} 个项目吗？
              这将删除所有相关的文件，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchDeleteDialog(false)}
              disabled={isProcessing}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleBatchPermanentDelete}
              disabled={isProcessing}
            >
              {isProcessing ? "删除中..." : `永久删除 ${selectedProjects.size} 个项目`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};