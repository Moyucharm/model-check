// Main page component

"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Header, EndpointFilter, StatusFilter } from "@/components/layout/header";
import { LoginModal } from "@/components/ui/login-modal";
import { Dashboard } from "@/components/dashboard";
import { useSSE } from "@/hooks/use-sse";
import type { ViewMode } from "@/components/dashboard/channel-card";

const TESTING_STATUS_POLL_INTERVAL = 5000;
const REFRESH_DEBOUNCE_DELAY = 500;
const VIEW_MODE_STORAGE_KEY = "model-check:view-mode";

export default function Home() {
  const [showLogin, setShowLogin] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [search, setSearch] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<EndpointFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(new Set());
  const [isDetectionRunning, setIsDetectionRunning] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const refreshDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const sseConnectedRef = useRef(false);
  const ignoreProgressFetchRef = useRef(false);
  const ignoreSSERef = useRef(false);
  const clearIgnoreFlagsTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === "list" || stored === "card") {
      setViewMode(stored);
    }
  }, []);

  const handleViewModeChange = useCallback((nextMode: ViewMode) => {
    setViewMode(nextMode);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, nextMode);
  }, []);

  const addTestingModels = useCallback((modelIds: string[]) => {
    setTestingModelIds((prev) => {
      const next = new Set(prev);
      modelIds.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const removeTestingModel = useCallback((modelId: string) => {
    setTestingModelIds((prev) => {
      const next = new Set(prev);
      next.delete(modelId);
      return next;
    });
  }, []);

  const debouncedRefresh = useCallback(() => {
    if (refreshDebounceRef.current) {
      clearTimeout(refreshDebounceRef.current);
    }

    refreshDebounceRef.current = setTimeout(() => {
      setRefreshKey((k) => k + 1);
      refreshDebounceRef.current = null;
    }, REFRESH_DEBOUNCE_DELAY);
  }, []);

  const { isConnected } = useSSE({
    onProgress: (event) => {
      if (ignoreSSERef.current) {
        return;
      }

      if (event.type === "progress" && event.modelId && event.isModelComplete) {
        removeTestingModel(event.modelId);
      }

      debouncedRefresh();
    },
  });

  useEffect(() => {
    sseConnectedRef.current = isConnected;
  }, [isConnected]);

  const fetchProgress = useCallback(async () => {
    if (ignoreProgressFetchRef.current) {
      return;
    }

    try {
      const response = await fetch("/api/detect");
      if (response.ok) {
        const data = await response.json();

        if (data.testingModelIds && Array.isArray(data.testingModelIds)) {
          if (sseConnectedRef.current) {
            setTestingModelIds((prev) => {
              const next = new Set(prev);
              data.testingModelIds.forEach((id: string) => next.add(id));
              return next;
            });
          } else {
            setTestingModelIds(new Set(data.testingModelIds));
          }

          setIsDetectionRunning(data.testingModelIds.length > 0);
        } else {
          setIsDetectionRunning(false);
        }
      }
    } catch {
      // Ignore progress fetch failures.
    }
  }, []);

  useEffect(() => {
    if (isDetectionRunning && testingModelIds.size === 0) {
      void Promise.resolve().then(fetchProgress);
    }
  }, [testingModelIds.size, isDetectionRunning, fetchProgress]);

  const removeTestingModels = useCallback((modelIds: string[]) => {
    setTestingModelIds((prev) => {
      const next = new Set(prev);
      modelIds.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  useEffect(() => {
    void Promise.resolve().then(fetchProgress);
  }, [fetchProgress]);

  useEffect(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if ((isDetectionRunning || testingModelIds.size > 0) && !isConnected) {
      pollIntervalRef.current = setInterval(fetchProgress, TESTING_STATUS_POLL_INTERVAL);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [isDetectionRunning, testingModelIds.size, isConnected, fetchProgress]);

  useEffect(() => {
    return () => {
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
      }
    };
  }, []);

  const handleDetectionStart = useCallback(async () => {
    if (clearIgnoreFlagsTimerRef.current) {
      clearTimeout(clearIgnoreFlagsTimerRef.current);
      clearIgnoreFlagsTimerRef.current = null;
    }

    ignoreProgressFetchRef.current = false;
    ignoreSSERef.current = false;

    setIsDetectionRunning(true);
    setTestingModelIds(new Set());
    setRefreshKey((k) => k + 1);

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchProgress();
    } catch {
      // Ignore post-start refresh errors.
    }
  }, [fetchProgress]);

  const handleDetectionStop = useCallback(() => {
    setIsDetectionRunning(false);
    setTestingModelIds(new Set());

    ignoreProgressFetchRef.current = true;
    ignoreSSERef.current = true;

    if (clearIgnoreFlagsTimerRef.current) {
      clearTimeout(clearIgnoreFlagsTimerRef.current);
    }

    clearIgnoreFlagsTimerRef.current = setTimeout(() => {
      ignoreProgressFetchRef.current = false;
      ignoreSSERef.current = false;
      clearIgnoreFlagsTimerRef.current = null;
    }, 3000);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        onLoginClick={() => setShowLogin(true)}
        isConnected={isConnected}
        isDetectionRunning={isDetectionRunning}
        search={search}
        onSearchChange={setSearch}
        endpointFilter={endpointFilter}
        onEndpointFilterChange={setEndpointFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onDetectionStart={handleDetectionStart}
        onDetectionStop={handleDetectionStop}
      />

      <main className="flex-1 container mx-auto px-4 py-6">
        <Dashboard
          refreshKey={refreshKey}
          viewMode={viewMode}
          search={search}
          endpointFilter={endpointFilter}
          statusFilter={statusFilter}
          testingModelIds={testingModelIds}
          onTestModels={addTestingModels}
          onStopModels={removeTestingModels}
        />
      </main>

      <footer className="border-t border-border py-4">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          <a
            href="https://github.com/Moyucharm/model-check"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            model-check
          </a>
          {" - API 渠道可用性监控"}
          <span className="ml-2 text-xs text-muted-foreground/60">v{process.env.APP_VERSION}</span>
        </div>
      </footer>

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
