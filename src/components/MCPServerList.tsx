import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Network,
  Globe,
  Terminal,
  Trash2,
  Play,
  CheckCircle,
  Loader2,
  RefreshCw,
  FolderOpen,
  User,
  FileText,
  ChevronDown,
  Search,
  FolderGit2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { api, type MCPServerExtended, type MCPEngineType } from "@/lib/api";
import { MCPServerListSkeleton } from "@/components/skeletons/MCPServerListSkeleton";
import { MCPServerEditDialog } from "./MCPServerEditDialog";
import { MCPMultiProjectDialog } from "./MCPMultiProjectDialog";

interface MCPServerListProps {
  /**
   * List of MCP servers to display
   */
  servers: MCPServerExtended[];
  /**
   * Whether the list is loading
   */
  loading: boolean;
  /**
   * Callback when a server is removed
   */
  onServerRemoved: (name: string) => void;
  /**
   * Callback to refresh the server list
   */
  onRefresh: () => void;
  /**
   * Callback when server enabled/disabled status is toggled
   */
  onServerToggle?: (serverName: string, enabled: boolean) => void;
  /**
   * Callback when server is updated
   */
  onServerUpdate?: (server: MCPServerExtended) => void;
  /**
   * Callback when test connection result is available
   */
  onTestResult?: (message: string, success: boolean) => void;
  /**
   * Currently selected engine
   */
  selectedEngine?: MCPEngineType;
}

/**
 * Component for displaying a list of MCP servers
 * Shows servers grouped by scope with status indicators
 */
