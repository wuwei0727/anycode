/**
 * 子代理消息分组逻辑
 * 
 * 核心思路：
 * 1. 识别 Task 工具调用（子代理启动边界）
 * 2. 收集该 Task 对应的所有子代理消息（有 parent_tool_use_id）
 * 3. 将 Task 调用和相关子代理消息打包成一个消息组
 */

import type { ClaudeStreamMessage } from '@/types/claude';

/**
 * 子代理消息组
 */
export interface SubagentGroup {
  /** 组 ID（使用 Task 的 tool_use_id） */
  id: string;
  /** Task 工具调用的消息 */
  taskMessage: ClaudeStreamMessage;
  /** Task 工具的 ID */
  taskToolUseId: string;
  /** 子代理的所有消息（按顺序） */
  subagentMessages: ClaudeStreamMessage[];
  /** 组在原始消息列表中的起始索引 */
  startIndex: number;
  /** 组在原始消息列表中的结束索引 */
  endIndex: number;
  /** 子代理类型 */
  subagentType?: string;
}

/**
 * Codex 工作过程分组（工具调用 / 思考 / 运行元信息等）
 */
export interface ActivityGroup {
  /** 组 ID */
  id: string;
  /** 组内消息（保持原始顺序） */
  messages: ClaudeStreamMessage[];
  /** 组在原始消息列表中的起始索引 */
  startIndex: number;
  /** 组在原始消息列表中的结束索引 */
  endIndex: number;
}

/**
 * 消息组类型（用于渲染）
 */
export type MessageGroup = 
  | { type: 'normal'; message: ClaudeStreamMessage; index: number }
  | { type: 'subagent'; group: SubagentGroup }
  | { type: 'activity'; group: ActivityGroup };

function hasNonEmptyTextContent(message: ClaudeStreamMessage): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item: any) => {
    if (!item || item.type !== 'text') return false;
    if (typeof item.text === 'string') return item.text.trim().length > 0;
    if (item.text && typeof item.text.text === 'string') return item.text.text.trim().length > 0;
    return false;
  });
}

function hasToolUseOrResult(message: ClaudeStreamMessage): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item: any) => item?.type === 'tool_use' || item?.type === 'tool_result');
}

/**
 * 判断消息是否属于 Codex 的“工作过程”内容：
 * - assistant: 仅工具调用/结果（无可见文本）
 * - thinking: 思考摘要
 * - system: token_count 等运行元信息（通常无可见内容，但会夹在工具调用之间）
 */
function isCodexActivityMessage(message: ClaudeStreamMessage): boolean {
  if (message.engine !== 'codex') return false;

  if (message.type === 'assistant') {
    if (hasNonEmptyTextContent(message)) return false;
    return hasToolUseOrResult(message);
  }

  if (message.type === 'thinking') {
    return true;
  }

  if (message.type === 'system') {
    // system init 仍按原逻辑渲染（避免把初始化信息塞进工作过程）
    if (message.subtype === 'init') return false;
    // token_count / usage / rate_limits 等（即使不显示，也要参与分组避免打断）
    if (message.usage || (message as any).contextWindow || (message as any).rateLimits) return true;
    // 其他 system 只在有内容时参与
    const content = message.message?.content;
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    const result = (message as any).result;
    return typeof result === 'string' && result.trim().length > 0;
  }

  return false;
}

function isCodexActivityStartMessage(message: ClaudeStreamMessage): boolean {
  if (!isCodexActivityMessage(message)) return false;
  // 不从纯 system 元信息开始创建组，避免产生“空组”
  return message.type === 'assistant' || message.type === 'thinking';
}

/**
 * 检查消息是否包含 Task 工具调用
 */
export function hasTaskToolCall(message: ClaudeStreamMessage): boolean {
  if (message.type !== 'assistant') return false;
  
  const content = message.message?.content;
  if (!Array.isArray(content)) return false;
  
  return content.some((item: any) => 
    item.type === 'tool_use' && 
    item.name?.toLowerCase() === 'task'
  );
}

/**
 * 从消息中提取 Task 工具的 ID
 */
