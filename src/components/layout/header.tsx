// Header component with theme toggle, scheduler info, filters and auth actions.

"use client";

import { useState, useEffect, useRef } from "react";
import {
  Sun,
  Moon,
  LogIn,
  LogOut,
  Activity,
  Play,
  Square,
  Loader2,
  Wifi,
  WifiOff,
  Clock,
  Zap,
  Search,
  Filter,
  X,
  Github,
  Settings,
  ArrowUpCircle,
  List,
  LayoutGrid,
} from "lucide-react";
import { useTheme } from "@/components/providers/theme-provider";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { SchedulerModal } from "@/components/dashboard/scheduler-modal";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/components/dashboard/channel-card";

export type EndpointFilter = "all" | "CHAT" | "CLAUDE" | "GEMINI" | "CODEX" | "IMAGE";
export type StatusFilter = "all" | "healthy" | "partial" | "unhealthy" | "unknown";

interface SchedulerStatus {
  detection: {
    enabled: boolean;
    running: boolean;
    schedule: string;
    nextRun: string | null;
  };
  config: {
    channelConcurrency: number;
    maxGlobalConcurrency: number;
    minDelayMs: number;
    maxDelayMs: number;
  };
  cleanup: {
    running: boolean;
    schedule: string;
    nextRun: string | null;
    retentionDays: number;
  };
}

interface HeaderProps {
  onLoginClick: () => void;
  isConnected?: boolean;
  isDetectionRunning?: boolean;
  search?: string;
  onSearchChange?: (value: string) => void;
  endpointFilter?: EndpointFilter;
  onEndpointFilterChange?: (value: EndpointFilter) => void;
  statusFilter?: StatusFilter;
  onStatusFilterChange?: (value: StatusFilter) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (value: ViewMode) => void;
  onDetectionStart?: () => void;
  onDetectionStop?: () => void;
}

