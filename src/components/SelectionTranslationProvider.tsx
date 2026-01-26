/**
 * 选中翻译功能提供者组件
 * 
 * 包装聊天界面，提供文本选中翻译功能
 */

import React, { useRef, useEffect, useState } from 'react';
import { useTextSelection } from '@/hooks/useTextSelection';
import { SelectionTranslatePopup } from './SelectionTranslatePopup';
import { selectionTranslationService } from '@/lib/selection-translation-service';

interface SelectionTranslationProviderProps {
  /** 子组件 */
  children: React.ReactNode;
  /** 是否启用 */
  enabled?: boolean;
}

/**
 * 选中翻译功能提供者
 * 
 * 使用方法：
 * ```tsx
 * <SelectionTranslationProvider>
 *   <ChatMessages />
 * </SelectionTranslationProvider>
 * ```
 */
export const SelectionTranslationProvider: React.FC<SelectionTranslationProviderProps> = ({
  children,
  enabled: propEnabled = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [serviceEnabled, setServiceEnabled] = useState(true);

  // 初始化服务并检查是否启用
  useEffect(() => {
    const initService = async () => {
      await selectionTranslationService.init();
      const isEnabled = await selectionTranslationService.isEnabled();
      setServiceEnabled(isEnabled);
    };
    initService();
  }, []);

  const isEnabled = propEnabled && serviceEnabled;

  // 使用文本选中 Hook
  const { selection, clearSelection } = useTextSelection({
    enabled: isEnabled,
    minLength: 1,
    delay: 300,
    containerRef,
  });

  return (
    // 🔧 FIX: 添加 h-full flex-1 flex flex-col 确保高度正确传递给子组件
    <div ref={containerRef} className="relative h-full flex-1 flex flex-col overflow-hidden">
      {children}
      
      {/* 选中翻译弹窗 */}
      {isEnabled && selection.isVisible && selection.selectedText && (
        <SelectionTranslatePopup
          selectedText={selection.selectedText}
          position={selection.position}
          onClose={clearSelection}
        />
      )}
    </div>
  );
};

export default SelectionTranslationProvider;