export function extractTaskToolUseIds(message: ClaudeStreamMessage): string[] {
  if (!hasTaskToolCall(message)) return [];

  const content = message.message?.content as any[];
  return content
    .filter((item: any) => item.type === 'tool_use' && item.name?.toLowerCase() === 'task')
    .map((item: any) => item.id)
    .filter(Boolean);
}

/**
 * 从消息中提取 Task 工具的详细信息（包括 subagent_type）
 */
export function extractTaskToolDetails(message: ClaudeStreamMessage): Map<string, { subagentType?: string }> {
  const details = new Map<string, { subagentType?: string }>();

  if (!hasTaskToolCall(message)) return details;

  const content = message.message?.content as any[];
  content
    .filter((item: any) => item.type === 'tool_use' && item.name?.toLowerCase() === 'task')
    .forEach((item: any) => {
      if (item.id) {
        details.set(item.id, {
          subagentType: item.input?.subagent_type,
        });
      }
    });

  return details;
}

/**
 * 检查消息是否是子代理消息
 */
export function isSubagentMessage(message: ClaudeStreamMessage): boolean {
  // 检查是否有 parent_tool_use_id
  const hasParent = !!(message as any).parent_tool_use_id;
  
  // 检查是否标记为侧链
  const isSidechain = !!(message as any).isSidechain;
  
  return hasParent || isSidechain;
}

/**
 * 获取消息的 parent_tool_use_id
 */
export function getParentToolUseId(message: ClaudeStreamMessage): string | null {
  return (message as any).parent_tool_use_id || null;
}

/**
 * 对消息列表进行分组
 *
 * @param messages 原始消息列表
 * @returns 分组后的消息列表
 *
 * ✅ FIX: 支持并行 Task 调用
 * 当 Claude 在一条消息中并行调用多个子代理时，每个 Task 都应该被正确分组
 */
