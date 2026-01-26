/**
 * Codex 模型和推理模式选择器类型定义
 */

// ============================================================================
// 推理模式相关类型
// ============================================================================

/**
 * 推理模式选项
 */
export interface ReasoningModeOption {
  /** 推理模式值 */
  value: string;
  /** 显示标签 */
  label: string;
  /** 描述信息 */
  description: string;
  /** 排序顺序 */
  order: number;
}

/**
 * 推理模式类型（动态加载）
 */
export type ReasoningMode = string;

// ============================================================================
// 模型相关类型
// ============================================================================

/**
 * Codex 模型选项
 */
export interface CodexModelOption {
  /** 模型值 */
  value: string;
  /** 显示标签 */
  label: string;
  /** 描述信息 */
  description: string;
  /** 模型类别 */
  category?: string;
  /** 是否可用 */
  isAvailable: boolean;
  /** 排序顺序 */
  order: number;
  /** 该模型支持的推理模式 */
  supportedReasoningModes: string[];
}

/**
 * Codex 模型类型（动态加载）
 */
export type CodexModel = string;

// ============================================================================
// 配置相关类型
// ============================================================================

/**
 * Codex 选择配置
 */
export interface CodexSelectionConfig {
  /** 推理模式 */
  reasoningMode: ReasoningMode;
  /** 模型 */
  model: CodexModel;
  /** 时间戳 */
  timestamp: number;
}

/**
 * Codex 能力信息
 */
export interface CodexCapabilities {
  /** 可用的推理模式 */
  reasoningModes: ReasoningModeOption[];
  /** 可用的模型 */
  models: CodexModelOption[];
  /** 默认配置 */
  defaults: {
    reasoningMode: string;
    model: string;
  };
  /** 最后更新时间 */
  lastUpdated: string;
  /** Codex 版本 */
  codexVersion?: string;
}

// ============================================================================
// 组件 Props 类型
// ============================================================================

/**
 * 推理模式选择器 Props
 */
export interface ReasoningModeSelectorProps {
  /** 当前选中的推理模式 */
  selectedMode: ReasoningMode;
  /** 可用的推理模式选项 */
  options: ReasoningModeOption[];
  /** 推理模式变更回调 */
  onModeChange: (mode: ReasoningMode) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示加载状态 */
  loading?: boolean;
}

/**
 * 模型选择器 Props
 */
export interface ModelSelectorProps {
  /** 当前选中的模型 */
  selectedModel: CodexModel;
  /** 可用的模型选项 */
  options: CodexModelOption[];
  /** 模型变更回调 */
  onModelChange: (model: CodexModel) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示加载状态 */
  loading?: boolean;
}

/**
 * Codex 模型选择器主组件 Props
 */
export interface CodexModelSelectorProps {
  /** 配置变更回调 */
  onConfigChange: (config: CodexSelectionConfig) => void;
  /** 初始配置 */
  initialConfig?: CodexSelectionConfig;
  /** 是否可见 */
  isVisible: boolean;
  /** 确认回调 */
  onConfirm?: (config: CodexSelectionConfig) => void;
  /** 取消回调 */
  onCancel?: () => void;
  /** 是否显示确认按钮 */
  showConfirmButton?: boolean;
}

// ============================================================================
// 状态管理类型
// ============================================================================

/**
 * 选择器状态
 */
export interface CodexSelectorState {
  /** 当前配置 */
  config: CodexSelectionConfig;
  /** 可用能力 */
  capabilities: CodexCapabilities | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 是否已初始化 */
  initialized: boolean;
}

/**
 * 选择器上下文类型
 */
export interface CodexSelectorContextType {
  /** 当前状态 */
  state: CodexSelectorState;
  /** 更新配置 */
  updateConfig: (config: Partial<CodexSelectionConfig>) => void;
  /** 保存配置 */
  saveConfig: () => Promise<void>;
  /** 加载配置 */
  loadConfig: () => Promise<void>;
  /** 刷新能力 */
  refreshCapabilities: () => Promise<void>;
  /** 重置为默认配置 */
  resetToDefaults: () => void;
}

// ============================================================================
// API 响应类型
// ============================================================================

/**
 * 获取配置响应
 */
export type GetConfigResponse = CodexSelectionConfig | null;

/**
 * 保存配置响应
 */
export type SaveConfigResponse = void;

/**
 * 获取默认配置响应
 */
export type GetDefaultConfigResponse = CodexSelectionConfig;

/**
 * 获取推理模式响应
 */
export type GetReasoningModesResponse = ReasoningModeOption[];

/**
 * 获取模型响应
 */
export type GetModelsResponse = CodexModelOption[];

/**
 * 刷新能力响应
 */
export type RefreshCapabilitiesResponse = CodexCapabilities;