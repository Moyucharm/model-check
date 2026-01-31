// Admin control panel for triggering detection

"use client";

import { useState } from "react";
import { Play, Loader2, Wifi, WifiOff } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { cn } from "@/lib/utils";

interface AdminPanelProps {
  isConnected: boolean;
  className?: string;
}

export function AdminPanel({ isConnected, className }: AdminPanelProps) {
  const { isAuthenticated, token } = useAuth();
  const [isDetecting, setIsDetecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  if (!isAuthenticated) {
    return null;
  }

  const handleTriggerDetection = async () => {
    setIsDetecting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/detect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      if (response.ok) {
        setMessage({
          type: "success",
          text: data.message || "检测已启动",
        });
      } else {
        setMessage({
          type: "error",
          text: data.error || "启动检测失败",
        });
      }
    } catch {
      setMessage({
        type: "error",
        text: "网络错误",
      });
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 p-4 rounded-lg border border-border bg-card",
        className
      )}
    >
      {/* Connection status */}
      <div className="flex items-center gap-2 text-sm">
        {isConnected ? (
          <>
            <Wifi className="h-4 w-4 text-green-500" />
            <span className="text-muted-foreground">实时连接</span>
          </>
        ) : (
          <>
            <WifiOff className="h-4 w-4 text-red-500" />
            <span className="text-muted-foreground">连接断开</span>
          </>
        )}
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Actions */}
      <button
        onClick={handleTriggerDetection}
        disabled={isDetecting}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isDetecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {isDetecting ? "启动中..." : "开始检测"}
      </button>

      {/* Status message */}
      {message && (
        <span
          className={cn(
            "text-sm",
            message.type === "success" ? "text-green-500" : "text-red-500"
          )}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
