/**
 * Selection Translation Popup Component
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { Loader2, Languages, Copy, Check, RefreshCw, X } from 'lucide-react';
import { selectionTranslationService } from '@/lib/selection-translation-service';
import type { TranslationResponse } from '@/types/selection-translation';

interface SelectionTranslatePopupProps {
  selectedText: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export const SelectionTranslatePopup: React.FC<SelectionTranslatePopupProps> = ({
  selectedText,
  position,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TranslationResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleTranslate = useCallback(async () => {
    if (!selectedText.trim()) return;
    setLoading(true);
    setResult(null);
    setShowResult(true);
    try {
      const response = await selectionTranslationService.translate(selectedText);
      console.log('[Popup] response:', response);
      setResult(response);
    } catch (error) {
      setResult({ success: false, error: error instanceof Error ? error.message : 'Failed' });
    } finally {
      setLoading(false);
    }
  }, [selectedText]);

  const handleCopy = useCallback(async () => {
    if (result?.translatedText) {
      await navigator.clipboard.writeText(result.translatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [result]);

  const handleCopyAlt = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const getPopupStyle = useCallback(() => {
    const padding = 12;

    if (!showResult) {
      const popupWidth = 96; // estimated button width
      const popupHeight = 40;
      const y = position.y + 10;
      const x = Math.min(
        window.innerWidth - padding - popupWidth / 2,
        Math.max(padding + popupWidth / 2, position.x),
      );

      return {
        position: 'fixed' as const,
        left: x + 'px',
        top: Math.min(window.innerHeight - padding - popupHeight, Math.max(padding, y)) + 'px',
        transform: 'translateX(-50%)',
        zIndex: 9999,
      };
    }
  }, [position, showResult]);

  // Prevent events from propagating
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  if (!mounted) return null;

  return createPortal(
    !showResult ? (
      <div
        ref={popupRef}
        style={getPopupStyle()}
        data-translation-popup="true"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        className="select-none"
      >
        <button
          type="button"
          onClick={handleTranslate}
          className="flex items-center gap-1.5 h-9 px-4 rounded-lg font-medium text-sm bg-blue-600 hover:bg-blue-700 text-white shadow-lg border border-blue-500 transition-all active:scale-95"
        >
          <Languages className="h-4 w-4" />
          <span>翻译</span>
        </button>
      </div>
    ) : (
      <div
        className="fixed inset-0 z-[2147483647] p-4 flex items-center justify-center"
        data-translation-popup="true"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <button
          type="button"
          aria-label="关闭翻译结果"
          className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
          onClick={onClose}
        />

        <div
          ref={popupRef}
          className="relative w-[min(960px,92vw)] max-h-[92vh] bg-white dark:bg-zinc-900 rounded-xl shadow-2xl overflow-hidden border border-gray-200 dark:border-zinc-700 flex flex-col"
        >
          <div className="flex items-center justify-between px-4 py-2.5 bg-blue-600 text-white">
            <div className="flex items-center gap-2">
              <Languages className="h-4 w-4" />
              <span className="text-sm font-semibold">翻译结果</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 p-4 overflow-y-auto no-scrollbar space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-gray-500 dark:text-gray-400">原文</div>
              <div className="select-text text-sm text-gray-800 dark:text-gray-200 bg-gray-100 dark:bg-zinc-800 p-3 rounded-lg border border-gray-200 dark:border-zinc-700 whitespace-pre-wrap break-words">
                {selectedText}
              </div>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">翻译中...</span>
              </div>
            )}

            {!loading && result && result.success && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400">译文</div>
                  <div className="select-text text-sm p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
                    {result.translatedText}
                  </div>
                </div>

                {result.alternatives && result.alternatives.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold text-orange-600 dark:text-orange-400">
                      备选翻译 ({result.alternatives.length})
                    </div>
                    <div className="space-y-1">
                      {result.alternatives.map((alt, i) => (
                        <div
                          key={i}
                          onClick={() => handleCopyAlt(alt)}
                          className="flex items-center justify-between text-sm p-2 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-md text-gray-700 dark:text-gray-300 hover:bg-orange-100 dark:hover:bg-orange-900/40 cursor-pointer"
                          title="点击复制"
                        >
                          <span className="select-text">{alt}</span>
                          <Copy className="h-3 w-3 text-orange-500 ml-2" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Button size="sm" onClick={handleCopy} className="w-full h-10 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-2" />
                      复制译文
                    </>
                  )}
                </Button>
              </div>
            )}

            {!loading && result && !result.success && (
              <div className="space-y-2">
                <div className="text-sm text-red-700 dark:text-red-400 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
                  {result.error || '翻译失败'}
                </div>
                <Button size="sm" variant="outline" onClick={handleTranslate} className="w-full h-10 text-sm rounded-lg">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  重试
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    ),
    document.body,
  );
};

export default SelectionTranslatePopup;
