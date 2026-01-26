/**
 * ToolCallsGroup - 工具调用组组件（重构版）
 *
 * 基于工具注册中心的插件化架构
 * 支持批量管理工具调用，提供折叠/展开功能
 * 当工具数量 >= 3 时默认折叠，显示摘要信息
 */

import React, { memo, useState, useMemo, useRef, useEffect } from 'react';
import { ChevronDown, ChevronRight, Wrench, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolRegistry } from '@/lib/toolRegistry';
import { useToolResults } from '@/hooks/useToolResults';
import { FilePathLink } from '@/components/common/FilePathLink';
import { parseFileReference } from '@/lib/fileLinkify';
import type { ClaudeStreamMessage } from '@/types/claude';
import type { ToolResultEntry } from '@/contexts/MessagesContext';

interface ToolCall {
  id: string;
  type: 'tool_use';
  name: string;
  input?: Record<string, any>;
}

export interface ToolCallsGroupProps {
  /** 消息数据 */
  message: ClaudeStreamMessage;

  /** 默认折叠状态 */
  defaultCollapsed?: boolean;

  /** 折叠阈值（工具数量 >= 此值时默认折叠） */
  collapseThreshold?: number;

  /** 折叠状态变化回调 */
  onToggle?: (collapsed: boolean) => void;

  /** 链接检测回调 */
  onLinkDetected?: (url: string) => void;

  /** 自定义类名 */
  className?: string;

  /** 项目路径（用于解析相对文件路径） */
  projectPath?: string;

  /** 单个工具是否允许折叠（用于紧凑模式） */
  allowSingleCollapse?: boolean;

  /** 紧凑模式（更小内边距/字号） */
  compact?: boolean;
}

