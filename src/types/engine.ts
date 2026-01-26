/**
 * 引擎类型定义
 * 定义 AI 引擎相关的类型和接口
 */

import type { FC } from 'react';

/**
 * 引擎类型
 */
export type EngineType = 'claude' | 'codex' | 'gemini';

/**
 * 引擎运行环境
 */
export type EngineEnvironment = 'native' | 'wsl';

/**
 * 引擎状态类型
 */
export type EngineStatusType = 
  | 'connected'      // 已安装且可用
  | 'disconnected'   // 未安装
  | 'checking'       // 检查中
  | 'error';         // 检测出错

/**
 * 引擎状态信息
 */
export interface EngineStatus {
  /** 连接状态 */
  status: EngineStatusType;
  
  /** 版本号 */
  version?: string;
  
  /** 运行环境 (Native/WSL) */
  environment?: EngineEnvironment;
  
  /** WSL 发行版名称 (仅 WSL 环境) */
  wslDistro?: string;
  
  /** 引擎可执行文件路径 */
  path?: string;
  
  /** 最后检查时间 */
  lastChecked?: Date;
  
  /** 错误信息 */
  error?: string;
  
  /** 是否有可用更新 */
  updateAvailable?: boolean;
  
  /** 最新版本号 */
  latestVersion?: string;
}

/**
 * 引擎配置信息
 */
export interface EngineConfig {
  /** 引擎类型标识 */
  type: EngineType;
  
  /** 引擎名称 (用于代码) */
  name: string;
  
  /** 引擎显示名称 (用于 UI) */
  displayName: string;
  
  /** 引擎图标组件 */
  Icon: FC<{ className?: string }>;
  
  /** 主题颜色 */
  color: string;
  
  /** 背景颜色 */
  bgColor: string;
  
  /** 安装指南 URL */
  installUrl: string;
  
  /** 文档 URL */
  docsUrl: string;
  
  /** 更新检查 URL (可选) */
  updateCheckUrl?: string;
}

/**
 * 引擎错误类型
 */
export enum EngineErrorType {
  /** 引擎未安装 */
  NOT_INSTALLED = 'not_installed',
  
  /** 权限不足 */
  PERMISSION_DENIED = 'permission_denied',
  
  /** 路径无效 */
  INVALID_PATH = 'invalid_path',
  
  /** 版本检查失败 */
  VERSION_CHECK_FAILED = 'version_check_failed',
  
  /** 检测超时 */
  TIMEOUT = 'timeout',
  
  /** 未知错误 */
  UNKNOWN = 'unknown'
}

/**
 * 引擎状态缓存
 */
export interface EngineStatusCache {
  [engineType: string]: {
    status: EngineStatus;
    timestamp: number;
    ttl: number;
  };
}

/**
 * 统一的引擎状态响应 (来自后端)
 */
export interface UnifiedEngineStatus {
  /** 引擎名称 */
  engine: string;
  
  /** 是否已安装 */
  isInstalled: boolean;
  
  /** 版本号 */
  version?: string;
  
  /** 运行环境 */
  environment: string;
  
  /** WSL 发行版 */
  wslDistro?: string;
  
  /** 可执行文件路径 */
  path?: string;
  
  /** 错误信息 */
  error?: string;
  
  /** 最后检查时间戳 */
  lastChecked?: number;
}

/**
 * 引擎更新结果 (来自后端)
 */
export interface EngineUpdateResult {
  /** 是否成功 */
  success: boolean;
  
  /** 更新前的版本 */
  oldVersion?: string;
  
  /** 更新后的版本 */
  newVersion?: string;
  
  /** 更新输出信息 */
  output: string;
  
  /** 错误信息 */
  error?: string;
}

/**
 * 检查更新结果 (来自后端)
 */
export interface CheckUpdateResult {
  /** 当前版本 */
  currentVersion?: string;
  
  /** 最新版本 */
  latestVersion?: string;
  
  /** 是否有更新可用 */
  updateAvailable: boolean;
  
  /** 错误信息 */
  error?: string;
}
