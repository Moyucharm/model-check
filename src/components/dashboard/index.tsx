// Main dashboard component

"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Summary } from "@/components/dashboard/summary";
import { ChannelCard, type ViewMode } from "@/components/dashboard/channel-card";
import { ChannelManager } from "@/components/dashboard/channel-manager";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

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

interface Channel {
  id: string;
  name: string;
  type?: string;
  models: Model[];
}

interface Pagination {
  page: number;
  pageSize: number;
  totalPages: number;
  totalChannels: number;
}

interface DashboardData {
  authenticated: boolean;
  summary: {
    totalChannels: number;
    totalModels: number;
    healthyModels: number;
    partialModels?: number;
    healthRate: number;
  };
  pagination: Pagination;
  channels: Channel[];
}

export type EndpointFilter = "all" | "CHAT" | "CLAUDE" | "GEMINI" | "CODEX" | "IMAGE";
export type StatusFilter = "all" | "healthy" | "partial" | "unhealthy" | "unknown";

interface DashboardProps {
  refreshKey?: number;
  viewMode?: ViewMode;
  search?: string;
  endpointFilter?: EndpointFilter;
  statusFilter?: StatusFilter;
  testingModelIds?: Set<string>;
  onTestModels?: (modelIds: string[]) => void;
  onStopModels?: (modelIds: string[]) => void;
}

const PAGE_SIZE = 10;

function modelSortWeight(status: Model["healthStatus"]): number {
  switch (status) {
    case "healthy":
      return 0;
    case "partial":
      return 1;
    case "unhealthy":
      return 2;
    case "unknown":
    default:
      return 3;
  }
}

export function Dashboard({
  refreshKey = 0,
  viewMode = "list",
  search = "",
  endpointFilter = "all",
  statusFilter = "all",
  testingModelIds = new Set(),
  onTestModels,
  onStopModels,
}: DashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const { isAuthenticated, token } = useAuth();
  const { toast, update } = useToast();

  const fetchData = useCallback(async (
    signal?: AbortSignal,
    page: number = 1,
    searchQuery: string = "",
    endpoint: EndpointFilter = "all",
    status: StatusFilter = "all"
  ) => {
    try {
      const localToken = localStorage.getItem("auth_token");
      const headers: Record<string, string> = {};
      if (localToken) {
        headers.Authorization = `Bearer ${localToken}`;
      }

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });

      if (searchQuery) {
        params.set("search", searchQuery);
      }
      if (endpoint !== "all") {
        params.set("endpointFilter", endpoint);
      }
      if (status !== "all") {
        params.set("statusFilter", status);
      }

      const response = await fetch(`/api/dashboard?${params}`, { headers, signal });
      if (!response.ok) {
        throw new Error("Failed to fetch dashboard data");
      }

      const result = await response.json();
      if (!signal?.aborted) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const handleDeleteChannel = useCallback(async (channelId: string) => {
    if (!token) return;

    const toastId = toast("Deleting channel...", "loading");
    try {
      const response = await fetch(`/api/channel?id=${channelId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error("Failed to delete channel");
      }
      update(toastId, "Channel deleted", "success");
      fetchData(undefined, currentPage, search, endpointFilter, statusFilter);
    } catch (err) {
      update(toastId, err instanceof Error ? err.message : "Delete failed", "error");
    }
  }, [token, toast, update, fetchData, currentPage, search, endpointFilter, statusFilter]);

  const handlePageChange = useCallback((newPage: number) => {
    setCurrentPage(newPage);
    setLoading(true);
    fetchData(undefined, newPage, search, endpointFilter, statusFilter);
  }, [fetchData, search, endpointFilter, statusFilter]);

  const prevFiltersRef = useRef({ search, endpointFilter, statusFilter });
  const currentPageRef = useRef(currentPage);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    const controller = new AbortController();
    const prevFilters = prevFiltersRef.current;
    const filtersChanged =
      prevFilters.search !== search ||
      prevFilters.endpointFilter !== endpointFilter ||
      prevFilters.statusFilter !== statusFilter;

    prevFiltersRef.current = { search, endpointFilter, statusFilter };

    let pageToFetch = currentPageRef.current;
    if (filtersChanged) {
      pageToFetch = 1;
      setCurrentPage(1);
    }

    fetchData(controller.signal, pageToFetch, search, endpointFilter, statusFilter);
    return () => controller.abort();
  }, [fetchData, refreshKey, search, endpointFilter, statusFilter]);

  const sortedChannels = useMemo(() => {
    if (!data?.channels) return [];

    return data.channels
      .map((channel) => {
        const sortedModels = [...channel.models].sort((a, b) => {
          const statusCmp = modelSortWeight(a.healthStatus) - modelSortWeight(b.healthStatus);
          if (statusCmp !== 0) {
            return statusCmp;
          }
          return a.modelName.localeCompare(b.modelName);
        });

        return { ...channel, models: sortedModels };
      })
      .filter((channel) => channel.models.length > 0);
  }, [data?.channels]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-destructive">{error}</p>
        <button
          onClick={() => fetchData(undefined, currentPage)}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const { pagination } = data;
  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="space-y-6">
      {isAuthenticated && <ChannelManager onUpdate={() => fetchData(undefined, currentPage, search, endpointFilter, statusFilter)} />}

      <Summary data={data.summary} />

      {sortedChannels.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {data.channels.length === 0 ? "No channels configured" : "No matching results"}
        </div>
      ) : (
        <div className="grid gap-4">
          {sortedChannels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              viewMode={viewMode}
              onRefresh={() => fetchData(undefined, currentPage, search, endpointFilter, statusFilter)}
              onDelete={handleDeleteChannel}
              testingModelIds={testingModelIds}
              onTestModels={onTestModels}
              onStopModels={onStopModels}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
            className={cn(
              "flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              currentPage <= 1 || loading
                ? "text-muted-foreground cursor-not-allowed"
                : "text-foreground hover:bg-accent"
            )}
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </button>

          <div className="flex items-center gap-1">
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((page) => {
                if (page === 1 || page === totalPages) return true;
                if (Math.abs(page - currentPage) <= 1) return true;
                return false;
              })
              .map((page, index, arr) => {
                const prevPage = arr[index - 1];
                const showEllipsis = prevPage && page - prevPage > 1;

                return (
                  <span key={page} className="flex items-center">
                    {showEllipsis && <span className="px-2 text-muted-foreground">...</span>}
                    <button
                      onClick={() => handlePageChange(page)}
                      disabled={loading}
                      className={cn(
                        "min-w-[36px] h-9 px-3 rounded-md text-sm font-medium transition-colors",
                        page === currentPage
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent text-foreground"
                      )}
                    >
                      {page}
                    </button>
                  </span>
                );
              })}
          </div>

          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
            className={cn(
              "flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              currentPage >= totalPages || loading
                ? "text-muted-foreground cursor-not-allowed"
                : "text-foreground hover:bg-accent"
            )}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>

          <span className="text-sm text-muted-foreground ml-4">
            Page {currentPage} / {totalPages}, {pagination.totalChannels} channels
          </span>
        </div>
      )}
    </div>
  );
}
