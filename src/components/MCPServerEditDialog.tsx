import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Trash2, Plus, Settings2, Wrench, Terminal, Globe } from "lucide-react";
import type { MCPServerExtended, MCPEngineType } from "@/lib/api";

interface MCPServerEditDialogProps {
  server: MCPServerExtended | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (server: MCPServerExtended) => void;
  selectedEngine: MCPEngineType;
}

interface EnvVar {
  id: string;
  key: string;
  value: string;
}

export const MCPServerEditDialog: React.FC<MCPServerEditDialogProps> = ({
  server,
  open,
  onOpenChange,
  onSave,
  selectedEngine: _selectedEngine,
}) => {
  const [activeTab, setActiveTab] = useState("general");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [enabled, setEnabled] = useState(true);

  // Reset form when server changes
  useEffect(() => {
    if (server) {
      setName(server.name);
      setCommand(server.command || "");
      setArgs(server.args || []);
      setUrl(server.url || "");
      setEnabled(server.enabled);
      setEnvVars(
        Object.entries(server.env || {}).map(([key, value], idx) => ({
          id: `env-${idx}`,
          key,
          value,
        }))
      );
    } else {
      // Reset to defaults
      setName("");
      setCommand("");
      setArgs([]);
      setUrl("");
      setEnvVars([]);
      setEnabled(true);
    }
  }, [server]);

  const isSSE = server?.transport === "sse" || !!url;

  const handleAddArg = () => {
    setArgs([...args, ""]);
  };

  const handleRemoveArg = (index: number) => {
    setArgs(args.filter((_, i) => i !== index));
  };

  const handleArgChange = (index: number, value: string) => {
    const newArgs = [...args];
    newArgs[index] = value;
    setArgs(newArgs);
  };

  const handleAddEnvVar = () => {
    setEnvVars([...envVars, { id: `env-${Date.now()}`, key: "", value: "" }]);
  };

  const handleRemoveEnvVar = (id: string) => {
    setEnvVars(envVars.filter((v) => v.id !== id));
  };

  const handleEnvVarChange = (id: string, field: "key" | "value", value: string) => {
    setEnvVars(envVars.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  };

  const handleSave = () => {
    if (!server) return;

    const updatedServer: MCPServerExtended = {
      ...server,
      name,
      command: command || undefined,
      args: args.filter((a) => a.trim()),
      url: url || undefined,
      env: envVars.reduce((acc, { key, value }) => {
        if (key.trim()) {
          acc[key] = value;
        }
        return acc;
      }, {} as Record<string, string>),
      enabled,
    };

    onSave(updatedServer);
    onOpenChange(false);
  };

  // Build execution command preview
  const executionCommand = isSSE
    ? url
    : [command, ...args.filter((a) => a.trim())].filter(Boolean).join(" ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            高级配置
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            配置服务器设置，包括命令、参数和环境变量
          </p>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="general">常规设置</TabsTrigger>
            <TabsTrigger value="tools">工具</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4 mt-4">
            {/* Server Name */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <span className="text-muted-foreground">①</span>
                服务器名称
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="server-name"
                disabled // Name is usually not editable
              />
            </div>

            {/* Command or URL */}
            {isSSE ? (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  URL
                </Label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://localhost:8765/mcp"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-muted-foreground" />
                  命令
                </Label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                />
              </div>
            )}

            {/* Arguments */}
            {!isSSE && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2">
                    <span className="text-muted-foreground">📋</span>
                    参数
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {args.length} 项
                  </span>
                </div>
                <div className="space-y-2">
                  {args.map((arg, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        value={arg}
                        onChange={(e) => handleArgChange(index, e.target.value)}
                        placeholder={`参数 ${index + 1}`}
                        className="flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveArg(index)}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddArg}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  添加参数
                </Button>
              </div>
            )}

            {/* Auto Start (placeholder) */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <span className="text-muted-foreground">▶</span>
                自动启动
              </Label>
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <span className="text-sm">启用自动启动</span>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>

            {/* Environment Variables */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <span className="text-muted-foreground">⚙</span>
                  环境变量
                </Label>
                <span className="text-xs text-muted-foreground">
                  {envVars.length} 项
                </span>
              </div>
              {envVars.length === 0 ? (
                <div className="text-center py-4 text-sm text-muted-foreground border rounded-lg">
                  <span className="text-muted-foreground">ⓘ</span> 暂无环境变量配置
                </div>
              ) : (
                <div className="space-y-2">
                  {envVars.map((envVar) => (
                    <div key={envVar.id} className="flex items-center gap-2">
                      <Input
                        value={envVar.key}
                        onChange={(e) =>
                          handleEnvVarChange(envVar.id, "key", e.target.value)
                        }
                        placeholder="KEY"
                        className="flex-1"
                      />
                      <span className="text-muted-foreground">=</span>
                      <Input
                        value={envVar.value}
                        onChange={(e) =>
                          handleEnvVarChange(envVar.id, "value", e.target.value)
                        }
                        placeholder="value"
                        className="flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveEnvVar(envVar.id)}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddEnvVar}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                添加环境变量
              </Button>
            </div>

            {/* Execution Command Preview */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground" />
                执行命令
              </Label>
              <div className="p-3 bg-muted/50 rounded-lg font-mono text-sm break-all">
                {executionCommand || "无命令"}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="tools" className="mt-4">
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <Wrench className="h-12 w-12 mb-4 opacity-50" />
              <p>工具列表将在服务器连接后显示</p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave}>
            <span className="mr-2">✓</span>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MCPServerEditDialog;
