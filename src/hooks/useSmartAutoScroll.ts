/**
 * 智能自动滚动 Hook
 *
 * 提供智能滚动管理：用户手动滚动检测、自动滚动到底部、流式输出滚动
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import type { ClaudeStreamMessage } from '@/types/claude';

interface SmartAutoScrollConfig {
  /** 可显示的消息列表（用于触发滚动） */
  displayableMessages: ClaudeStreamMessage[];
  /** 是否正在加载（流式输出时） */
  isLoading: boolean;
  /** 会话 ID（用于检测会话切换） */
  sessionId?: string;
}

interface SmartAutoScrollReturn {
  /** 滚动容器 ref */
  parentRef: React.RefObject<HTMLDivElement>;
  /** 用户是否手动滚动离开底部 */
  userScrolled: boolean;
  /** 设置用户滚动状态 */
  setUserScrolled: (scrolled: boolean) => void;
  /** 设置自动滚动状态 */
  setShouldAutoScroll: (should: boolean) => void;
  /** 强制滚动到底部 */
  scrollToBottom: () => void;
}

export function useSmartAutoScroll(config: SmartAutoScrollConfig): SmartAutoScrollReturn {
  const { isLoading, sessionId, displayableMessages } = config;

  // Scroll state
  const [userScrolled, setUserScrolled] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  // Refs
  const parentRef = useRef<HTMLDivElement>(null);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const userScrolledRef = useRef(false); // 使用 ref 存储最新的 userScrolled 值
  const lastScrollTopRef = useRef(0); // 记录上次的滚动位置
  const isProgrammaticScrollRef = useRef(false); // 标记是否为代码触发的滚动（避免误判为用户行为）

  const setUserScrolledWithRef = useCallback((scrolled: boolean) => {
    userScrolledRef.current = scrolled;
    setUserScrolled(scrolled);
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true;
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
    });
  }, []);

  // 滚动到底部
  // 用于手动触发滚动到底部（如点击"滚动到底部"按钮）
  const scrollToBottom = useCallback(() => {
    if (!parentRef.current) return;
    
    const scrollElement = parentRef.current;
    
    // 平滑滚动到底部
    markProgrammaticScroll();
    scrollElement.scrollTo({
      top: scrollElement.scrollHeight,
      behavior: 'smooth'
    });
    
    // 重置用户滚动标志，表示用户现在在底部
    userScrolledRef.current = false;
    setUserScrolledWithRef(false);
    // 恢复自动滚动行为
    setShouldAutoScroll(true);
  }, []);

  // 会话切换时重置状态
  // 当 sessionId 改变时，重置所有滚动相关状态，确保新会话有一致的初始体验
  useEffect(() => {
    if (sessionId && sessionId !== lastSessionIdRef.current) {
      lastSessionIdRef.current = sessionId;
      // 重置用户滚动标志
      userScrolledRef.current = false;
      setUserScrolledWithRef(false);
      // 启用自动滚动
      setShouldAutoScroll(true);
      // 滚动到底部（如果容器存在）
      if (parentRef.current) {
        setTimeout(() => {
          if (parentRef.current) {
            markProgrammaticScroll();
            parentRef.current.scrollTop = parentRef.current.scrollHeight;
          }
        }, 100); // 延迟一点确保内容已渲染
      }
    }
  }, [sessionId]);

  // 🔧 FIX: 当开始流式输出时,重置滚动状态以确保自动滚动
  // 修复问题:Codex/Claude 回复时如果用户之前手动滚动过,自动滚动不会工作
  useEffect(() => {
    if (isLoading) {
      // 如果用户正在查看历史消息，不要在新一轮流式输出开始时强制拉回底部
      if (userScrolledRef.current) {
        return;
      }
      console.log('[useSmartAutoScroll] Streaming started, resetting scroll state:', {
        userScrolled: userScrolledRef.current,
        shouldAutoScroll,
        hasContainer: !!parentRef.current
      });
      // 重置用户滚动标志
      userScrolledRef.current = false;
      setUserScrolledWithRef(false);
      // 启用自动滚动
      setShouldAutoScroll(true);

      // 🔧 立即滚动到底部,不要等待定时器
      if (parentRef.current) {
        requestAnimationFrame(() => {
          if (parentRef.current) {
            const newScrollTop = parentRef.current.scrollHeight;
            markProgrammaticScroll();
            parentRef.current.scrollTop = newScrollTop;
            lastScrollTopRef.current = newScrollTop;
            console.log('[useSmartAutoScroll] Scrolled to bottom on streaming start');
          }
        });
      }
    }
  }, [isLoading, shouldAutoScroll]);

  // 用户滚动检测
  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    // 🔧 FIX: 在流式输出时，鼠标滚轮向上通常只产生很小的 scrollTop 变化，
    // 但定时器自动滚动会立即把视图拉回到底部，导致“滚不动”的体感。
    // 这里直接监听 wheel 意图：只要用户向上滚动，就立即禁用自动滚动。
    const handleWheel = (e: WheelEvent) => {
      // deltaY < 0 表示用户在向上滚动（查看历史消息）
      if (e.deltaY < 0 && !userScrolledRef.current) {
        console.log('[useSmartAutoScroll] Wheel up detected, disabling auto-scroll');
        setUserScrolledWithRef(true);
        setShouldAutoScroll(false);
      }
    };

    const handleScroll = () => {
      if (!parentRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const isAtBottom = distanceFromBottom <= 200;

      // 检测是否是用户向上滚动（而不是自动滚动向下）
      const scrollDelta = scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;

      // 🔧 FIX: 降低阈值以兼容触控板/平滑滚动（每次滚动位移可能很小）
      const isScrollingUp = scrollDelta < -1;

      // 🔧 FIX: 在流式输出过程中,只有用户明确向上滚动才禁用自动滚动
      // 不应该因为"不在底部"就禁用,因为内容更新时scrollHeight会变化
      if (isScrollingUp) {
        // 用户明确向上滚动,禁用自动滚动
        if (!userScrolledRef.current) {
          console.log('[useSmartAutoScroll] User scrolled up, disabling auto-scroll');
          setUserScrolledWithRef(true);
          setShouldAutoScroll(false);
        }
      } else if (!isProgrammaticScrollRef.current && isAtBottom && userScrolledRef.current) {
        // 如果回到底部，恢复自动滚动
        console.log('[useSmartAutoScroll] User scrolled back to bottom, enabling auto-scroll');
        setUserScrolledWithRef(false);
        setShouldAutoScroll(true);
      }
    };

    // wheel 需要 passive: true 才不会影响滚动性能；我们也不做 preventDefault
    // 使用 capture 以防子组件 stopPropagation 导致无法监听到滚轮意图
    scrollElement.addEventListener('wheel', handleWheel, { passive: true, capture: true });
    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener('wheel', handleWheel);
      scrollElement.removeEventListener('scroll', handleScroll);
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current);
      }
    };
  }, []);

  // 🆕 当消息更新时自动滚动到底部（如果允许自动滚动）
  // 这个 effect 确保每次消息更新时都尝试滚动，而不仅仅依赖定时器
  useEffect(() => {
    // 🔧 CRITICAL FIX: 使用 ref 而不是状态变量，避免状态更新延迟导致的滚动跳动
    // 只有在允许自动滚动且用户没有手动滚动时才执行
    if (!shouldAutoScroll || userScrolledRef.current || !parentRef.current) {
      return;
    }

    // 🔧 FIX: 严格检查是否在底部，避免用户向上滚动时被强制拉回
    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isAtBottom = distanceFromBottom <= 50; // 🔧 从 300px 改为 50px，避免滚动晃动

    // 只有在真正在底部时才滚动
    if (!isAtBottom && !isLoading) {
      return;
    }

    // 使用 requestAnimationFrame 确保在 DOM 更新后滚动
    const rafId = requestAnimationFrame(() => {
      if (parentRef.current && !userScrolledRef.current) {
        const newScrollTop = parentRef.current.scrollHeight;
        markProgrammaticScroll();
        parentRef.current.scrollTop = newScrollTop;
        lastScrollTopRef.current = newScrollTop;
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [displayableMessages, shouldAutoScroll, isLoading]);

  // 流式输出时自动滚动
  // 只有在以下条件都满足时才自动滚动：
  // 1. isLoading=true（正在流式输出）
  // 2. shouldAutoScroll=true（允许自动滚动）
  // 3. userScrolled=false（用户没有手动滚动离开底部）
  useEffect(() => {
    // 检查所有必要条件
    if (!isLoading || !shouldAutoScroll || userScrolled || !parentRef.current) {
      return; // 不满足条件时不启动定时器
    }

    // 启动定时器，定期滚动到底部
    const intervalId = setInterval(() => {
      // 使用 ref 检查最新的 userScrolled 值，避免闭包问题
      if (parentRef.current && !userScrolledRef.current) {
        // 直接设置滚动位置到底部
        const newScrollTop = parentRef.current.scrollHeight;
        markProgrammaticScroll();
        parentRef.current.scrollTop = newScrollTop;
        // 更新记录的滚动位置
        lastScrollTopRef.current = newScrollTop;
      }
    }, 100); // 每 100ms 滚动一次

    // 清理函数：当依赖变化（如 isLoading 变为 false）或组件卸载时，清除定时器
    return () => {
      clearInterval(intervalId);
    };
  }, [isLoading, shouldAutoScroll, userScrolled]);

  return {
    parentRef,
    userScrolled,
    setUserScrolled: setUserScrolledWithRef,
    setShouldAutoScroll,
    scrollToBottom
  };
}
