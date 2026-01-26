import { useState, useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { ImageAttachment } from "../types";

export interface UseImageHandlingOptions {
  prompt: string;
  projectPath?: string;
  isExpanded: boolean;
  onPromptChange: (newPrompt: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  expandedTextareaRef: React.RefObject<HTMLTextAreaElement>;
}

export function useImageHandling({
  prompt,
  projectPath,
  isExpanded,
  onPromptChange,
  textareaRef,
  expandedTextareaRef,
}: UseImageHandlingOptions) {
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [embeddedImages, setEmbeddedImages] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const unlistenDragDropRef = useRef<(() => void) | null>(null);

  // Helper function to check if a file is an image
  const isImageFile = (path: string): boolean => {
    if (path.startsWith('data:image/')) {
      return true;
    }
    const ext = path.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext || '');
  };

  // Extract image paths from prompt text
  const extractImagePaths = (text: string): string[] => {
    console.log('[extractImagePaths] 输入文本:', text);
    const pathsSet = new Set<string>();

    // 模式1: @"path" 格式(带引号的路径,有 @ 前缀)
    const quotedRegex = /@"([^"]+)"/g;
    let matches = Array.from(text.matchAll(quotedRegex));
    for (const match of matches) {
      const path = match[1];
      const fullPath = path.startsWith('data:')
        ? path
        : (path.startsWith('/') ? path : (projectPath ? `${projectPath}/${path}` : path));

      if (isImageFile(fullPath)) {
        console.log('[extractImagePaths] 模式1匹配:', fullPath);
        pathsSet.add(fullPath);
      }
    }

    // Remove quoted mentions to avoid double-matching
    let textWithoutQuoted = text.replace(quotedRegex, '');

    // 模式2: @path 格式(不带引号,有 @ 前缀)
    const unquotedRegex = /@([^@\n\s]+)/g;
    matches = Array.from(textWithoutQuoted.matchAll(unquotedRegex));
    for (const match of matches) {
      const path = match[1].trim();
      if (path.includes('data:')) continue;

      const fullPath = path.startsWith('/') ? path : (projectPath ? `${projectPath}/${path}` : path);

      if (isImageFile(fullPath)) {
        console.log('[extractImagePaths] 模式2匹配:', fullPath);
        pathsSet.add(fullPath);
      }
    }

    // 模式3: "path" 格式(带引号但无 @ 前缀,Codex 格式)
    const quotedPathPattern = /"([A-Za-z]:\\[^"]+|\/[^"]+)"/g;
    matches = Array.from(text.matchAll(quotedPathPattern));
    for (const match of matches) {
      const path = match[1];
      if (isImageFile(path)) {
        console.log('[extractImagePaths] 模式3匹配:', path);
        pathsSet.add(path);
      }
    }

    // 模式4: 直接路径格式(无引号无 @ 前缀,Codex 格式)
    // 匹配 Windows 路径 C:\...\image.png 或 Unix 路径 /path/to/image.png
    const directPathPattern = /(?:^|\s)([A-Za-z]:\\[^\s"]+|\/(?:[^\s"]+\/)+[^\s"]+)(?=\s|$)/g;
    matches = Array.from(text.matchAll(directPathPattern));
    for (const match of matches) {
      const path = match[1];
      if (isImageFile(path)) {
        console.log('[extractImagePaths] 模式4匹配:', path);
        pathsSet.add(path);
      }
    }

    const result = Array.from(pathsSet);
    console.log('[extractImagePaths] 提取结果:', result);
    return result;
  };

  // Update embedded images when prompt changes
  useEffect(() => {
    const imagePaths = extractImagePaths(prompt);
    setEmbeddedImages(imagePaths);
  }, [prompt, projectPath]);

  // Set up Tauri drag-drop event listener
  useEffect(() => {
    let lastDropTime = 0;

    const setupListener = async () => {
      try {
        if (unlistenDragDropRef.current) {
          unlistenDragDropRef.current();
        }

        const webview = getCurrentWebviewWindow();
        unlistenDragDropRef.current = await webview.onDragDropEvent((event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            setDragActive(true);
          } else if (event.payload.type === 'leave') {
            setDragActive(false);
          } else if (event.payload.type === 'drop' && event.payload.paths) {
            setDragActive(false);

            const currentTime = Date.now();
            if (currentTime - lastDropTime < 200) {
              return;
            }
            lastDropTime = currentTime;

            const droppedPaths = event.payload.paths as string[];
            const imagePaths = droppedPaths.filter(isImageFile);

            if (imagePaths.length > 0) {
              const existingPaths = extractImagePaths(prompt);
              const newPaths = imagePaths.filter(p => !existingPaths.includes(p));

              if (newPaths.length === 0) return;

              const mentionsToAdd = newPaths.map(p => {
                return p.includes(' ') ? `@"${p}"` : `@${p}`;
              }).join(' ');
              
              const newPrompt = prompt + (prompt.endsWith(' ') || prompt === '' ? '' : ' ') + mentionsToAdd + ' ';

              onPromptChange(newPrompt);

              setTimeout(() => {
                const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
                target?.focus();
                target?.setSelectionRange(newPrompt.length, newPrompt.length);
              }, 0);
            }
          }
        });
      } catch (error) {
        console.error('Failed to set up Tauri drag-drop listener:', error);
      }
    };

    setupListener();

    return () => {
      if (unlistenDragDropRef.current) {
        unlistenDragDropRef.current();
        unlistenDragDropRef.current = null;
      }
    };
  }, [prompt, projectPath, isExpanded]);

  // Handle paste images from clipboard
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        
        const blob = item.getAsFile();
        if (!blob) continue;

        try {
          const reader = new FileReader();
          reader.onload = async () => {
            const base64Data = reader.result as string;
            
            try {
              const result = await api.saveClipboardImage(base64Data);

              if (result.success && result.file_path) {
                // 使用 Tauri 的 convertFileSrc 将文件路径转换为可用的 URL
                // 这样可以正确显示保存到临时目录的图片
                const previewUrl = convertFileSrc(result.file_path);

                console.log('[handlePaste] Image saved to:', result.file_path);
                console.log('[handlePaste] Preview URL:', previewUrl);

                const newAttachment: ImageAttachment = {
                  id: Date.now().toString(),
                  filePath: result.file_path,
                  previewUrl: previewUrl,
                  width: 0,
                  height: 0,
                };

                setImageAttachments(prev => [...prev, newAttachment]);
              } else {
                console.error('Failed to save clipboard image:', result.error);
                alert('保存剪贴板图片失败，请重试');
              }
            } catch (error) {
              console.error('Failed to save clipboard image:', error);
              alert('保存剪贴板图片失败，请重试');
            }
          };
          
          reader.readAsDataURL(blob);
        } catch (error) {
          console.error('Failed to paste image:', error);
          alert('粘贴图片失败，请重试');
        }
      }
    }
  };

  // Remove image attachment by ID
  const handleRemoveImageAttachment = (attachmentId: string) => {
    setImageAttachments(prev => prev.filter(attachment => attachment.id !== attachmentId));
  };

  // Remove embedded image from prompt
  const handleRemoveEmbeddedImage = (index: number) => {
    const imagePath = embeddedImages[index];

    if (imagePath.startsWith('data:')) {
      const quotedPath = `@"${imagePath}"`;
      const newPrompt = prompt.replace(quotedPath, '').trim();
      onPromptChange(newPrompt);
      return;
    }

    try {
      const escapedPath = imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedRelativePath = imagePath.replace(projectPath + '/', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const patterns = [
        new RegExp(`@"${escapedPath}"\\s?`, 'g'),
        new RegExp(`@${escapedPath}\\s?`, 'g'),
        new RegExp(`@"${escapedRelativePath}"\\s?`, 'g'),
        new RegExp(`@${escapedRelativePath}\\s?`, 'g')
      ];

      let newPrompt = prompt;
      for (const pattern of patterns) {
        newPrompt = newPrompt.replace(pattern, '');
      }

      onPromptChange(newPrompt.trim());
    } catch (error) {
      // 如果正则表达式创建失败，使用简单的字符串替换
      console.error('[handleRemoveEmbeddedImage] Regex error:', error);
      const simplePatterns = [`@"${imagePath}"`, `@${imagePath}`];
      let newPrompt = prompt;
      for (const pattern of simplePatterns) {
        newPrompt = newPrompt.split(pattern).join('');
      }
      onPromptChange(newPrompt.trim());
    }
  };

  // Browser drag and drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Add image programmatically (via ref)
  const addImage = (imagePath: string) => {
    if (!isImageFile(imagePath)) return;

    const existingPaths = extractImagePaths(prompt);
    if (existingPaths.includes(imagePath)) return;

    const mention = imagePath.includes(' ') ? `@"${imagePath}"` : `@${imagePath}`;
    const newPrompt = prompt + (prompt.endsWith(' ') || prompt === '' ? '' : ' ') + mention + ' ';
    
    onPromptChange(newPrompt);

    setTimeout(() => {
      const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
      target?.focus();
      target?.setSelectionRange(newPrompt.length, newPrompt.length);
    }, 0);
  };

  return {
    imageAttachments,
    embeddedImages,
    dragActive,
    handlePaste,
    handleRemoveImageAttachment,
    handleRemoveEmbeddedImage,
    handleDrag,
    handleDrop,
    addImage,
    setImageAttachments,
    setEmbeddedImages,
  };
}
