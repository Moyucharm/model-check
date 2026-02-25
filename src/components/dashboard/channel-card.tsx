// Channel card component with list/card model views.

"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Check,
  Loader2,
  PlayCircle,
  Square,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusIndicator } from "@/components/ui/status-indicator";
import { Heatmap } from "@/components/ui/heatmap";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";

export type ViewMode = "list" | "card";

interface CheckLog {
  id: string;
  status: "SUCCESS" | "FAIL";
  latency: number | null;
  statusCode: number | null;
  endpointType: string;
  responseContent: string | null;
  errorMsg: string | null;
  createdAt: string;
}

interface EndpointStatus {
  endpointType: string;
  status: "SUCCESS" | "FAIL";
  latency: number | null;
  statusCode: number | null;
  errorMsg: string | null;
  responseContent: string | null;
  checkedAt: string;
}

interface Model {
  id: string;
  modelName: string;
  healthStatus: "healthy" | "partial" | "unhealthy" | "unknown";
  lastStatus: boolean | null;
  lastLatency: number | null;
  lastCheckedAt: string | null;
  endpointStatuses: EndpointStatus[];
  checkLogs: CheckLog[];
}

interface ChannelCardProps {
  channel: {
    id: string;
    name: string;
    type?: string;
    models: Model[];
  };
  viewMode?: ViewMode;
  onRefresh?: () => void;
  onDelete?: (channelId: string) => void;
  className?: string;
  onEndpointFilterChange?: (endpoint: string | null) => void;
  activeEndpointFilter?: string | null;
  testingModelIds?: Set<string>;
  onTestModels?: (modelIds: string[]) => void;
  onStopModels?: (modelIds: string[]) => void;
}

const ENDPOINT_META: Record<
  string,
  {
    label: string;
    base: string;
  }
> = {
  CHAT: { label: "聊天", base: "blue" },
  CLAUDE: { label: "Claude CLI", base: "orange" },
  GEMINI: { label: "Gemini CLI", base: "cyan" },
  CODEX: { label: "Codex CLI", base: "violet" },
  IMAGE: { label: "图像", base: "pink" },
};

function endpointLabel(type: string): string {
  return ENDPOINT_META[type]?.label || type;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  return `${diffDays}天前`;
}

function modelStatus(model: Model): "healthy" | "partial" | "unhealthy" | "unknown" {
  return model.healthStatus;
}

function channelStatus(models: Model[]): "healthy" | "partial" | "unhealthy" | "unknown" {
  if (models.length === 0) return "unknown";

  const known = models.filter((m) => m.healthStatus !== "unknown");
  if (known.length === 0) return "unknown";

  const healthy = known.filter((m) => m.healthStatus === "healthy").length;
  const unhealthy = known.filter((m) => m.healthStatus === "unhealthy").length;

  if (healthy === known.length) return "healthy";
  if (unhealthy === known.length) return "unhealthy";
  return "partial";
}

function EndpointStatusBadge({ endpoint }: { endpoint: EndpointStatus }) {
  const label = endpointLabel(endpoint.endpointType);
  const success = endpoint.status === "SUCCESS";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border",
        success
          ? "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700"
          : "bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-700"
      )}
      title={`${label} | ${endpoint.status}${endpoint.statusCode ? ` | HTTP ${endpoint.statusCode}` : ""}${endpoint.errorMsg ? ` | ${endpoint.errorMsg}` : ""}`}
    >
      {label}
      <span>{success ? "正常" : endpoint.statusCode || "失败"}</span>
    </span>
  );
}

