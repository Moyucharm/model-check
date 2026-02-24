// Availability history dots (24 points by default).

"use client";

import { cn } from "@/lib/utils";

interface HeatmapEntry {
  status: "SUCCESS" | "FAIL";
  createdAt: string;
  endpointType?: string;
  statusCode?: number | null;
  errorMsg?: string | null;
  responseContent?: string | null;
}

interface HeatmapProps {
  data: HeatmapEntry[];
  className?: string;
  points?: number;
}

function formatEndpointLabel(endpointType?: string): string {
  switch (endpointType) {
    case "CHAT":
      return "Chat";
    case "CLAUDE":
      return "Claude CLI";
    case "GEMINI":
      return "Gemini CLI";
    case "CODEX":
      return "Codex CLI";
    case "IMAGE":
      return "Image";
    default:
      return endpointType || "Unknown";
  }
}

function summarizeMessage(entry: HeatmapEntry): string {
  const source = entry.errorMsg || entry.responseContent || "";
  if (!source) return "";

  const compact = source.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

export function Heatmap({ data, className, points = 24 }: HeatmapProps) {
  const entries = data.slice(0, points).reverse();

  while (entries.length < points) {
    entries.unshift({
      status: "FAIL",
      createdAt: "",
    } as HeatmapEntry);
  }

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {entries.map((entry, index) => {
        const hasData = entry.createdAt !== "";
        const isSuccess = entry.status === "SUCCESS";
        const endpointLabel = formatEndpointLabel(entry.endpointType);
        const statusCodeLabel = entry.statusCode ? ` HTTP ${entry.statusCode}` : "";
        const detail = summarizeMessage(entry);

        const title = hasData
          ? `${new Date(entry.createdAt).toLocaleString()} | ${endpointLabel} | ${entry.status}${statusCodeLabel}${detail ? ` | ${detail}` : ""}`
          : "No data";

        return (
          <div
            key={`${entry.createdAt || "empty"}-${index}`}
            className={cn(
              "h-3 w-3 rounded-full transition-colors",
              hasData
                ? isSuccess
                  ? "bg-emerald-500"
                  : "bg-rose-500"
                : "bg-muted"
            )}
            title={title}
          />
        );
      })}
    </div>
  );
}
