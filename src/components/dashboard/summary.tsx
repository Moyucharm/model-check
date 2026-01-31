// Summary stats component

"use client";

import { Activity, Server, CheckCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface SummaryProps {
  data: {
    totalChannels: number;
    totalModels: number;
    healthyModels: number;
    healthRate: number;
  };
  className?: string;
}

export function Summary({ data, className }: SummaryProps) {
  const stats = [
    {
      label: "渠道",
      value: data.totalChannels,
      icon: Server,
      color: "text-blue-500",
    },
    {
      label: "模型",
      value: data.totalModels,
      icon: Activity,
      color: "text-purple-500",
    },
    {
      label: "健康",
      value: data.healthyModels,
      icon: CheckCircle,
      color: "text-green-500",
    },
    {
      label: "健康率",
      value: `${data.healthRate}%`,
      icon: AlertCircle,
      color: data.healthRate >= 80 ? "text-green-500" : data.healthRate >= 50 ? "text-yellow-500" : "text-red-500",
    },
  ];

  return (
    <div className={cn("grid grid-cols-2 sm:grid-cols-4 gap-4", className)}>
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
