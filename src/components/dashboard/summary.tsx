// Summary stats component

"use client";

import { Activity, Server, CheckCircle, AlertTriangle, Percent } from "lucide-react";
import { cn } from "@/lib/utils";

interface SummaryProps {
  data: {
    totalChannels: number;
    totalModels: number;
    healthyModels: number;
    partialModels?: number;
    healthRate: number;
  };
  className?: string;
}

export function Summary({ data, className }: SummaryProps) {
  const stats = [
    {
      label: "渠道总数",
      value: data.totalChannels,
      icon: Server,
      color: "text-blue-500",
    },
    {
      label: "模型总数",
      value: data.totalModels,
      icon: Activity,
      color: "text-violet-500",
    },
    {
      label: "健康",
      value: data.healthyModels,
      icon: CheckCircle,
      color: "text-emerald-500",
    },
    {
      label: "部分故障",
      value: data.partialModels ?? 0,
      icon: AlertTriangle,
      color: "text-amber-500",
    },
    {
      label: "健康率",
      value: `${data.healthRate}%`,
      icon: Percent,
      color: data.healthRate >= 80 ? "text-emerald-500" : data.healthRate >= 50 ? "text-amber-500" : "text-rose-500",
    },
  ];

  return (
    <div className={cn("grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4", className)}>
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="p-4 rounded-lg border border-border bg-card"
        >
          <div className="flex items-center gap-2 mb-2">
            <stat.icon className={cn("h-5 w-5", stat.color)} />
            <span className="text-sm text-muted-foreground">{stat.label}</span>
          </div>
          <p className="text-2xl font-semibold">{stat.value}</p>
        </div>
      ))}
    </div>
  );
}