export const ToolCallsGroup: React.FC<ToolCallsGroupProps> = ({
  message,
  defaultCollapsed,
  collapseThreshold = 3,
  onToggle,
  onLinkDetected,
  className,
  projectPath,
  allowSingleCollapse = false,
  compact = false,
}) => {
  // 提取工具调用
  const toolCalls = useMemo((): ToolCall[] => {
    if (!message.message?.content || !Array.isArray(message.message.content)) {
      return [];
    }
    return message.message.content.filter((item: any) => item.type === 'tool_use') as ToolCall[];
  }, [message]);

  const { getResultById, getStatusById } = useToolResults();

  // 自动判断是否应该折叠
  const shouldCollapse = defaultCollapsed ?? toolCalls.length >= collapseThreshold;
  const [isCollapsed, setIsCollapsed] = useState(shouldCollapse);

  // 计算工具执行统计
  const stats = useMemo(() => {
    let successCount = 0;
    let errorCount = 0;
    let pendingCount = 0;

    toolCalls.forEach(tool => {
      const status = getStatusById(tool.id);
      if (status === 'pending') {
        pendingCount++;
      } else if (status === 'error') {
        errorCount++;
      } else {
        successCount++;
      }
    });

    return { successCount, errorCount, pendingCount, total: toolCalls.length };
  }, [toolCalls, getStatusById]);

  // 切换折叠状态
  const toggleCollapse = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    onToggle?.(newState);
  };

  // 获取工具类型摘要
  const toolTypesSummary = useMemo(() => {
    const types = new Set(toolCalls.map(t => t.name));
    const typeArray = Array.from(types);
    if (typeArray.length <= 3) {
      return typeArray.join(', ');
    }
    return `${typeArray.slice(0, 3).join(', ')} +${typeArray.length - 3}`;
  }, [toolCalls]);

  if (toolCalls.length === 0) return null;

  // 只有一个工具时，直接渲染不提供折叠功能
  if (toolCalls.length === 1 && !allowSingleCollapse) {
    const tool = toolCalls[0];
    return (
      <div className={cn('tool-single-call mt-1', className)}>
        <SingleToolCall
          tool={tool}
          result={getResultById(tool.id)}
          status={getStatusById(tool.id)}
          onLinkDetected={onLinkDetected}
          projectPath={projectPath}
        />
      </div>
    );
  }

  return (
    <div className={cn('tool-calls-group mt-1 border border-border rounded-lg overflow-hidden', className)}>
      {/* 折叠/展开头部 */}
      <button
        onClick={toggleCollapse}
        className={cn(
          "flex items-center gap-2 w-full text-left bg-muted/30 hover:bg-muted/50 transition-colors",
          compact ? "px-3 py-2" : "px-4 py-3"
        )}
      >
        {isCollapsed ? <ChevronRight className={cn("shrink-0", compact ? "w-3.5 h-3.5" : "w-4 h-4")} /> : <ChevronDown className={cn("shrink-0", compact ? "w-3.5 h-3.5" : "w-4 h-4")} />}
        <Wrench className={cn("text-blue-500 shrink-0", compact ? "w-3.5 h-3.5" : "w-4 h-4")} />
        <span className={cn("font-medium", compact ? "text-xs" : "text-sm")}>工具调用 ({stats.total})</span>

        {/* 状态徽章 */}
        <div className="flex items-center gap-2 ml-auto">
          {stats.successCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-green-600 bg-green-500/10 px-2 py-1 rounded">
              <CheckCircle className="w-3 h-3" />
              {stats.successCount}
            </span>
          )}
          {stats.errorCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-red-600 bg-red-500/10 px-2 py-1 rounded">
              <AlertCircle className="w-3 h-3" />
              {stats.errorCount}
            </span>
          )}
          {stats.pendingCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-blue-600 bg-blue-500/10 px-2 py-1 rounded">
              <Loader2 className="w-3 h-3 animate-spin" />
              {stats.pendingCount}
            </span>
          )}
        </div>

        <span className={cn("text-muted-foreground ml-2 truncate max-w-[200px]", compact ? "text-[11px]" : "text-xs")}>{toolTypesSummary}</span>
      </button>

      {/* 折叠摘要或完整内容 */}
      {isCollapsed ? (
        <CollapsedSummary
          toolCalls={toolCalls}
          getStatusById={getStatusById}
          projectPath={projectPath}
          compact={compact}
        />
      ) : (
        <div className={cn("space-y-2 bg-background", compact ? "p-3" : "p-4")}>
          {toolCalls.map((tool, index) => (
            <SingleToolCall
              key={tool.id}
              tool={tool}
              result={getResultById(tool.id)}
              status={getStatusById(tool.id)}
              onLinkDetected={onLinkDetected}
              index={index + 1}
              total={toolCalls.length}
              projectPath={projectPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * 折叠时的摘要显示
 */
interface CollapsedSummaryProps {
  toolCalls: ToolCall[];
  getStatusById: (toolUseId?: string | null) => 'pending' | 'success' | 'error';
  projectPath?: string;
  compact?: boolean;
}

const CollapsedSummary: React.FC<CollapsedSummaryProps> = ({ toolCalls, getStatusById, projectPath, compact = false }) => {
  const getToolPath = (tool: ToolCall): string | undefined => {
    const input = tool.input || {};
    return input.file_path || input.path || input.directory_path || input.dir_path || input.target || undefined;
  };

  const getToolCommand = (tool: ToolCall): string | undefined => {
    const input = tool.input || {};
    return input.command || input.cmd || undefined;
  };

  const truncate = (value: string, max = 80) => {
    if (!value) return value;
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };

  const extractFilesFromCommand = (command?: string): string[] => {
    if (!command) return [];
    const files = new Set<string>();
    const candidateRe =
      /(?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,8}(?:(?:#L\d+(?:C\d+)?)|(?::\d+(?::\d+)?))?/g;
    const candidates = command.match(candidateRe) || [];
    candidates.forEach((c) => {
      const ref = parseFileReference(c);
      if (ref?.filePath) {
        files.add(ref.filePath);
      }
    });
    return Array.from(files);
  };

  const isLikelyFile = (path?: string) => {
    if (!path) return false;
    if (path.endsWith('/')) return false;
    return path.includes('.') || path.includes('/') || path.includes('\\');
  };

  return (
    <div className={cn("bg-background/50 border-t border-border space-y-2", compact ? "px-3 py-2" : "px-4 py-3")}>
      {/* 显示前3个工具 */}
      {toolCalls.slice(0, 3).map((tool, idx) => {
        const status = getStatusById(tool.id);
        const hasResult = status !== 'pending';
        const isError = status === 'error';

        let StatusIcon = Loader2;
        let statusColor = 'text-blue-600';

        if (hasResult) {
          if (isError) {
            StatusIcon = AlertCircle;
            statusColor = 'text-red-600';
          } else {
            StatusIcon = CheckCircle;
            statusColor = 'text-green-600';
          }
        }

        const filePath = getToolPath(tool);
        const command = getToolCommand(tool);
        const commandFiles = !filePath && command ? extractFilesFromCommand(command) : [];

        return (
          <div key={idx} className="flex items-center gap-2 text-xs">
            <StatusIcon className={cn('w-3 h-3', statusColor, !hasResult && 'animate-spin')} />
            <span className="font-mono font-medium">{tool.name}</span>
            {filePath && isLikelyFile(filePath) && (
              <FilePathLink
                filePath={filePath}
                projectPath={projectPath}
                displayText={filePath.split(/[/\\]/).pop() || filePath}
                className={cn("text-[11px]", compact ? "max-w-[160px]" : "max-w-[220px]")}
              />
            )}
            {!filePath && commandFiles.length > 0 && (
              <div className="flex items-center gap-1.5 min-w-0">
                {commandFiles.slice(0, 1).map((fp) => (
                  <FilePathLink
                    key={fp}
                    filePath={fp}
                    projectPath={projectPath}
                    displayText={fp.split(/[/\\]/).pop() || fp}
                    className={cn("text-[11px]", compact ? "max-w-[160px]" : "max-w-[220px]")}
                  />
                ))}
                {commandFiles.length > 1 && (
                  <span className="text-[11px] text-muted-foreground/70 whitespace-nowrap">
                    +{commandFiles.length - 1}
                  </span>
                )}
              </div>
            )}
            {!filePath && command && (
              <span className="text-muted-foreground truncate" title={command}>
                : {truncate(command, compact ? 60 : 80)}
              </span>
            )}
          </div>
        );
      })}

      {toolCalls.length > 3 && (
        <div className="text-xs text-muted-foreground pl-5">还有 {toolCalls.length - 3} 个工具...</div>
      )}

      <div className={cn("text-muted-foreground/70 pt-1", compact ? "text-[10px]" : "text-[10px]")}>点击展开查看详情</div>
    </div>
  );
};

/**
 * 单个工具调用渲染
 */
interface SingleToolCallProps {
  tool: ToolCall;
  result?: ToolResultEntry;
  status: 'pending' | 'success' | 'error';
  onLinkDetected?: (url: string) => void;
  index?: number;
  total?: number;
  projectPath?: string;
}

const SingleToolCallComponent: React.FC<SingleToolCallProps> = ({ tool, result, status, onLinkDetected, index, total, projectPath }) => {
  const renderer = toolRegistry.getRenderer(tool.name);

  const normalizedResult = result
    ? {
        content: result.content,
        is_error: result.isError,
      }
    : undefined;

  // 判断是否正在流式输出（工具执行中）
  const isStreaming = status === 'pending';

  // 构建渲染 props
  const renderProps = {
    toolName: tool.name,
    input: tool.input,
    result: normalizedResult,
    toolId: tool.id,
    onLinkDetected,
    isStreaming,
    projectPath,
  };

  // 判断状态
  const hasResult = status !== 'pending';
  const isError = status === 'error';

  let StatusIcon = Loader2;
  let statusColor = 'text-blue-600';
  let statusBg = 'bg-blue-500/10';

  if (hasResult) {
    if (isError) {
      StatusIcon = AlertCircle;
      statusColor = 'text-red-600';
      statusBg = 'bg-red-500/10';
    } else {
      StatusIcon = CheckCircle;
      statusColor = 'text-green-600';
      statusBg = 'bg-green-500/10';
    }
  }

  return (
    <div className={cn('tool-call-item mt-1', renderer ? '' : 'bg-card border rounded-lg p-3 border-border')}>
      {/* 工具头部 - 仅在没有专用渲染器时显示 */}
      {!renderer && (
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <StatusIcon className={cn('w-4 h-4', statusColor, !hasResult && 'animate-spin')} />
            <span className="font-mono text-sm font-medium">{tool.name}</span>
            {index && total && (
              <span className="text-xs text-muted-foreground">
                ({index}/{total})
              </span>
            )}
          </div>
          <span className={cn('text-xs px-2 py-0.5 rounded', statusBg, statusColor)}>
            {hasResult ? (isError ? '失败' : '成功') : '执行中'}
          </span>
        </div>
      )}

      {/* 使用注册的工具渲染器 */}
      {renderer ? (
        <div className="tool-widget-container">
          <renderer.render {...renderProps} />
        </div>
      ) : (
        <FallbackToolRender tool={tool} result={normalizedResult} />
      )}
    </div>
  );
};

SingleToolCallComponent.displayName = "SingleToolCall";

const SingleToolCall = memo(SingleToolCallComponent);

/**
 * 未注册工具的降级渲染
 */
interface FallbackToolRenderProps {
  tool: ToolCall;
  result?: {
    content?: any;
    is_error?: boolean;
  };
}

const FallbackToolRender: React.FC<FallbackToolRenderProps> = ({ tool, result }) => {
  const COLLAPSE_HEIGHT = 300;
  const resultRef = useRef<HTMLPreElement>(null);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const el = resultRef.current;
    if (!el) return;
    const h = el.scrollHeight;
    const need = h > COLLAPSE_HEIGHT;
    setShouldCollapse(need);
    setCollapsed(need);
  }, [result]);

  const toggle = () => setCollapsed((v) => !v);

  return (
    <div className="fallback-tool-render space-y-2 text-xs">
      <div className="text-muted-foreground">此工具尚未注册专用渲染器，显示原始数据：</div>

      {tool.input && Object.keys(tool.input).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
            输入参数
          </summary>
          <pre className="mt-1 p-2 bg-muted rounded text-[10px] overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        </details>
      )}

      {result && (
        <div className={cn('p-2 rounded relative', result.is_error ? 'bg-red-500/10' : 'bg-muted')}>
          <div className="font-medium mb-1 text-xs">{result.is_error ? '执行失败' : '执行结果'}:</div>
          <div className="relative">
            <pre
              ref={resultRef}
              className={cn(
                'text-[10px] overflow-x-auto whitespace-pre-wrap transition-[max-height]',
                shouldCollapse && collapsed && 'overflow-hidden'
              )}
              style={shouldCollapse && collapsed ? { maxHeight: `${COLLAPSE_HEIGHT}px` } : undefined}
            >
              {typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2)}
            </pre>
            {shouldCollapse && collapsed && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background/80 via-background/50 to-transparent" />
            )}
          </div>
          {shouldCollapse && (
            <button
              onClick={toggle}
              className="mt-2 text-[11px] text-primary underline underline-offset-2"
            >
              {collapsed ? '展开全部' : '收起内容'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallsGroup;