export const MCPServerList: React.FC<MCPServerListProps> = ({
  servers,
  loading,
  onServerRemoved,
  onRefresh,
  onServerToggle,
  onServerUpdate,
  onTestResult,
  selectedEngine = "claude",
}) => {
  const [removingServer, setRemovingServer] = useState<string | null>(null);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [togglingServer, setTogglingServer] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingServer, setEditingServer] = useState<MCPServerExtended | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [multiProjectDialogOpen, setMultiProjectDialogOpen] = useState(false);
  const [selectedServerForMultiProject, setSelectedServerForMultiProject] = useState<string | null>(null);

  // Filter servers by search query
  const filteredServers = useMemo(() => {
    if (!searchQuery.trim()) return servers;
    const query = searchQuery.toLowerCase();
    return servers.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        server.command?.toLowerCase().includes(query) ||
        server.url?.toLowerCase().includes(query)
    );
  }, [servers, searchQuery]);

  // Group servers by scope
  const serversByScope = filteredServers.reduce((acc, server) => {
    const scope = server.scope || "local";
    if (!acc[scope]) acc[scope] = [];
    acc[scope].push(server);
    return acc;
  }, {} as Record<string, MCPServerExtended[]>);

  /**
   * Opens edit dialog for a server
   */
  const handleEditServer = (server: MCPServerExtended) => {
    setEditingServer(server);
    setEditDialogOpen(true);
  };

  /**
   * Handles server save from edit dialog
   */
  const handleSaveServer = (updatedServer: MCPServerExtended) => {
    if (onServerUpdate) {
      onServerUpdate(updatedServer);
    }
    setEditDialogOpen(false);
    setEditingServer(null);
  };

  /**
   * Opens multi-project dialog for a server
   */
  const handleOpenMultiProject = (serverName: string) => {
    setSelectedServerForMultiProject(serverName);
    setMultiProjectDialogOpen(true);
  };

  /**
   * Removes a server
   */
  const handleRemoveServer = async (name: string) => {
    try {
      setRemovingServer(name);
      await api.mcpRemoveByEngine(selectedEngine, name);
      onServerRemoved(name);
    } catch (error) {
      console.error("Failed to remove server:", error);
    } finally {
      setRemovingServer(null);
    }
  };

  /**
   * Toggles server enabled/disabled status for current project
   */
  const handleToggleServer = async (name: string, enabled: boolean) => {
    if (!onServerToggle) return;
    try {
      setTogglingServer(name);
      await onServerToggle(name, enabled);
    } finally {
      setTogglingServer(null);
    }
  };

  /**
   * Tests connection to a server
   */
  const handleTestConnection = async (name: string) => {
    try {
      setTestingServer(name);
      // Find the server to check its configuration
      const server = servers.find(s => s.name === name);
      if (server) {
        // Check if server has valid configuration
        const hasCommand = !!server.command;
        const hasUrl = !!server.url;
        if (hasCommand || hasUrl) {
          onTestResult?.(`服务器 "${name}" 配置有效`, true);
        } else {
          onTestResult?.(`服务器 "${name}" 缺少命令或 URL 配置`, false);
        }
      } else {
        onTestResult?.(`未找到服务器 "${name}"`, false);
      }
    } catch (error) {
      console.error("Failed to test connection:", error);
      onTestResult?.(`测试连接失败: ${error}`, false);
    } finally {
      setTestingServer(null);
    }
  };

  /**
   * Gets icon for transport type
   */
  const getTransportIcon = (transport: string) => {
    switch (transport) {
      case "stdio":
        return <Terminal className="h-4 w-4 text-amber-500" />;
      case "sse":
        return <Globe className="h-4 w-4 text-emerald-500" />;
      default:
        return <Network className="h-4 w-4 text-blue-500" />;
    }
  };

  /**
   * Gets icon for scope
   */
  const getScopeIcon = (scope: string) => {
    switch (scope) {
      case "local":
        return <User className="h-3 w-3 text-slate-500" />;
      case "project":
        return <FolderOpen className="h-3 w-3 text-orange-500" />;
      case "user":
        return <FileText className="h-3 w-3 text-purple-500" />;
      default:
        return null;
    }
  };

  /**
   * Gets scope display name
   */
  const getScopeDisplayName = (scope: string) => {
    switch (scope) {
      case "local":
        return "Local (Project-specific)";
      case "project":
        return "Project (Shared via .mcp.json)";
      case "user":
        return "User (All projects)";
      default:
        return scope;
    }
  };

  /**
   * Renders a single server item
   */
  const renderServerItem = (server: MCPServerExtended) => {
    const isToggling = togglingServer === server.name;
    const isDisabled = !server.enabled;
    const envCount = Object.keys(server.env || {}).length;

    return (
      <motion.div
        key={server.name}
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        className={`group p-4 rounded-lg border transition-all overflow-hidden border-border bg-card hover:bg-accent/5 hover:border-primary/20 ${
          isDisabled ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          {/* Left side: Info (clickable for edit) */}
          <div
            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
            onClick={() => handleEditServer(server)}
          >
            <div className="p-1 bg-primary/10 rounded flex-shrink-0">
              {getTransportIcon(server.transport)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className={`font-medium truncate ${isDisabled ? "text-muted-foreground" : ""}`}>
                  {server.name}
                </h4>
                {server.enabled ? (
                  <Badge variant="outline" className="gap-1 flex-shrink-0 border-green-500/50 text-green-600 bg-green-500/10">
                    <CheckCircle className="h-3 w-3" />
                    已启用
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 flex-shrink-0 border-gray-500/50 text-gray-600 bg-gray-500/10">
                    已禁用
                  </Badge>
                )}
              </div>

              {/* Command/URL preview */}
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {server.command || server.url || "No command"}
                </p>
                {envCount > 0 && (
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    · 环境变量: {envCount}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right side: Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Current Project Toggle Switch */}
            <div className="flex items-center gap-2 border-l border-border pl-2">
              <span className="text-xs text-muted-foreground">当前项目</span>
              <Switch
                checked={server.enabled}
                onCheckedChange={(checked) => handleToggleServer(server.name, checked)}
                disabled={isToggling}
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Multi-Project Button (for Claude and Codex engines) */}
            {(selectedEngine === "claude" || selectedEngine === "codex") && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenMultiProject(server.name);
                }}
                className="h-8 gap-1 text-xs hover:bg-blue-500/10 hover:text-blue-600 hover:border-blue-500/50"
              >
                <FolderGit2 className="h-3 w-3" />
                多项目
              </Button>
            )}

            {/* Test Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleTestConnection(server.name);
              }}
              disabled={testingServer === server.name}
              className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-green-500/10 hover:text-green-600"
            >
              {testingServer === server.name ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>

            {/* Remove Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveServer(server.name);
              }}
              disabled={removingServer === server.name}
              className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive"
            >
              {removingServer === server.name ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>

            {/* Details Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleEditServer(server);
              }}
              className="h-6 px-2 text-xs hover:bg-primary/10"
            >
              <ChevronDown className="h-3 w-3 mr-1" />
              详情
            </Button>
          </div>
        </div>
      </motion.div>
    );
  };

  if (loading) {
    return <MCPServerListSkeleton />;
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold">已配置的服务器</h3>
          <p className="text-sm text-muted-foreground">
            {filteredServers.length} / {servers.length} 个服务器
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            className="gap-2 hover:bg-primary/10 hover:text-primary hover:border-primary/50"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      {/* Search Box */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="搜索服务器名称、命令或 URL..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Server List */}
      {servers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="p-4 bg-primary/10 rounded-full mb-4">
            <Network className="h-12 w-12 text-primary" />
          </div>
          <p className="text-muted-foreground mb-2 font-medium">暂无 MCP 服务器配置</p>
          <p className="text-sm text-muted-foreground">
            添加服务器以开始使用模型上下文协议
          </p>
        </div>
      ) : filteredServers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="p-4 bg-muted rounded-full mb-4">
            <Search className="h-12 w-12 text-muted-foreground" />
          </div>
          <p className="text-muted-foreground mb-2 font-medium">未找到匹配的服务器</p>
          <p className="text-sm text-muted-foreground">
            尝试使用不同的搜索关键词
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(serversByScope).map(([scope, scopeServers]) => (
            <div key={scope} className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {getScopeIcon(scope)}
                <span className="font-medium">{getScopeDisplayName(scope)}</span>
                <span className="text-muted-foreground/60">({scopeServers.length})</span>
              </div>
              <AnimatePresence>
                <div className="space-y-2">
                  {scopeServers.map(renderServerItem)}
                </div>
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <MCPServerEditDialog
        server={editingServer}
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onSave={handleSaveServer}
        selectedEngine={selectedEngine}
      />

      {/* Multi-Project Dialog */}
      {selectedServerForMultiProject && (
        <MCPMultiProjectDialog
          open={multiProjectDialogOpen}
          onOpenChange={setMultiProjectDialogOpen}
          serverName={selectedServerForMultiProject}
          engine={selectedEngine}
          onComplete={(message, success) => {
            onTestResult?.(message, success);
            onRefresh(); // Refresh after multi-project operation
          }}
        />
      )}
    </div>
  );
};
