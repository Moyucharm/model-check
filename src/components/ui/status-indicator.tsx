// Status indicator component

"use client";

import { cn } from "@/lib/utils";

type Status = "healthy" | "partial" | "unhealthy" | "unknown";

interface StatusIndicatorProps {
  status: Status;
  size?: "sm" | "md" | "lg";
  pulse?: boolean;
  className?: string;
}

const statusLabels: Record<Status, string> = {
  healthy: "健康",
  partial: "部分可用",
  unhealthy: "不可用",
  unknown: "未知",
};

export function StatusIndicator({
  status,
  size = "md",
  pulse = false,
  className,
}: StatusIndicatorProps) {
  const sizeClasses = {
    sm: "w-2 h-2",
    md: "w-3 h-3",
    lg: "w-4 h-4",
  };

  const statusColors = {
    healthy: "bg-green-500",
    partial: "bg-yellow-500",
    unhealthy: "bg-red-500",
    unknown: "bg-gray-400",
  };

  return (
    <span
      className={cn("relative inline-flex", className)}
      role="status"
      aria-label={`状态: ${statusLabels[status]}`}
    >
      <span
        className={cn(
          "rounded-full",
          sizeClasses[size],
          statusColors[status]
        )}
        aria-hidden="true"
      />
      {pulse && status !== "unknown" && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping",
            statusColors[status]
          )}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

export function getChannelStatus(
  models: { lastStatus: boolean | null }[]
): Status {
  if (models.length === 0) return "unknown";

  const healthyCount = models.filter((m) => m.lastStatus === true).length;
  const checkedCount = models.filter((m) => m.lastStatus !== null).length;

  if (checkedCount === 0) return "unknown";
  if (healthyCount === checkedCount) return "healthy";
  if (healthyCount === 0) return "unhealthy";
  return "partial";
}