export function groupMessages(messages: ClaudeStreamMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const processedIndices = new Set<number>();

  // 第一遍：识别所有 Task 工具调用
  // 记录每个 Task ID 对应的消息和索引
  const taskToolUseMap = new Map<string, { message: ClaudeStreamMessage; index: number }>();
  // 记录每个消息索引对应的所有 Task ID（支持并行 Task）
  const indexToTaskIds = new Map<number, string[]>();
  // 记录每个 Task ID 对应的子代理类型
  const taskSubagentTypes = new Map<string, string | undefined>();

  messages.forEach((message, index) => {
    const taskIds = extractTaskToolUseIds(message);
    if (taskIds.length > 0) {
      indexToTaskIds.set(index, taskIds);
      // 提取详细信息（包括 subagent_type）
      const details = extractTaskToolDetails(message);
      taskIds.forEach(taskId => {
        taskToolUseMap.set(taskId, { message, index });
        const detail = details.get(taskId);
        if (detail?.subagentType) {
          taskSubagentTypes.set(taskId, detail.subagentType);
        }
      });
    }
  });

  // 第二遍：为每个 Task 收集子代理消息
  // ✅ FIX: 不再在遇到下一个 Task 时停止，而是遍历所有消息并根据 parent_tool_use_id 归类
  const subagentGroups = new Map<string, SubagentGroup>();

  taskToolUseMap.forEach((taskInfo, taskId) => {
    const subagentMessages: ClaudeStreamMessage[] = [];
    let maxIndex = taskInfo.index;

    // 遍历所有后续消息，根据 parent_tool_use_id 匹配
    for (let i = taskInfo.index + 1; i < messages.length; i++) {
      const msg = messages[i];
      const parentId = getParentToolUseId(msg);

      // ✅ FIX: 只根据 parent_tool_use_id 判断归属，不提前停止
      if (parentId === taskId) {
        subagentMessages.push(msg);
        maxIndex = Math.max(maxIndex, i);
      }
    }

    if (subagentMessages.length > 0) {
      subagentGroups.set(taskId, {
        id: taskId,
        taskMessage: taskInfo.message,
        taskToolUseId: taskId,
        subagentMessages,
        startIndex: taskInfo.index,
        endIndex: maxIndex,
        subagentType: taskSubagentTypes.get(taskId),
      });
    }
  });

  // 标记所有子代理消息的索引（避免重复渲染）
  messages.forEach((message, index) => {
    const parentId = getParentToolUseId(message);
    if (parentId && subagentGroups.has(parentId)) {
      processedIndices.add(index);
    }
  });

  // 记录已添加的 Task 组（避免重复）
  const addedTaskGroups = new Set<string>();

  // 第三遍：构建最终的分组列表
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    // 跳过已被归入子代理组的消息
    if (processedIndices.has(index)) {
      continue;
    }

    // 检查是否是包含 Task 调用的消息
    const taskIds = indexToTaskIds.get(index);

    if (taskIds && taskIds.length > 0) {
      // ✅ FIX: 遍历所有 Task ID，为每个有子代理消息的 Task 创建分组
      taskIds.forEach(taskId => {
        if (subagentGroups.has(taskId) && !addedTaskGroups.has(taskId)) {
          groups.push({
            type: 'subagent',
            group: subagentGroups.get(taskId)!,
          });
          addedTaskGroups.add(taskId);
        }
      });

      // 如果该消息的所有 Task 都没有子代理消息（可能是正在执行中），
      // 仍然作为普通消息显示
      const hasAnySubagentGroup = taskIds.some(id => subagentGroups.has(id));
      if (!hasAnySubagentGroup) {
        groups.push({
          type: 'normal',
          message,
          index,
        });
      }
      continue;
    }

    // ✅ Codex 工作过程分组：将工具调用/思考等高频消息折叠为一组，减少气泡占用
    if (isCodexActivityStartMessage(message)) {
      const startIndex = index;
      let endIndex = index;
      const activityMessages: ClaudeStreamMessage[] = [];

      // 向后收集连续的 activity 消息（允许夹杂 token_count system 消息、tool_result-only 等）
      for (let j = index; j < messages.length; j++) {
        if (processedIndices.has(j)) break;

        const candidate = messages[j];

        // 遇到 Task 调用边界时停止（避免与子代理分组交叉）
        if (indexToTaskIds.has(j)) break;

        if (!isCodexActivityMessage(candidate)) break;

        activityMessages.push(candidate);
        endIndex = j;
      }

      // 仅当组内存在至少 2 条“可见”的工作过程消息时才创建分组
      // （可见：assistant(tool_use/含结果) 或 thinking；纯 token_count 不计入）
      const renderableCount = activityMessages.filter((m) => {
        if (m.type === 'thinking') return true;
        if (m.type === 'assistant') {
          const content = m.message?.content;
          return Array.isArray(content) && content.some((c: any) => c?.type === 'tool_use');
        }
        return false;
      }).length;

      if (renderableCount >= 2) {
        groups.push({
          type: 'activity',
          group: {
            id: `activity-${startIndex}-${endIndex}`,
            messages: activityMessages,
            startIndex,
            endIndex,
          },
        });

        // 跳过已归组的消息
        index = endIndex;
        continue;
      }
      // 未达到分组条件，回退为普通消息
    }

    // 普通消息
    groups.push({
      type: 'normal',
      message,
      index,
    });
  }

  return groups;
}

/**
 * 检查消息是否应该被隐藏（已被分组的子代理消息）
 */
export function shouldHideMessage(message: ClaudeStreamMessage, groups: MessageGroup[]): boolean {
  // 如果消息是子代理消息，检查是否已被分组
  if (isSubagentMessage(message)) {
    const parentId = getParentToolUseId(message);
    if (parentId) {
      // 检查是否有对应的子代理组
      return groups.some(g => 
        g.type === 'subagent' && g.group.taskToolUseId === parentId
      );
    }
  }
  return false;
}

/**
 * 获取子代理消息的类型标识
 */
export function getSubagentMessageRole(message: ClaudeStreamMessage): 'user' | 'assistant' | 'system' | 'other' {
  // 子代理发送给主代理的提示词被标记为 user 类型，但应该显示为子代理的输出
  if (message.type === 'user' && isSubagentMessage(message)) {
    // 检查是否有文本内容（子代理的提示词）
    const content = message.message?.content;
    if (Array.isArray(content)) {
      const hasText = content.some((item: any) => item.type === 'text');
      if (hasText) {
        return 'assistant'; // 子代理的输出
      }
    }
  }
  
  return message.type as any;
}