function ModelRow({
  channelName,
  model,
  isTesting,
  canTest,
  onTest,
  viewMode,
}: {
  channelName: string;
  model: Model;
  isTesting: boolean;
  canTest: boolean;
  onTest: () => void;
  viewMode: ViewMode;
}) {
  const [copied, setCopied] = useState(false);
  const [hoveringStop, setHoveringStop] = useState(false);

  const latestLog = model.checkLogs[0];
  const status = modelStatus(model);

  const handleCopy = async () => {
    const text = `${channelName}/${model.modelName}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const containerClass = viewMode === "list"
    ? "rounded-lg border border-border bg-card/70 p-3"
    : cn(
        "rounded-xl border-2 p-3 transition-colors",
        status === "healthy" && "border-emerald-400/80 bg-emerald-50/60 dark:bg-emerald-900/20",
        status === "partial" && "border-amber-400/80 bg-amber-50/60 dark:bg-amber-900/20",
        status === "unhealthy" && "border-rose-400/80 bg-rose-50/60 dark:bg-rose-900/20",
        status === "unknown" && "border-border bg-card"
      );

  return (
    <div className={containerClass}>
      <div className={cn("flex gap-3", viewMode === "list" ? "flex-col lg:flex-row lg:items-center" : "flex-col") }>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIndicator status={status} size="sm" pulse={status !== "unknown"} />
            <span className="font-mono text-sm truncate" title={model.modelName}>
              {model.modelName}
            </span>
            <button
              onClick={handleCopy}
              className="p-0.5 rounded hover:bg-accent transition-colors"
              title="复制渠道/模型"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {model.endpointStatuses.length > 0 ? (
              model.endpointStatuses.map((endpoint) => (
                <EndpointStatusBadge
                  key={endpoint.endpointType}
                  endpoint={endpoint}
                />
              ))
            ) : (
              <span className="text-xs text-muted-foreground">尚无端点检查</span>
            )}
          </div>
        </div>

        <div className={cn("flex items-center justify-between gap-3", viewMode === "list" ? "lg:w-[440px]" : "w-full") }>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-end gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Zap className="h-3 w-3" />
                {latestLog?.latency ?? model.lastLatency ?? "-"}ms
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatRelativeTime(latestLog?.createdAt ?? model.lastCheckedAt)}
              </span>
            </div>
            <Heatmap data={model.checkLogs} points={24} className="justify-end" />
          </div>

          {canTest && (
            <button
              onClick={onTest}
              onMouseEnter={() => setHoveringStop(true)}
              onMouseLeave={() => setHoveringStop(false)}
              className={cn(
                "rounded-md p-1.5 transition-colors",
                isTesting && hoveringStop ? "bg-rose-500/15" : "hover:bg-accent"
              )}
              title={isTesting ? "停止检测" : "运行检测"}
            >
              {isTesting ? (
                hoveringStop ? (
                  <Square className="h-4 w-4 text-rose-500" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                )
              ) : (
                <PlayCircle className="h-4 w-4 text-blue-500" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChannelCard({
  channel,
  viewMode = "list",
  className,
  onEndpointFilterChange,
  activeEndpointFilter,
  testingModelIds = new Set(),
  onTestModels,
  onStopModels,
}: ChannelCardProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [localEndpointFilter, setLocalEndpointFilter] = useState<string | null>(null);
  const [hoveringChannelStop, setHoveringChannelStop] = useState(false);

  const { isAuthenticated, token } = useAuth();
  const { toast, update } = useToast();

  const filterEndpoint = onEndpointFilterChange ? activeEndpointFilter : localEndpointFilter;

  const endpointCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const model of channel.models) {
      for (const endpoint of model.endpointStatuses) {
        counts[endpoint.endpointType] = (counts[endpoint.endpointType] || 0) + 1;
      }
    }
    return counts;
  }, [channel.models]);

  const displayedModels = useMemo(() => {
    if (!filterEndpoint) return channel.models;
    return channel.models.filter((model) =>
      model.endpointStatuses.some((endpoint) => endpoint.endpointType === filterEndpoint)
    );
  }, [channel.models, filterEndpoint]);

  const currentChannelStatus = channelStatus(channel.models);
  const isChannelTesting = displayedModels.some((model) => testingModelIds.has(model.id));

  const handleEndpointClick = (endpoint: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = filterEndpoint === endpoint ? null : endpoint;
    if (onEndpointFilterChange) {
      onEndpointFilterChange(next);
    } else {
      setLocalEndpointFilter(next);
    }
  };

  const handleChannelAction = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAuthenticated) return;

    const modelIds = displayedModels.map((m) => m.id);

    if (isChannelTesting) {
      onStopModels?.(modelIds);
      const toastId = toast("正在停止渠道检测...", "loading");

      try {
        const response = await fetch("/api/detect", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          update(toastId, `已停止 ${channel.name} 的检测`, "success");
        } else {
          update(toastId, "停止请求失败", "error");
        }
      } catch {
        update(toastId, "网络错误", "error");
      }

      return;
    }

    onTestModels?.(modelIds);
    const toastId = toast(`正在为 ${modelIds.length} 个模型启动检测...`, "loading");

    try {
      const response = await fetch("/api/detect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ channelId: channel.id, modelIds }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "启动检测失败");
      }

      update(toastId, `已为 ${channel.name} 启动检测`, "success");
    } catch {
      update(toastId, `无法为 ${channel.name} 启动检测`, "error");
    }
  };

  const handleModelAction = async (modelId: string, modelName: string) => {
    if (!isAuthenticated) return;

    if (testingModelIds.has(modelId)) {
      onStopModels?.([modelId]);
      const toastId = toast(`正在停止 ${modelName}...`, "loading");

      try {
        const response = await fetch("/api/detect", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          update(toastId, `已停止 ${modelName}`, "success");
        } else {
          update(toastId, "停止请求失败", "error");
        }
      } catch {
        update(toastId, "网络错误", "error");
      }

      return;
    }

    onTestModels?.([modelId]);
    const toastId = toast(`正在测试 ${modelName}...`, "loading");

    try {
      const response = await fetch("/api/detect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ modelId }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "启动模型检测失败");
      }

      update(toastId, `已为 ${modelName} 启动检测`, "success");
    } catch {
      update(toastId, `无法测试 ${modelName}`, "error");
    }
  };

  return (
    <div className={cn("rounded-xl border border-border bg-card overflow-hidden", className)}>
      <div className="flex items-stretch min-w-0 border-b border-border/70">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setIsExpanded((v) => !v)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setIsExpanded((v) => !v); } }}
          className="flex-1 p-4 flex items-center justify-between gap-2 hover:bg-accent/40 transition-colors cursor-pointer"
        >
          <div className="min-w-0 flex items-center gap-3">
            <StatusIndicator status={currentChannelStatus} size="lg" pulse={currentChannelStatus !== "unknown"} />
            <div className="min-w-0 text-left">
              <h3 className="font-medium truncate">{channel.name}</h3>
              <p className="text-sm text-muted-foreground">
                {channel.models.length} 个模型
              </p>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2">
            {Object.entries(endpointCounts).map(([endpoint, count]) => (
              <button
                key={endpoint}
                onClick={(event) => handleEndpointClick(endpoint, event)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                  filterEndpoint === endpoint
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-foreground border-border hover:bg-accent"
                )}
              >
                {endpointLabel(endpoint)}: {count}
              </button>
            ))}
          </div>

          {isExpanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground" />
          )}
        </div>

        {isAuthenticated && (
          <button
            onClick={handleChannelAction}
            onMouseEnter={() => setHoveringChannelStop(true)}
            onMouseLeave={() => setHoveringChannelStop(false)}
            className={cn(
              "border-l border-border px-4 transition-colors",
              isChannelTesting && hoveringChannelStop ? "bg-rose-500/15" : "hover:bg-accent/40"
            )}
            title={isChannelTesting ? "停止渠道检测" : "测试筛选的模型"}
          >
            {isChannelTesting ? (
              hoveringChannelStop ? (
                <Square className="h-5 w-5 text-rose-500" />
              ) : (
                <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
              )
            ) : (
              <PlayCircle className="h-5 w-5 text-blue-500" />
            )}
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="p-3">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>显示 {displayedModels.length} 个</span>
            {filterEndpoint && (
              <button
                onClick={() => {
                  if (onEndpointFilterChange) onEndpointFilterChange(null);
                  else setLocalEndpointFilter(null);
                }}
                className="text-primary hover:underline"
              >
                清除端点筛选 ({endpointLabel(filterEndpoint)})
              </button>
            )}
          </div>

          <div className={cn(viewMode === "card" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2")}>
            {displayedModels.map((model) => (
              <ModelRow
                key={model.id}
                channelName={channel.name}
                model={model}
                isTesting={testingModelIds.has(model.id)}
                canTest={isAuthenticated}
                onTest={() => handleModelAction(model.id, model.modelName)}
                viewMode={viewMode}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
