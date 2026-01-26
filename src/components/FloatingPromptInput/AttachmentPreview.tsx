import React, { useState, useEffect } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImagePreview } from "../ImagePreview";

interface AttachmentPreviewProps {
  imageAttachments: Array<{ id: string; previewUrl: string; filePath: string }>;
  embeddedImages: Array<any>;
  onRemoveAttachment: (id: string) => void;
  onRemoveEmbedded: (index: number) => void;
  className?: string;
}

/**
 * 图片放大查看模态框
 */
interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

const ImageLightbox: React.FC<ImageLightboxProps> = ({ src, alt, onClose }) => {
  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out"
      style={{ zIndex: 9999 }}
      onClick={onClose}
    >
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 bg-white/10 hover:bg-white/20 text-white rounded-full flex items-center justify-center transition-colors"
      >
        <X className="h-5 w-5" />
      </button>

      {/* 图片 */}
      <img
        src={src}
        alt={alt || "Image preview"}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
};

export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({
  imageAttachments,
  embeddedImages,
  onRemoveAttachment,
  onRemoveEmbedded,
  className
}) => {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt?: string } | null>(null);

  // 辅助函数:获取图片源 URL
  const getImageSrc = (previewUrl: string, filePath?: string): string => {
    // 如果 previewUrl 是 blob URL,尝试使用 filePath
    if (previewUrl.startsWith('blob:') && filePath) {
      return convertFileSrc(filePath);
    }
    // 如果 previewUrl 已经是 data URL 或其他格式,直接使用
    if (previewUrl.startsWith('data:') || previewUrl.startsWith('http')) {
      return previewUrl;
    }
    // 否则尝试转换为 Tauri 协议
    return convertFileSrc(previewUrl);
  };

  // 辅助函数:从文件路径提取文件名
  const getFileName = (filePath: string): string => {
    // 处理 Windows 和 Unix 路径分隔符
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || 'image.png';
  };

  if (imageAttachments.length === 0 && embeddedImages.length === 0) return null;

  return (
    <>
      {/* 图片放大模态框 */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}

      <div className={className}>
        {/* Image attachments preview - 标签页样式 */}
        {imageAttachments.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
            {imageAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="inline-flex items-center gap-1.5 px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded border border-gray-300 dark:border-gray-600 cursor-pointer transition-colors group"
                onClick={() => setLightboxImage({ src: getImageSrc(attachment.previewUrl, attachment.filePath), alt: "图片预览" })}
              >
                {/* 图片图标 */}
                <div className="w-3.5 h-3.5 rounded bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-2.5 h-2.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>

                {/* 文件名 - 从路径提取真实文件名 */}
                <span className="text-xs text-gray-700 dark:text-gray-200 truncate max-w-[100px]">
                  {getFileName(attachment.filePath)}
                </span>

                {/* 删除按钮 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveAttachment(attachment.id);
                  }}
                  className="w-3.5 h-3.5 rounded-full hover:bg-red-100 dark:hover:bg-red-900/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  title="删除"
                >
                  <X className="h-2.5 w-2.5 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Embedded images preview */}
        {embeddedImages.length > 0 && (
          <ImagePreview
            images={embeddedImages}
            onRemove={onRemoveEmbedded}
            onImageClick={(src, _index) => setLightboxImage({ src, alt: "Embedded image" })}
            className="pt-2"
          />
        )}
      </div>
    </>
  );
};
