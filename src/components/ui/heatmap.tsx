// GitHub-style heatmap component for model availability history

"use client";

import { cn } from "@/lib/utils";

interface HeatmapProps {
  data: {
    status: "SUCCESS" | "FAIL";
    createdAt: string;
  }[];
  className?: string;
}

export function Heatmap({ data, className }: HeatmapProps) {
  // Take last 7 entries and reverse to show oldest first
  const entries = data.slice(0, 7).reverse();

  // Pad to 7 entries if needed
  while (entries.length < 7) {
    entries.unshift({ status: "FAIL", createdAt: "" } as { status: "SUCCESS" | "FAIL"; createdAt: string });
  }

  return (
    <div className={cn("flex gap-0.5", className)}>
      {entries.map((entry, index) => {
        const isSuccess = entry.status === "SUCCESS";
        const hasData = entry.createdAt !== "";

        return (
          <div
            key={index}
            className={cn(
              "w-3 h-3 rounded-sm transition-colors",
              hasData
                ? isSuccess
                  ? "bg-green-500"
                  : "bg-red-500"
                : "bg-muted"
            )}
            title={
              hasData
                ? `${isSuccess ? "成功" : "失败"} - ${new Date(entry.createdAt).toLocaleString()}`
                : "无数据"
            }
          />
        );
      })}
    </div>
  );
}
