/**
 * Auggie 提示词优化设置组件
 * 配置 Auggie 作为提示词优化提供商
 */

import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle, AlertCircle, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  loadAuggieConfig,
  saveAuggieConfig,
  checkAuggieAvailability,
  type AuggieConfig,
} from '@/lib/auggieEnhancement';

interface AuggieEnhancementSettingsProps {
  className?: string;
}

export const AuggieEnhancementSettings: React.FC<AuggieEnhancementSettingsProps> = ({
  className,
}) => {
  const [config, setConfig] = useState<AuggieConfig>(() => loadAuggieConfig());
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{
    available: boolean;
    mode: 'mcp' | 'http' | 'none';
    message: string;
  } | null>(null);

  // 检查 Auggie 可用性
  const handleCheckAvailability = async () => {
    setChecking(true);
    setStatus(null);
    
    try {
      const result = await checkAuggieAvailability();
      setStatus(result);
    } catch (error) {
      setStatus({
        available: false,
        mode: 'none',
        message: error instanceof Error ? error.message : '检查失败',
      });
    } finally {
      setChecking(false);
    }
  };

  // 保存配置
  const handleSave = (newConfig: Partial<AuggieConfig>) => {
    const updated = { ...config, ...newConfig };
    setConfig(updated);
    saveAuggieConfig(updated);
  };

  // 初始检查
  useEffect(() => {
    if (config.enabled) {
      handleCheckAvailability();
    }
  }, []);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5 text-yellow-500" />
            Auggie 提示词优化
          </h3>
          <p className="text-sm text-muted-foreground">
            使用 Augment 的 Auggie 工具优化提示词
          </p>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(enabled) => {
            handleSave({ enabled });
            if (enabled) {
              handleCheckAvailability();
            }
          }}
        />
      </div>

      {config.enabled && (
        <Card className="p-4 space-y-4">
          {/* 状态显示 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {checking ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : status?.available ? (
                <CheckCircle className="h-4 w-4 text-green-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-yellow-500" />
              )}
              <span className="text-sm">
                {checking ? '检查中...' : status?.message || '未检查'}
              </span>
              {status?.available && (
                <Badge variant="secondary" className="text-xs">
                  {status.mode === 'mcp' ? 'MCP 模式' : 'HTTP 模式'}
                </Badge>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckAvailability}
              disabled={checking}
            >
              {checking ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                '检查连接'
              )}
            </Button>
          </div>

          {/* MCP 模式开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">优先使用 MCP 模式</Label>
              <p className="text-xs text-muted-foreground">
                通过 MCP 协议调用 Auggie（推荐）
              </p>
            </div>
            <Switch
              checked={config.useMcpMode ?? true}
              onCheckedChange={(useMcpMode) => handleSave({ useMcpMode })}
            />
          </div>

          {/* HTTP 代理配置 */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">HTTP 代理地址（备用）</Label>
            <Input
              value={config.httpProxyUrl || ''}
              onChange={(e) => handleSave({ httpProxyUrl: e.target.value })}
              placeholder="http://localhost:3001"
            />
            <p className="text-xs text-muted-foreground">
              如果 MCP 模式不可用，将尝试通过 HTTP 代理调用
            </p>
          </div>

          {/* 使用说明 */}
          <div className="p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">使用说明：</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>确保已安装并登录 Auggie CLI：<code className="bg-muted px-1 rounded">auggie login</code></li>
              <li>Auggie 会自动作为 MCP 服务器运行</li>
              <li>启用后，在优化按钮下拉菜单中选择 "Auggie (Augment)"</li>
            </ol>
          </div>
        </Card>
      )}
    </div>
  );
};

