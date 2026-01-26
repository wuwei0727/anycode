/**
 * Text Selection Detection Hook
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TextSelectionState, PopupPosition } from '@/types/selection-translation';

interface UseTextSelectionOptions {
  enabled?: boolean;
  minLength?: number;
  delay?: number;
  containerRef?: React.RefObject<HTMLElement>;
}

interface UseTextSelectionReturn {
  selection: TextSelectionState;
  clearSelection: () => void;
}

function isEmptyOrWhitespace(text: string): boolean {
  return !text || text.trim().length === 0;
}

function getSelectionPosition(selection: Selection): PopupPosition | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  // Use client rects for more accurate positioning (esp. multi-line selections)
  const rects = Array.from(range.getClientRects());
  const rect =
    rects
      .slice()
      .reverse()
      .find((r) => r.width > 0 && r.height > 0) ?? range.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.bottom,
  };
}

export function useTextSelection(options: UseTextSelectionOptions = {}): UseTextSelectionReturn {
  const {
    enabled = true,
    minLength = 1,
    delay = 50, // Reduced from 200ms to 50ms for faster response
    containerRef,
  } = options;

  const [selection, setSelection] = useState<TextSelectionState>({
    selectedText: '',
    position: { x: 0, y: 0 },
    isVisible: false,
  });

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPopupInteractionRef = useRef(false);
  const hasShownResultRef = useRef(false); // Track if translation result is shown

  const clearSelection = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    hasShownResultRef.current = false;
    setSelection({
      selectedText: '',
      position: { x: 0, y: 0 },
      isVisible: false,
    });
  }, []);

  const handleSelectionChange = useCallback(() => {
    if (!enabled) return;
    
    // Skip if user is interacting with popup
    if (isPopupInteractionRef.current) {
      return;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    const windowSelection = window.getSelection();
    if (!windowSelection) {
      // Only clear if result is not shown yet
      if (!hasShownResultRef.current) {
        clearSelection();
      }
      return;
    }

    const selectedText = windowSelection.toString();

    // If selection is empty or whitespace
    if (isEmptyOrWhitespace(selectedText) || selectedText.length < minLength) {
      // Only clear if result is not shown yet (user hasn't clicked translate)
      if (!hasShownResultRef.current) {
        clearSelection();
      }
      return;
    }

    if (containerRef?.current) {
      const anchorNode = windowSelection.anchorNode;
      if (anchorNode && !containerRef.current.contains(anchorNode)) {
        if (!hasShownResultRef.current) {
          clearSelection();
        }
        return;
      }
    }

    const position = getSelectionPosition(windowSelection);
    if (!position) {
      if (!hasShownResultRef.current) {
        clearSelection();
      }
      return;
    }

    // Show popup quickly
    timeoutRef.current = setTimeout(() => {
      setSelection({
        selectedText,
        position,
        isVisible: true,
      });
    }, delay);
  }, [enabled, minLength, delay, containerRef, clearSelection]);

  const handleMouseUp = useCallback((e: Event) => {
    const target = (e as MouseEvent).target;
    // Check if click is inside translation popup
    const popup = target instanceof Element ? target.closest('[data-translation-popup]') : null;
    if (popup) {
      isPopupInteractionRef.current = true;
      setTimeout(() => {
        isPopupInteractionRef.current = false;
      }, 100);
      return;
    }
    setTimeout(handleSelectionChange, 10);
  }, [handleSelectionChange]);

  const handleMouseDown = useCallback((e: Event) => {
    const target = (e as MouseEvent).target;
    // Check if click is inside translation popup
    const popup = target instanceof Element ? target.closest('[data-translation-popup]') : null;
    if (popup) {
      isPopupInteractionRef.current = true;
      return;
    }
    
    // User clicked outside popup - clear selection
    isPopupInteractionRef.current = false;
    hasShownResultRef.current = false;
    clearSelection();
  }, [clearSelection]);

  // Mark that result is shown when popup becomes visible
  useEffect(() => {
    if (selection.isVisible) {
      // Will be set to true when user clicks translate button
    }
  }, [selection.isVisible]);

  useEffect(() => {
    if (!enabled) {
      clearSelection();
      return;
    }

    // Always attach mouse listeners on document so the popup can live in a portal (e.g. document.body)
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('selectionchange', handleSelectionChange);

    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('selectionchange', handleSelectionChange);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [enabled, containerRef, handleMouseUp, handleMouseDown, handleSelectionChange, clearSelection]);

  return {
    selection,
    clearSelection,
  };
}

export default useTextSelection;
