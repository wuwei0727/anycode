import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FolderOpen, CheckCircle, Loader2, ToggleLeft, ToggleRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, MCPEngineType } from "@/lib/api";

interface MCPMultiProjectDialogProps {
  /**
   * 是否打开对话框
   */
  open: boolean;
  /**
   * 关闭对话框回调
   */
  onOpenChange: (open: boolean) => void;
  /**
   * MCP 服务器名称
   */
  serverName: string;
  /**
   * 当前引擎
   */
  engine: MCPEngineType;
  /**
   * 操作完成回调
   */
  onComplete?: (message: string, success: boolean) => void;
}

interface ProjectInfo {
  path: string;
  disabled: boolean;
}

/**
 * MCP 多项目批量管理对话框
 * 允许用户选择多个项目,批量启用/禁用特定的 MCP 服务器
 */
export const MCPMultiProjectDialog: React.FC<MCPMultiProjectDialogProps> = ({
  open,
  onOpenChange,
  serverName,
  engine,
  onComplete,
}) => {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);

  // 加载项目列表
  useEffect(() => {
    if (open && (engine === "claude" || engine === "codex")) {
      loadProjects();
    }
  }, [open, serverName, engine]);

  /**
   * 加载项目列表和禁用状态
   */
  const loadProjects = async () => {
    setLoading(true);
    try {
      const projectList = await api.mcpGetProjectList(serverName, engine);
      setProjects(projectList);
    } catch (error) {
      console.error("Failed to load projects:", error);
      onComplete?.("加载项目列表失败", false);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 切换项目选择
   */
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

  /**
   * 全选/取消全选
   */
  const toggleSelectAll = () => {
    if (selectedProjects.size === projects.length) {
      setSelectedProjects(new Set());
    } else {
      setSelectedProjects(new Set(projects.map(p => p.path)));
    }
  };

  /**
   * 批量启用
   */
  const handleBatchEnable = async () => {
    if (selectedProjects.size === 0) return;

    setProcessing(true);
    try {
      const promises = Array.from(selectedProjects).map(projectPath =>
        api.mcpSetEnabledForProject(engine, serverName, projectPath, true)
      );
      await Promise.all(promises);
      onComplete?.(`已在 ${selectedProjects.size} 个项目中启用服务器 "${serverName}"`, true);
      onOpenChange(false);
    } catch (error) {
      console.error("Batch enable failed:", error);
      onComplete?.(`批量启用失败: ${error}`, false);
    } finally {
      setProcessing(false);
    }
  };

  /**
   * 批量禁用
   */
  const handleBatchDisable = async () => {
    if (selectedProjects.size === 0) return;

    setProcessing(true);
    try {
      const promises = Array.from(selectedProjects).map(projectPath =>
        api.mcpSetEnabledForProject(engine, serverName, projectPath, false)
      );
      await Promise.all(promises);
      onComplete?.(`已在 ${selectedProjects.size} 个项目中禁用服务器 "${serverName}"`, true);
      onOpenChange(false);
    } catch (error) {
      console.error("Batch disable failed:", error);
      onComplete?.(`批量禁用失败: ${error}`, false);
    } finally {
      setProcessing(false);
    }
  };

  const isAllSelected = projects.length > 0 && selectedProjects.size === projects.length;
  const isSomeSelected = selectedProjects.size > 0 && selectedProjects.size < projects.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>多项目管理: {serverName}</DialogTitle>
          <DialogDescription>
            选择多个项目,批量启用或禁用该 MCP 服务器
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <FolderOpen className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-muted-foreground">暂无项目</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 全选 */}
              <div className="flex items-center gap-2 border-b border-border pb-3">
                <Checkbox
                  checked={isSomeSelected ? "indeterminate" : isAllSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={processing}
                />
                <span className="text-sm font-medium">
                  全选 ({selectedProjects.size} / {projects.length})
                </span>
              </div>

              {/* 项目列表 */}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                <AnimatePresence>
                  {projects.map((project) => {
                    const isSelected = selectedProjects.has(project.path);
                    return (
                      <motion.div
                        key={project.path}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -10 }}
                        className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "border-border bg-card hover:bg-accent/5"
                        }`}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleProjectSelection(project.path)}
                          disabled={processing}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm font-mono truncate">{project.path}</span>
                          </div>
                        </div>
                        <div className="flex-shrink-0">
                          {project.disabled ? (
                            <span className="text-xs text-muted-foreground">已禁用</span>
                          ) : (
                            <CheckCircle className="h-4 w-4 text-green-500" />
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={processing}
          >
            取消
          </Button>
          <Button
            variant="outline"
            onClick={handleBatchDisable}
            disabled={processing || selectedProjects.size === 0}
            className="gap-2 hover:bg-gray-500/10 hover:text-gray-600"
          >
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ToggleLeft className="h-4 w-4" />
            )}
            批量禁用
          </Button>
          <Button
            onClick={handleBatchEnable}
            disabled={processing || selectedProjects.size === 0}
            className="gap-2"
          >
            {processing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ToggleRight className="h-4 w-4" />
            )}
            批量启用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
