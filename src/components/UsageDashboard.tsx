import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { EngineFilter } from "@/components/EngineFilter";
import { api, type UsageStats, type ProjectUsage, type MultiEngineUsageStats, type EngineType } from "@/lib/api";
import { ClaudeIcon } from "@/components/icons/ClaudeIcon";
import { CodexIcon } from "@/components/icons/CodexIcon";
import { GeminiIcon } from "@/components/icons/GeminiIcon";
import { 
  Calendar, 
  Filter,
  Loader2,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  ArrowLeft
} from "lucide-react";

interface UsageDashboardProps {
  /**
   * Callback when back button is clicked
   */
  onBack: () => void;
}

// Cache for storing fetched data
const dataCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes cache - increased for better performance

/**
 * Optimized UsageDashboard component with caching and progressive loading
 */
export const UsageDashboard: React.FC<UsageDashboardProps> = ({ onBack }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [multiEngineStats, setMultiEngineStats] = useState<MultiEngineUsageStats | null>(null);
  const [sessionStats, setSessionStats] = useState<ProjectUsage[] | null>(null);
  const [sessionStatsLoading, setSessionStatsLoading] = useState(false);
  const [selectedDateRange, setSelectedDateRange] = useState<"today" | "7d" | "30d" | "all">("7d");
  const [selectedEngine, setSelectedEngine] = useState<EngineType>("all");
  const [activeTab, setActiveTab] = useState("overview");
  const [hasLoadedTabs, setHasLoadedTabs] = useState<Set<string>>(new Set(["overview"]));
  
  // Pagination states
  const [projectsPage, setProjectsPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  // Engine display names and colors
  const engineConfig: Record<string, { name: string; color: string; bgColor: string; Icon: React.FC<{ className?: string }> }> = {
    claude: { name: "Claude", color: "text-orange-600", bgColor: "bg-orange-100", Icon: ClaudeIcon },
    codex: { name: "Codex", color: "text-green-600", bgColor: "bg-green-100", Icon: CodexIcon },
    gemini: { name: "Gemini", color: "text-blue-600", bgColor: "bg-blue-100", Icon: GeminiIcon },
  };

  // Memoized formatters to prevent recreation on each render
  const formatCurrency = useMemo(() => (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }, []);

  const formatNumber = useMemo(() => (num: number): string => {
    return new Intl.NumberFormat('en-US').format(num);
  }, []);

  const formatTokens = useMemo(() => (num: number): string => {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return formatNumber(num);
  }, [formatNumber]);

  const getModelDisplayName = useCallback((model: string): string => {
    const modelMap: Record<string, string> = {
      "claude-4-opus": "Opus 4",
      "claude-4-sonnet": "Sonnet 4",
      "claude-3.5-sonnet": "Sonnet 3.5",
      "claude-3-opus": "Opus 3",
    };
    return modelMap[model] || model;
  }, []);

  // Function to get cached data or null
  const getCachedData = useCallback((key: string) => {
    const cached = dataCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
    return null;
  }, []);

  // Function to set cached data
  const setCachedData = useCallback((key: string, data: any) => {
    dataCache.set(key, { data, timestamp: Date.now() });
  }, []);

  const loadUsageStats = useCallback(async () => {
    const cacheKey = `usage-${selectedDateRange}-${selectedEngine}`;
    
    // Check cache first
    const cachedStats = getCachedData(`${cacheKey}-stats`);
    const cachedMultiEngine = getCachedData(`${cacheKey}-multi`);
    const cachedSessions = getCachedData(`${cacheKey}-sessions`);
    
    // Fast-path: if we have main stats cached, render immediately.
    if (cachedStats && cachedMultiEngine) {
      setStats(cachedStats);
      setMultiEngineStats(cachedMultiEngine);
      setLoading(false);
      if (cachedSessions) setSessionStats(cachedSessions);
    }

    try {
      // Always show loading when fetching
      if (!(cachedStats && cachedMultiEngine)) setLoading(true);
      setError(null);

      // Get today's date range
      const today = new Date();
      // 🚀 修复时区问题：使用本地日期格式而不是 ISO 字符串
      const formatLocalDate = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };

      let statsData: UsageStats;
      let multiEngineData: MultiEngineUsageStats;
      
      // Calculate date range
      let startDateStr: string | undefined;
      let endDateStr: string | undefined;

      if (selectedDateRange === "today") {
        const todayDateStr = formatLocalDate(today);
        startDateStr = todayDateStr;
        endDateStr = todayDateStr;
      } else if (selectedDateRange !== "all") {
        const endDate = new Date();
        const startDate = new Date();
        const days = selectedDateRange === "7d" ? 7 : 30;
        startDate.setDate(startDate.getDate() - days);
        startDateStr = formatLocalDate(startDate);
        endDateStr = formatLocalDate(endDate);
      }

      // Fetch main stats in parallel (do NOT block initial render on session list)
      const multiEnginePromise = api.getMultiEngineUsageStats(selectedEngine, startDateStr, endDateStr);
      let statsPromise: Promise<UsageStats>;

      if (selectedDateRange === "today") {
        const todayDateStr = formatLocalDate(today);
        statsPromise = api.getUsageByDateRange(todayDateStr, todayDateStr);
      } else if (selectedDateRange === "all") {
        statsPromise = api.getUsageStats();
      } else {
        const endDate = new Date();
        const startDate = new Date();
        const days = selectedDateRange === "7d" ? 7 : 30;
        startDate.setDate(startDate.getDate() - days);

        statsPromise = api.getUsageByDateRange(formatLocalDate(startDate), formatLocalDate(endDate));
      }

      const [multiEngineResult, statsResult] = await Promise.all([multiEnginePromise, statsPromise]);
      multiEngineData = multiEngineResult;
      statsData = statsResult;
      
      // Update state
      setStats(statsData);
      setMultiEngineStats(multiEngineData);
      
      // Cache the data
      setCachedData(`${cacheKey}-stats`, statsData);
      setCachedData(`${cacheKey}-multi`, multiEngineData);
    } catch (err: any) {
      console.error("Failed to load usage stats:", err);
      setError("Failed to load usage statistics. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [selectedDateRange, selectedEngine, getCachedData, setCachedData]);  // ⚡ 添加 selectedEngine 依赖

  const loadSessionStats = useCallback(async () => {
    const cacheKey = `usage-${selectedDateRange}-${selectedEngine}`;
    const cachedSessions = getCachedData(`${cacheKey}-sessions`);
    if (cachedSessions) {
      setSessionStats(cachedSessions);
      return;
    }

    try {
      setSessionStatsLoading(true);

      let sessionData: ProjectUsage[] = [];
      if (selectedDateRange === "today") {
        sessionData = await api.getSessionStats();
      } else if (selectedDateRange === "all") {
        sessionData = await api.getSessionStats();
      } else {
        const endDate = new Date();
        const startDate = new Date();
        const days = selectedDateRange === "7d" ? 7 : 30;
        startDate.setDate(startDate.getDate() - days);

        const formatDateForSessionApi = (date: Date) => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}${month}${day}`;
        };

        sessionData = await api.getSessionStats(
          formatDateForSessionApi(startDate),
          formatDateForSessionApi(endDate),
          'desc'
        );
      }

      setSessionStats(sessionData);
      setCachedData(`${cacheKey}-sessions`, sessionData);
    } catch (err) {
      console.error("Failed to load session stats:", err);
    } finally {
      setSessionStatsLoading(false);
    }
  }, [selectedDateRange, selectedEngine, getCachedData, setCachedData]);

  // Load data on mount and when date range changes
  useEffect(() => {
    // Reset pagination when date range changes
    setProjectsPage(1);
    setSessionsPage(1);
    setSessionStats(null);
    loadUsageStats();
  }, [loadUsageStats])

  // Load session stats only when sessions tab is actually opened (or already cached)
  useEffect(() => {
    if (activeTab !== "sessions") return;
    if (sessionStats || sessionStatsLoading) return;
    loadSessionStats();
  }, [activeTab, sessionStats, sessionStatsLoading, loadSessionStats]);

  // Preload adjacent tabs when idle
  useEffect(() => {
    if (!stats || loading) return;
    
    const tabOrder = ["overview", "models", "projects", "sessions", "timeline"];
    const currentIndex = tabOrder.indexOf(activeTab);
    
    // Use requestIdleCallback if available, otherwise setTimeout
    const schedulePreload = (callback: () => void) => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(callback, { timeout: 2000 });
      } else {
        setTimeout(callback, 100);
      }
    };
    
    // Preload adjacent tabs
    schedulePreload(() => {
      if (currentIndex > 0) {
        setHasLoadedTabs(prev => new Set([...prev, tabOrder[currentIndex - 1]]));
      }
      if (currentIndex < tabOrder.length - 1) {
        setHasLoadedTabs(prev => new Set([...prev, tabOrder[currentIndex + 1]]));
      }
    });
  }, [activeTab, stats, loading])

  // Memoize expensive computations - use multiEngineStats when available
  const summaryCards = useMemo(() => {
    // Prefer multiEngineStats for accurate multi-engine data
    const displayStats = multiEngineStats || stats;
    if (!displayStats) return null;
    
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4 shimmer-hover">
          <div>
            <p className="text-caption text-muted-foreground">总费用</p>
            <p className="text-display-2 mt-1">
              {formatCurrency(displayStats.total_cost)}
            </p>
          </div>
        </Card>

        <Card className="p-4 shimmer-hover">
          <div>
            <p className="text-caption text-muted-foreground">总会话数</p>
            <p className="text-display-2 mt-1">
              {formatNumber(displayStats.total_sessions)}
            </p>
          </div>
        </Card>

        <Card className="p-4 shimmer-hover">
          <div>
            <p className="text-caption text-muted-foreground">总令牌数</p>
            <p className="text-display-2 mt-1">
              {formatTokens(displayStats.total_tokens)}
            </p>
          </div>
        </Card>

        <Card className="p-4 shimmer-hover">
          <div>
                        <p className="text-caption text-muted-foreground">平均成本/会话</p>
            <p className="text-display-2 mt-1">
              {formatCurrency(
                displayStats.total_sessions > 0 
                  ? displayStats.total_cost / displayStats.total_sessions 
                  : 0
              )}
            </p>
          </div>
        </Card>
      </div>
    );
  }, [stats, multiEngineStats, formatCurrency, formatNumber, formatTokens]);

  // Memoize the most used models section - use multiEngineStats when available
  const mostUsedModels = useMemo(() => {
    // Prefer multiEngineStats.by_model for multi-engine support
    if (multiEngineStats?.by_model && multiEngineStats.by_model.length > 0) {
      return multiEngineStats.by_model.slice(0, 3).map((model) => {
        const config = engineConfig[model.engine];
        const EngineIcon = config?.Icon;
        return (
          <div key={`${model.engine}-${model.model}`} className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {EngineIcon && <EngineIcon className={`h-4 w-4 ${config?.color || ''}`} />}
              <Badge variant="outline" className={`text-caption ${config?.color || ''}`}>
                {config?.name || model.engine}
              </Badge>
              <Badge variant="secondary" className="text-caption">
                {getModelDisplayName(model.model)}
              </Badge>
              <span className="text-caption text-muted-foreground">
                {model.session_count} sessions
              </span>
            </div>
            <span className="text-body-small font-medium">
              {formatCurrency(model.total_cost)}
            </span>
          </div>
        );
      });
    }
    
    // Fallback to legacy stats
    if (!stats?.by_model) return null;
    
    return stats.by_model.slice(0, 3).map((model) => (
      <div key={model.model} className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Badge variant="outline" className="text-caption">
            {getModelDisplayName(model.model)}
          </Badge>
          <span className="text-caption text-muted-foreground">
            {model.session_count} sessions
          </span>
        </div>
        <span className="text-body-small font-medium">
          {formatCurrency(model.total_cost)}
        </span>
      </div>
    ));
  }, [stats, multiEngineStats, engineConfig, formatCurrency, getModelDisplayName]);

  // Memoize top projects section
  const topProjects = useMemo(() => {
    if (!stats?.by_project) return null;
    
    return stats.by_project.slice(0, 3).map((project) => (
      <div key={project.project_path} className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-body-small font-medium truncate max-w-[200px]" title={project.project_path}>
            {project.project_path}
          </span>
          <span className="text-caption text-muted-foreground">
            {project.session_count} sessions
          </span>
        </div>
        <span className="text-body-small font-medium">
          {formatCurrency(project.total_cost)}
        </span>
      </div>
    ));
  }, [stats, formatCurrency]);

  // Engine colors for timeline chart
  const engineColors: Record<string, string> = {
    claude: 'bg-orange-500',
    codex: 'bg-green-500',
    gemini: 'bg-blue-500',
  };

  // Memoize timeline chart data with multi-engine support
  const timelineChartData = useMemo(() => {
    // Use multiEngineStats.by_date when available for multi-engine view
    if (multiEngineStats?.by_date && multiEngineStats.by_date.length > 0 && selectedEngine === 'all') {
      // Group by date and aggregate by engine
      const dateMap = new Map<string, { date: string; engines: Record<string, number>; total: number }>();
      
      multiEngineStats.by_date.forEach(item => {
        const existing = dateMap.get(item.date);
        if (existing) {
          existing.engines[item.engine] = (existing.engines[item.engine] || 0) + item.total_cost;
          existing.total += item.total_cost;
        } else {
          dateMap.set(item.date, {
            date: item.date,
            engines: { [item.engine]: item.total_cost },
            total: item.total_cost,
          });
        }
      });

      const aggregatedData = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
      const maxCost = Math.max(...aggregatedData.map(d => d.total), 0);
      const halfMaxCost = maxCost / 2;

      return {
        maxCost,
        halfMaxCost,
        isMultiEngine: true,
        bars: aggregatedData.map(day => ({
          ...day,
          heightPercent: maxCost > 0 ? (day.total / maxCost) * 100 : 0,
          dateObj: new Date(day.date.replace(/-/g, '/')),
        }))
      };
    }

    // Fallback to legacy stats.by_date
    if (!stats?.by_date || stats.by_date.length === 0) return null;
    
    const maxCost = Math.max(...stats.by_date.map(d => d.total_cost), 0);
    const halfMaxCost = maxCost / 2;
    const reversedData = stats.by_date.slice().reverse();
    
    return {
      maxCost,
      halfMaxCost,
      isMultiEngine: false,
      reversedData,
      bars: reversedData.map(day => ({
        ...day,
        heightPercent: maxCost > 0 ? (day.total_cost / maxCost) * 100 : 0,
        date: new Date(day.date.replace(/-/g, '/')),
      }))
    };
  }, [stats?.by_date, multiEngineStats?.by_date, selectedEngine]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto flex flex-col h-full">
        {/* Header */}
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              返回主页
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-heading-1">使用情况仪表板</h1>
              <p className="mt-1 text-body-small text-muted-foreground">
                跟踪您的 AI 引擎使用情况和费用
              </p>
            </div>
            {/* Filters */}
            <div className="flex items-center space-x-4">
              {/* Engine Filter */}
              <EngineFilter
                value={selectedEngine}
                onChange={setSelectedEngine}
              />
              {/* Date Range Filter */}
              <div className="flex items-center space-x-2">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <div className="flex space-x-1">
                  {(["today", "7d", "30d", "all"] as const).map((range) => (
                    <Button
                      key={range}
                      variant={selectedDateRange === range ? "default" : "outline"}
                      size="sm"
                      onClick={() => setSelectedDateRange(range)}
                      disabled={loading}
                    >
                      {range === "today" ? "今日" : range === "all" ? "全部" : range === "7d" ? "最近7天" : "最近30天"}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/50 text-body-small text-destructive">
              {error}
              <Button onClick={() => loadUsageStats()} size="sm" className="ml-4">
                Try Again
              </Button>
            </div>
          ) : stats ? (
            <div className="space-y-6">
              {/* Summary Cards */}
              {summaryCards}

              {/* Tabs for different views */}
              <Tabs value={activeTab} onValueChange={(value) => {
                setActiveTab(value);
                setHasLoadedTabs(prev => new Set([...prev, value]));
              }} className="w-full">
                <TabsList className="grid grid-cols-5 w-full mb-6 h-auto p-1">
                  <TabsTrigger value="overview" className="py-2.5 px-3">概览</TabsTrigger>
                  <TabsTrigger value="models" className="py-2.5 px-3">按模型</TabsTrigger>
                  <TabsTrigger value="projects" className="py-2.5 px-3">按项目</TabsTrigger>
                  <TabsTrigger value="sessions" className="py-2.5 px-3">按会话</TabsTrigger>
                  <TabsTrigger value="timeline" className="py-2.5 px-3">时间线</TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="space-y-6 mt-6">
                  {/* Engine Stats - Only show when "all" is selected */}
                  {selectedEngine === "all" && multiEngineStats && multiEngineStats.by_engine.length > 0 && (
                    <Card className="p-6">
                      <h3 className="text-label mb-4">按引擎统计</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {multiEngineStats.by_engine.map((engine) => {
                          const config = engineConfig[engine.engine];
                          const EngineIcon = config?.Icon;
                          return (
                            <div 
                              key={engine.engine} 
                              className={`p-4 rounded-lg border ${config?.bgColor || 'bg-muted/50'}`}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  {EngineIcon && <EngineIcon className={`h-5 w-5 ${config?.color || ''}`} />}
                                  <span className={`text-sm font-semibold ${config?.color || ''}`}>
                                    {config?.name || engine.engine}
                                  </span>
                                </div>
                                <Badge variant="outline" className="text-xs">
                                  {engine.total_sessions} 会话
                                </Badge>
                              </div>
                              <p className="text-heading-4">{formatCurrency(engine.total_cost)}</p>
                              <p className="text-caption text-muted-foreground mt-1">
                                {formatTokens(engine.total_tokens)} tokens
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  )}

                  <Card className="p-6">
                    <h3 className="text-label mb-4">Token 统计</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-caption text-muted-foreground">输入 Tokens</p>
                        <p className="text-heading-4">{formatTokens(multiEngineStats?.total_input_tokens ?? stats.total_input_tokens)}</p>
                      </div>
                      <div>
                        <p className="text-caption text-muted-foreground">输出 Tokens</p>
                        <p className="text-heading-4">{formatTokens(multiEngineStats?.total_output_tokens ?? stats.total_output_tokens)}</p>
                      </div>
                      <div>
                        <p className="text-caption text-muted-foreground">Cache 写入</p>
                        <p className="text-heading-4">{formatTokens(stats.total_cache_creation_tokens)}</p>
                      </div>
                      <div>
                        <p className="text-caption text-muted-foreground">Cache 读取</p>
                        <p className="text-heading-4">{formatTokens(stats.total_cache_read_tokens)}</p>
                      </div>
                    </div>
                  </Card>

                  {/* Quick Stats */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Card className="p-6">
                      <h3 className="text-label mb-4">最常用模型</h3>
                      <div className="space-y-3">
                        {mostUsedModels}
                      </div>
                    </Card>

                    <Card className="p-6">
                      <h3 className="text-label mb-4">热门项目</h3>
                      <div className="space-y-3">
                        {topProjects}
                      </div>
                    </Card>
                  </div>
                </TabsContent>

                {/* Models Tab - Lazy render and cache */}
                <TabsContent value="models" className="space-y-6 mt-6">
                  {hasLoadedTabs.has("models") && (multiEngineStats || stats) && (
                    <div style={{ display: activeTab === "models" ? "block" : "none" }}>
                      <Card className="p-6">
                        <h3 className="text-sm font-semibold mb-4">按模型统计</h3>
                        <div className="space-y-4">
                          {/* Use multiEngineStats.by_model when available (includes engine info) */}
                          {multiEngineStats?.by_model ? (
                            multiEngineStats.by_model
                              .sort((a, b) => b.total_cost - a.total_cost)
                              .map((model) => {
                                const config = engineConfig[model.engine];
                                const EngineIcon = config?.Icon;
                                return (
                                  <div key={`${model.engine}-${model.model}`} className="space-y-2">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center space-x-3">
                                        {/* Engine Icon */}
                                        {EngineIcon && <EngineIcon className={`h-4 w-4 ${config?.color || ''}`} />}
                                        {/* Engine Badge */}
                                        <Badge 
                                          variant="outline" 
                                          className={`text-xs ${config?.color || ''}`}
                                        >
                                          {config?.name || model.engine}
                                        </Badge>
                                        {/* Model Badge */}
                                        <Badge 
                                          variant="secondary" 
                                          className="text-xs"
                                        >
                                          {getModelDisplayName(model.model)}
                                        </Badge>
                                        <span className="text-sm text-muted-foreground">
                                          {model.session_count} sessions
                                        </span>
                                      </div>
                                      <span className="text-sm font-semibold">
                                        {formatCurrency(model.total_cost)}
                                      </span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                      <div>
                                        <span className="text-muted-foreground">Input: </span>
                                        <span className="font-medium">{formatTokens(model.input_tokens)}</span>
                                      </div>
                                      <div>
                                        <span className="text-muted-foreground">Output: </span>
                                        <span className="font-medium">{formatTokens(model.output_tokens)}</span>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })
                          ) : (
                            /* Fallback to legacy stats.by_model */
                            stats?.by_model.map((model) => (
                              <div key={model.model} className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center space-x-3">
                                    <Badge 
                                      variant="outline" 
                                      className="text-xs"
                                    >
                                      {getModelDisplayName(model.model)}
                                    </Badge>
                                    <span className="text-sm text-muted-foreground">
                                      {model.session_count} sessions
                                    </span>
                                  </div>
                                  <span className="text-sm font-semibold">
                                    {formatCurrency(model.total_cost)}
                                  </span>
                                </div>
                                <div className="grid grid-cols-4 gap-2 text-xs">
                                  <div>
                                    <span className="text-muted-foreground">Input: </span>
                                    <span className="font-medium">{formatTokens(model.input_tokens)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Output: </span>
                                    <span className="font-medium">{formatTokens(model.output_tokens)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Cache W: </span>
                                    <span className="font-medium">{formatTokens(model.cache_creation_tokens)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Cache R: </span>
                                    <span className="font-medium">{formatTokens(model.cache_read_tokens)}</span>
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Projects Tab - Lazy render and cache */}
                <TabsContent value="projects" className="space-y-6 mt-6">
                  {hasLoadedTabs.has("projects") && stats && (
                    <div style={{ display: activeTab === "projects" ? "block" : "none" }}>
                      <Card className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold">按项目统计</h3>
                        <span className="text-xs text-muted-foreground">
                          {stats.by_project.length} total projects
                        </span>
                      </div>
                      <div className="space-y-3">
                        {(() => {
                          const startIndex = (projectsPage - 1) * ITEMS_PER_PAGE;
                          const endIndex = startIndex + ITEMS_PER_PAGE;
                          const paginatedProjects = stats.by_project.slice(startIndex, endIndex);
                          const totalPages = Math.ceil(stats.by_project.length / ITEMS_PER_PAGE);
                          
                          return (
                            <>
                              {paginatedProjects.map((project) => (
                                <div key={project.project_path} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                                  <div className="flex flex-col truncate">
                                    <span className="text-sm font-medium truncate" title={project.project_path}>
                                      {project.project_path}
                                    </span>
                                    <div className="flex items-center space-x-3 mt-1">
                                      <span className="text-caption text-muted-foreground">
                                        {project.session_count} sessions
                                      </span>
                                      <span className="text-caption text-muted-foreground">
                                        {formatTokens(project.total_tokens)} tokens
                                      </span>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-sm font-semibold">{formatCurrency(project.total_cost)}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {formatCurrency(project.total_cost / project.session_count)}/session
                                    </p>
                                  </div>
                                </div>
                              ))}
                              
                              {/* Pagination Controls */}
                              {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4">
                                  <span className="text-xs text-muted-foreground">
                                    Showing {startIndex + 1}-{Math.min(endIndex, stats.by_project.length)} of {stats.by_project.length}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setProjectsPage(prev => Math.max(1, prev - 1))}
                                      disabled={projectsPage === 1}
                                    >
                                      <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                    <span className="text-sm">
                                      Page {projectsPage} of {totalPages}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setProjectsPage(prev => Math.min(totalPages, prev + 1))}
                                      disabled={projectsPage === totalPages}
                                    >
                                      <ChevronRight className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          );
                          })()}
                        </div>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Sessions Tab - Lazy render and cache */}
                <TabsContent value="sessions" className="space-y-6 mt-6">
                  {hasLoadedTabs.has("sessions") && (
                    <div style={{ display: activeTab === "sessions" ? "block" : "none" }}>
                      <Card className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold">按会话统计</h3>
                        {sessionStats && sessionStats.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {sessionStats.length} total sessions
                          </span>
                        )}
                      </div>
                      <div className="space-y-3">
                        {sessionStatsLoading ? (
                          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            正在加载会话统计…
                          </div>
                        ) : sessionStats && sessionStats.length > 0 ? (() => {
                          const startIndex = (sessionsPage - 1) * ITEMS_PER_PAGE;
                          const endIndex = startIndex + ITEMS_PER_PAGE;
                          const paginatedSessions = sessionStats.slice(startIndex, endIndex);
                          const totalPages = Math.ceil(sessionStats.length / ITEMS_PER_PAGE);
                          
                          return (
                            <>
                              {paginatedSessions.map((session, index) => (
                                <div key={`${session.project_path}-${session.project_name}-${startIndex + index}`} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                                  <div className="flex flex-col">
                                    <div className="flex items-center space-x-2">
                                      <Briefcase className="h-4 w-4 text-muted-foreground" />
                                      <span className="text-xs font-mono text-muted-foreground truncate max-w-[200px]" title={session.project_path}>
                                        {session.project_path.split('/').slice(-2).join('/')}
                                      </span>
                                    </div>
                                    <span className="text-sm font-medium mt-1">
                                      {session.project_name}
                                    </span>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-sm font-semibold">{formatCurrency(session.total_cost)}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {session.last_used ? new Date(session.last_used).toLocaleDateString() : 'N/A'}
                                    </p>
                                  </div>
                                </div>
                              ))}
                              
                              {/* Pagination Controls */}
                              {totalPages > 1 && (
                                <div className="flex items-center justify-between pt-4">
                                  <span className="text-xs text-muted-foreground">
                                    Showing {startIndex + 1}-{Math.min(endIndex, sessionStats.length)} of {sessionStats.length}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setSessionsPage(prev => Math.max(1, prev - 1))}
                                      disabled={sessionsPage === 1}
                                    >
                                      <ChevronLeft className="h-4 w-4" />
                                    </Button>
                                    <span className="text-sm">
                                      Page {sessionsPage} of {totalPages}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setSessionsPage(prev => Math.min(totalPages, prev + 1))}
                                      disabled={sessionsPage === totalPages}
                                    >
                                      <ChevronRight className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          );
                        })() : (
                          <div className="text-center py-8 text-sm text-muted-foreground">
                            No session data available for the selected period
                          </div>
                          )}
                        </div>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Timeline Tab - Lazy render and cache */}
                <TabsContent value="timeline" className="space-y-6 mt-6">
                  {hasLoadedTabs.has("timeline") && (multiEngineStats || stats) && (
                    <div style={{ display: activeTab === "timeline" ? "block" : "none" }}>
                      <Card className="p-6">
                      <div className="flex items-center justify-between mb-6">
                        <h3 className="text-sm font-semibold flex items-center space-x-2">
                          <Calendar className="h-4 w-4" />
                          <span>每日使用量</span>
                        </h3>
                        {/* Legend for multi-engine view */}
                        {selectedEngine === 'all' && timelineChartData?.isMultiEngine && (
                          <div className="flex items-center space-x-4">
                            {Object.entries(engineConfig).map(([key, config]) => (
                              <div key={key} className="flex items-center space-x-1">
                                <div className={`w-3 h-3 rounded ${engineColors[key]}`} />
                                <span className="text-xs text-muted-foreground">{config.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      {timelineChartData ? (
                        <div className="relative pl-8 pr-4">
                          {/* Y-axis labels */}
                          <div className="absolute left-0 top-0 bottom-8 flex flex-col justify-between text-xs text-muted-foreground">
                            <span>{formatCurrency(timelineChartData.maxCost)}</span>
                            <span>{formatCurrency(timelineChartData.halfMaxCost)}</span>
                            <span>{formatCurrency(0)}</span>
                          </div>
                          
                          {/* Chart container */}
                          <div className="flex items-end space-x-2 h-64 border-l border-b border-border pl-4">
                            {timelineChartData.bars.map((day: any) => {
                              const dateObj = day.dateObj || day.date;
                              const formattedDate = dateObj.toLocaleDateString('en-US', {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric'
                              });
                              
                              return (
                                <div key={dateObj.toISOString()} className="flex-1 h-full flex flex-col items-center justify-end group relative">
                                  {/* Tooltip */}
                                  <div className="absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
                                    <div className="bg-background border border-border rounded-lg shadow-lg p-3 whitespace-nowrap">
                                      <p className="text-sm font-semibold">{formattedDate}</p>
                                      {timelineChartData.isMultiEngine && day.engines ? (
                                        <>
                                          <p className="text-sm text-muted-foreground mt-1">
                                            总计: {formatCurrency(day.total)}
                                          </p>
                                          {Object.entries(day.engines).map(([engine, cost]) => {
                                            const config = engineConfig[engine];
                                            return (
                                              <p key={engine} className={`text-xs ${config?.color || ''}`}>
                                                {config?.name || engine}: {formatCurrency(cost as number)}
                                              </p>
                                            );
                                          })}
                                        </>
                                      ) : (
                                        <>
                                          <p className="text-sm text-muted-foreground mt-1">
                                            成本: {formatCurrency(day.total_cost)}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {formatTokens(day.total_tokens)} tokens
                                          </p>
                                          {day.models_used && (
                                            <p className="text-xs text-muted-foreground">
                                              {day.models_used.length} model{day.models_used.length !== 1 ? 's' : ''}
                                            </p>
                                          )}
                                        </>
                                      )}
                                    </div>
                                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                                      <div className="border-4 border-transparent border-t-border"></div>
                                    </div>
                                  </div>
                                  
                                  {/* Bar - Stacked for multi-engine, single for single engine */}
                                  {timelineChartData.isMultiEngine && day.engines ? (
                                    <div 
                                      className="w-full flex flex-col-reverse rounded-t overflow-hidden cursor-pointer"
                                      style={{ height: `${day.heightPercent}%` }}
                                    >
                                      {Object.entries(day.engines).map(([engine, cost]) => {
                                        const enginePercent = day.total > 0 ? ((cost as number) / day.total) * 100 : 0;
                                        return (
                                          <div
                                            key={engine}
                                            className={`w-full ${engineColors[engine] || 'bg-primary'} hover:opacity-80 transition-opacity`}
                                            style={{ height: `${enginePercent}%` }}
                                          />
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div 
                                      className="w-full bg-primary hover:opacity-80 transition-opacity rounded-t cursor-pointer"
                                      style={{ height: `${day.heightPercent}%` }}
                                    />
                                  )}
                                  
                                  {/* X-axis label – absolutely positioned below the bar */}
                                  <div
                                    className="absolute left-1/2 top-full mt-2 -translate-x-1/2 text-xs text-muted-foreground whitespace-nowrap pointer-events-none"
                                  >
                                    {dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          
                          {/* X-axis label */}
                          <div className="mt-10 text-center text-xs text-muted-foreground">
                            每日使用趋势
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-8 text-sm text-muted-foreground">
                          No usage data available for the selected period
                        </div>
                        )}
                      </Card>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