export function Header({
  onLoginClick,
  isConnected = false,
  isDetectionRunning = false,
  search = "",
  onSearchChange,
  endpointFilter = "all",
  onEndpointFilterChange,
  statusFilter = "all",
  onStatusFilterChange,
  viewMode = "list",
  onViewModeChange,
  onDetectionStart,
  onDetectionStop,
}: HeaderProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const { isAuthenticated, token, logout } = useAuth();
  const { toast, update } = useToast();

  const [isDetecting, setIsDetecting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isHoveringStop, setIsHoveringStop] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [countdown, setCountdown] = useState<string>("-");
  const [showSchedulerModal, setShowSchedulerModal] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);

  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setShowFilters(false);
      }
    };

    if (showFilters) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showFilters]);

  const fetchSchedulerStatus = async () => {
    try {
      const response = await fetch("/api/scheduler");
      if (response.ok) {
        const data = await response.json();
        setSchedulerStatus(data);
      }
    } catch {
      // Ignore scheduler fetch errors.
    }
  };

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (!mounted) return;
      await fetchSchedulerStatus();
    };

    run();
    const interval = setInterval(run, 60000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      setHasUpdate(false);
      setLatestVersion(null);
      return;
    }

    const checkVersion = async () => {
      try {
        const res = await fetch("/api/version", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setHasUpdate(data.hasUpdate ?? false);
          setLatestVersion(data.latest ?? null);
        }
      } catch {
        // Ignore version check failures.
      }
    };

    checkVersion();
  }, [isAuthenticated, token]);

  useEffect(() => {
    if (!schedulerStatus?.detection.enabled || !schedulerStatus.detection.nextRun) {
      setCountdown("-");
      return;
    }

    const updateCountdown = () => {
      const nextRun = new Date(schedulerStatus.detection.nextRun as string);
      const now = new Date();
      const diffMs = nextRun.getTime() - now.getTime();

      if (diffMs <= 0) {
        setCountdown("running...");
        return;
      }

      const diffSecs = Math.floor(diffMs / 1000);
      const hours = Math.floor(diffSecs / 3600);
      const mins = Math.floor((diffSecs % 3600) / 60);
      const secs = diffSecs % 60;

      if (hours > 0) {
        setCountdown(`${hours}h ${mins}m ${secs}s`);
      } else if (mins > 0) {
        setCountdown(`${mins}m ${secs}s`);
      } else {
        setCountdown(`${secs}s`);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [schedulerStatus?.detection.enabled, schedulerStatus?.detection.nextRun]);

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const handleTriggerDetection = async () => {
    if (isDetecting || !token) return;

    setIsDetecting(true);
    onDetectionStart?.();
    const toastId = toast("Starting full detection...", "loading");

    try {
      const response = await fetch("/api/detect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        update(toastId, data.message || "Detection started", "success");
      } else {
        update(toastId, data.error || "Failed to start detection", "error");
        onDetectionStop?.();
      }
    } catch {
      update(toastId, "Network error", "error");
      onDetectionStop?.();
    } finally {
      setIsDetecting(false);
    }
  };

  const handleStopDetection = async () => {
    if (isStopping || !token) return;

    setIsStopping(true);
    const toastId = toast("Stopping detection...", "loading");

    try {
      const response = await fetch("/api/detect", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        update(toastId, data.message || "Detection stopped", "success");
        onDetectionStop?.();
      } else {
        update(toastId, data.error || "Failed to stop detection", "error");
      }
    } catch {
      update(toastId, "Network error", "error");
    } finally {
      setIsStopping(false);
    }
  };

  const hasActiveFilters = Boolean(search) || endpointFilter !== "all" || statusFilter !== "all";
  const activeFilterCount = [search, endpointFilter !== "all", statusFilter !== "all"].filter(Boolean).length;

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 items-center justify-between px-2 sm:px-4 gap-2">
          <div className="flex items-center gap-2 shrink-0">
            <Activity className="h-5 w-5 text-primary" />
            <span className="font-semibold hidden sm:inline">Model Check</span>
            {isAuthenticated && hasUpdate && latestVersion ? (
              <a
                href="https://github.com/Moyucharm/model-check"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/25 hover:bg-blue-500/25 transition-colors hidden sm:flex"
                title={`Current v${process.env.APP_VERSION}, latest v${latestVersion}`}
              >
                <ArrowUpCircle className="h-3 w-3" />
                v{latestVersion}
              </a>
            ) : (
              <a
                href="https://github.com/Moyucharm/model-check"
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors hidden sm:block"
                title="GitHub"
              >
                <Github className="h-4 w-4" />
              </a>
            )}
          </div>

          <button
            type="button"
            onClick={() => isAuthenticated && setShowSchedulerModal(true)}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 text-xs transition-colors",
              schedulerStatus?.detection.enabled === false
                ? "border-rose-500/30 bg-rose-500/10"
                : "border-border bg-muted/50",
              isAuthenticated && "hover:bg-accent hover:border-primary/50 cursor-pointer"
            )}
            title={isAuthenticated ? "Open scheduler settings" : "Scheduler status"}
          >
            <span className="inline-flex items-center gap-1 py-1.5">
              <Clock className={cn("h-3.5 w-3.5", schedulerStatus?.detection.enabled === false ? "text-rose-500" : "text-blue-500")} />
              <span className="font-medium text-foreground text-xs">{schedulerStatus ? (schedulerStatus.detection.enabled ? countdown : "disabled") : "-"}</span>
            </span>
            <span className="hidden sm:inline-flex items-center gap-1 py-1.5" title="Global concurrency">
              <Zap className="h-3.5 w-3.5 text-yellow-500" />
              <span className="font-medium text-foreground text-xs">{schedulerStatus?.config.maxGlobalConcurrency ?? "-"}</span>
            </span>
            {isAuthenticated && (
              <span className="pr-1">
                <Settings className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            )}
          </button>

          <div className="flex items-center gap-1 shrink-0">
            {onSearchChange && (
              <div className="relative" ref={filterRef}>
                <button
                  onClick={() => setShowFilters((v) => !v)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
                    hasActiveFilters
                      ? "bg-blue-500 text-white hover:bg-blue-600"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                  title="Filters"
                >
                  <Filter className="h-4 w-4" />
                  <span className="hidden sm:inline">Filter</span>
                  {activeFilterCount > 0 && (
                    <span className="ml-0.5 px-1 py-0.5 text-xs rounded-full bg-white/20">
                      {activeFilterCount}
                    </span>
                  )}
                </button>

                {showFilters && (
                  <div className="absolute right-0 top-full mt-2 w-72 p-4 rounded-lg border border-border bg-card shadow-lg z-50">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium">Filters</span>
                      <button onClick={() => setShowFilters(false)} className="p-1 rounded hover:bg-accent">
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Search model</label>
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <input
                            type="text"
                            value={search}
                            onChange={(e) => onSearchChange(e.target.value)}
                            placeholder="Type model name..."
                            className="w-full pl-8 pr-3 py-2 rounded-md border border-input bg-background text-sm"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Endpoint</label>
                        <select
                          value={endpointFilter}
                          onChange={(e) => onEndpointFilterChange?.(e.target.value as EndpointFilter)}
                          className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                        >
                          <option value="all">All</option>
                          <option value="CHAT">Chat</option>
                          <option value="CLAUDE">Claude CLI</option>
                          <option value="GEMINI">Gemini CLI</option>
                          <option value="CODEX">Codex CLI</option>
                          <option value="IMAGE">Image</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Status</label>
                        <select
                          value={statusFilter}
                          onChange={(e) => onStatusFilterChange?.(e.target.value as StatusFilter)}
                          className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                        >
                          <option value="all">All</option>
                          <option value="healthy">Healthy</option>
                          <option value="partial">Partial</option>
                          <option value="unhealthy">Unhealthy</option>
                          <option value="unknown">Unknown</option>
                        </select>
                      </div>

                      {hasActiveFilters && (
                        <button
                          onClick={() => {
                            onSearchChange("");
                            onEndpointFilterChange?.("all");
                            onStatusFilterChange?.("all");
                          }}
                          className="w-full py-2 text-sm text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-md transition-colors"
                        >
                          Clear all filters
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5" title="View mode">
              <button
                onClick={() => onViewModeChange?.("list")}
                className={cn(
                  "rounded px-1.5 py-1 text-xs transition-colors",
                  viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                )}
                title="List view"
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => onViewModeChange?.("card")}
                className={cn(
                  "rounded px-1.5 py-1 text-xs transition-colors",
                  viewMode === "card" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                )}
                title="Card view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center px-1 py-1 rounded-md text-sm" title={isConnected ? "SSE connected" : "SSE disconnected"}>
              {isConnected ? (
                <Wifi className="h-4 w-4 text-emerald-500" />
              ) : (
                <WifiOff className="h-4 w-4 text-rose-500" />
              )}
            </div>

            {isAuthenticated && (
              isDetectionRunning ? (
                <button
                  onClick={handleStopDetection}
                  onMouseEnter={() => setIsHoveringStop(true)}
                  onMouseLeave={() => setIsHoveringStop(false)}
                  disabled={isStopping}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                    isHoveringStop || isStopping
                      ? "bg-rose-500 text-white hover:bg-rose-600"
                      : "bg-blue-500 text-white"
                  )}
                  title={isHoveringStop ? "Stop detection" : "Detection running"}
                >
                  {isStopping ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isHoveringStop ? (
                    <Square className="h-4 w-4" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  <span className="hidden sm:inline">
                    {isStopping ? "Stopping" : isHoveringStop ? "Stop" : "Running"}
                  </span>
                </button>
              ) : (
                <button
                  onClick={handleTriggerDetection}
                  disabled={isDetecting}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Start full detection"
                >
                  {isDetecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  <span className="hidden sm:inline">{isDetecting ? "Starting" : "Detect"}</span>
                </button>
              )
            )}

            <button
              onClick={toggleTheme}
              className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              title={resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>

            {isAuthenticated ? (
              <button
                onClick={logout}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Logout</span>
              </button>
            ) : (
              <button
                onClick={onLoginClick}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <LogIn className="h-4 w-4" />
                <span className="hidden sm:inline">Login</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <SchedulerModal
        isOpen={showSchedulerModal}
        onClose={() => setShowSchedulerModal(false)}
        onSave={fetchSchedulerStatus}
      />
    </>
  );
}
