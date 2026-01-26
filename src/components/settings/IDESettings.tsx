/**
 * IDE Settings - IDE 跳转设置组件
 *
 * 用于配置点击文件路径时跳转到的 IDE
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Loader2, Check, FolderOpen, RefreshCw, FileSearch, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, type IDEConfig, type IDEType, type DetectedIDE } from "@/lib/api";
import { open } from "@tauri-apps/plugin-dialog";

interface IDESettingsProps {
  setToast: (toast: { message: string; type: 'success' | 'error' } | null) => void;
}

export const IDESettings: React.FC<IDESettingsProps> = ({ setToast }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [validating, setValidating] = useState(false);

  const [config, setConfig] = useState<IDEConfig | null>(null);
  const [detectedIDEs, setDetectedIDEs] = useState<DetectedIDE[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [pathValid, setPathValid] = useState<boolean | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  // 加载配置
  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const loadedConfig = await api.getIDEConfig();
      setConfig(loadedConfig);
      if (loadedConfig.customIdePath) {
        setCustomPath(loadedConfig.customIdePath);
      }
    } catch (error) {
      console.error("加载 IDE 配置失败:", error);
      // 使用默认配置
      setConfig({
        ideType: "idea",
        useUrlProtocol: true,
      });
    } finally {
      setLoading(false);
    }
  };

  // 检测已安装的 IDE
  const handleDetectIDEs = async () => {
    try {
      setDetecting(true);
      const detected = await api.detectInstalledIDEs();
      setDetectedIDEs(detected);
      
      if (detected.length === 0) {
        setToast({ message: "未检测到已安装的 IDE", type: "error" });
      } else {
        setToast({ message: `检测到 ${detected.length} 个 IDE`, type: "success" });
      }
    } catch (error) {
      console.error("检测 IDE 失败:", error);
      setToast({ message: "检测 IDE 失败", type: "error" });
    } finally {
      setDetecting(false);
    }
  };

  // 验证自定义路径
  const handleValidatePath = async (path: string) => {
    if (!path.trim()) {
      setPathValid(null);
      setPathError(null);
      return;
    }

    try {
      setValidating(true);
      const isValid = await api.validateIDEPath(path.trim());
      setPathValid(isValid);
      setPathError(isValid ? null : "路径无效或文件不存在");
    } catch (error) {
      setPathValid(false);
      setPathError("验证路径时出错");
    } finally {
      setValidating(false);
    }
  };

  // 选择文件
  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "可执行文件",
            extensions: ["exe", "bat", "cmd", "sh", "app"],
          },
          {
            name: "所有文件",
            extensions: ["*"],
          },
        ],
      });

      if (selected && typeof selected === "string") {
        setCustomPath(selected);
        setPathValid(null);
        setPathError(null);
        // 自动验证选择的文件
        handleValidatePath(selected);
      }
    } catch (error) {
      console.error("选择文件失败:", error);
    }
  };

  // 保存配置
  const handleSave = async () => {
    if (!config) return;

    try {
      setSaving(true);
      
      const updatedConfig: IDEConfig = {
        ...config,
        customIdePath: config.ideType === "custom" ? customPath.trim() || undefined : undefined,
      };

      await api.saveIDEConfig(updatedConfig);
      setConfig(updatedConfig);
      setToast({ message: "IDE 设置已保存", type: "success" });
    } catch (error) {
      console.error("保存 IDE 配置失败:", error);
      setToast({ message: "保存设置失败", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // 选择检测到的 IDE
  const handleSelectDetectedIDE = (ide: DetectedIDE) => {
    setConfig(prev => prev ? {
      ...prev,
      ideType: ide.ideType,
      customIdePath: ide.path,
    } : {
      ideType: ide.ideType,
      customIdePath: ide.path,
      useUrlProtocol: true,
    });
    setCustomPath(ide.path);
    setPathValid(true);
    setPathError(null);
  };

  // IDE 类型变更
  const handleIDETypeChange = (value: string) => {
    const ideType = value as IDEType;
    setConfig(prev => prev ? {
      ...prev,
      ideType,
      customIdePath: ideType === "custom" ? customPath : undefined,
    } : {
      ideType,
      customIdePath: ideType === "custom" ? customPath : undefined,
      useUrlProtocol: true,
    });
    
    if (ideType !== "custom") {
      setPathValid(null);
      setPathError(null);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span>加载 IDE 设置中...</span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-6">
      <div>
        <h3 className="text-base font-semibold mb-2">IDE 跳转设置</h3>
        <p className="text-sm text-muted-foreground mb-4">
          配置点击文件路径时打开的 IDE。支持 IntelliJ IDEA、VS Code 等。
        </p>

        <div className="space-y-4">
          {/* IDE 类型选择 */}
          <div className="space-y-2">
            <Label htmlFor="ideType">默认 IDE</Label>
            <Select
              value={config?.ideType || "idea"}
              onValueChange={handleIDETypeChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择 IDE" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="idea">IntelliJ IDEA</SelectItem>
                <SelectItem value="vscode">Visual Studio Code</SelectItem>
                <SelectItem value="custom">自定义</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {config?.ideType === "idea" && "使用 idea:// 协议打开文件"}
              {config?.ideType === "vscode" && "使用 vscode:// 协议打开文件"}
              {config?.ideType === "custom" && "使用自定义路径打开文件"}
            </p>
          </div>

          {/* 自定义路径输入 */}
          <AnimatePresence>
            {config?.ideType === "custom" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-3"
              >
                <div className="space-y-2">
                  <Label htmlFor="customPath">自定义 IDE 路径</Label>
                  <div className="flex gap-2">
                    <Input
                      id="customPath"
                      placeholder="例如：C:\Program Files\JetBrains\IntelliJ IDEA\bin\idea64.exe"
                      value={customPath}
                      onChange={(e) => {
                        setCustomPath(e.target.value);
                        setPathValid(null);
                        setPathError(null);
                      }}
                      onBlur={() => handleValidatePath(customPath)}
                      className={cn(
                        "flex-1",
                        pathError && "border-red-500",
                        pathValid === true && "border-green-500"
                      )}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleSelectFile}
                      title="浏览选择文件"
                    >
                      <FileSearch className="h-4 w-4" />
                    </Button>
                    {validating && (
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground self-center" />
                    )}
                    {!validating && pathValid === true && (
                      <Check className="h-5 w-5 text-green-500 self-center" />
                    )}
                  </div>
                  {pathError && (
                    <p className="text-xs text-red-500">{pathError}</p>
                  )}
                </div>

                <div className="p-3 bg-muted rounded-md">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                    <div className="flex-1 text-xs text-muted-foreground">
                      <p><strong>常见 IDE 路径：</strong></p>
                      <ul className="mt-1 ml-3 list-disc space-y-1">
                        <li>IDEA: C:\Program Files\JetBrains\IntelliJ IDEA\bin\idea64.exe</li>
                        <li>VS Code: C:\Users\用户名\AppData\Local\Programs\Microsoft VS Code\Code.exe</li>
                        <li>WebStorm: C:\Program Files\JetBrains\WebStorm\bin\webstorm64.exe</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 自动检测 */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <Label className="text-sm font-medium">自动检测 IDE</Label>
                <p className="text-xs text-muted-foreground">
                  扫描系统中已安装的 IDE
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDetectIDEs}
                disabled={detecting}
              >
                {detecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    检测中...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-1" />
                    检测 IDE
                  </>
                )}
              </Button>
            </div>

            {/* 检测说明 */}
            <div className="p-3 bg-blue-50 dark:bg-blue-950/30 rounded-md mb-3 border border-blue-200 dark:border-blue-800">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
                <div className="flex-1 text-xs text-blue-700 dark:text-blue-300">
                  <p><strong>自动检测会扫描以下位置：</strong></p>
                  <ul className="mt-1 ml-3 list-disc space-y-0.5">
                    <li><strong>IDEA:</strong> Program Files\JetBrains\、AppData\Local\JetBrains\Toolbox\apps\</li>
                    <li><strong>VS Code:</strong> Program Files\Microsoft VS Code\、AppData\Local\Programs\Microsoft VS Code\</li>
                    <li><strong>PATH:</strong> 系统环境变量中的 code 命令</li>
                  </ul>
                  <p className="mt-1.5 text-blue-600 dark:text-blue-400">
                    如果 IDE 安装在其他位置（如 D 盘），请选择"自定义"并手动指定路径。
                  </p>
                </div>
              </div>
            </div>

            {/* 检测结果 */}
            <AnimatePresence>
              {detectedIDEs.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-2"
                >
                  <p className="text-xs text-muted-foreground">检测到的 IDE：</p>
                  <div className="space-y-2">
                    {detectedIDEs.map((ide, index) => (
                      <div
                        key={index}
                        className={cn(
                          "flex items-center justify-between p-2 rounded-md border cursor-pointer transition-colors",
                          "hover:bg-muted/50",
                          config?.customIdePath === ide.path && "border-primary bg-primary/5"
                        )}
                        onClick={() => handleSelectDetectedIDE(ide)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{ide.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{ide.path}</p>
                          </div>
                        </div>
                        {config?.customIdePath === ide.path && (
                          <Check className="h-4 w-4 text-primary flex-shrink-0" />
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 保存按钮 */}
          <div className="border-t pt-4">
            <Button
              onClick={handleSave}
              disabled={saving || (config?.ideType === "custom" && !customPath.trim())}
              className="w-full"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  保存中...
                </>
              ) : (
                "保存 IDE 设置"
              )}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};
