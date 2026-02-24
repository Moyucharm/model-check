// GET /api/dashboard - Get channels and models status with pagination and filtering

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isAuthenticated } from "@/lib/middleware/auth";
import { EndpointType, HealthStatus, Prisma } from "@/generated/prisma";

const DEFAULT_PAGE_SIZE = 10;

function toHealthStatus(status: HealthStatus): "healthy" | "partial" | "unhealthy" | "unknown" {
  switch (status) {
    case "HEALTHY":
      return "healthy";
    case "PARTIAL":
      return "partial";
    case "UNHEALTHY":
      return "unhealthy";
    case "UNKNOWN":
    default:
      return "unknown";
  }
}

function parseEndpointFilter(value: string | null): EndpointType | null {
  if (!value || value === "all") return null;
  if (value === "CHAT" || value === "CLAUDE" || value === "GEMINI" || value === "CODEX" || value === "IMAGE") {
    return value;
  }
  return null;
}

function parseStatusFilter(
  value: string | null
): HealthStatus | null {
  switch (value) {
    case "healthy":
      return "HEALTHY";
    case "partial":
      return "PARTIAL";
    case "unhealthy":
      return "UNHEALTHY";
    case "unknown":
      return "UNKNOWN";
    default:
      return null;
  }
}

export async function GET(request: NextRequest) {
  const authenticated = isAuthenticated(request);

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.max(1, Math.min(100, parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10)));

  const search = searchParams.get("search")?.trim() || "";
  const endpointFilterRaw = searchParams.get("endpointFilter") || "all";
  const statusFilterRaw = searchParams.get("statusFilter") || "all";

  const endpointFilter = parseEndpointFilter(endpointFilterRaw);
  const statusFilter = parseStatusFilter(statusFilterRaw);

  try {
    const modelWhereConditions: Prisma.ModelWhereInput[] = [];

    if (search) {
      modelWhereConditions.push({
        modelName: { contains: search },
      });
    }

    if (endpointFilter) {
      modelWhereConditions.push({
        modelEndpoints: {
          some: {
            endpointType: endpointFilter,
          },
        },
      });
    }

    if (statusFilter) {
      modelWhereConditions.push({ healthStatus: statusFilter });
    }

    const modelWhere: Prisma.ModelWhereInput | undefined =
      modelWhereConditions.length > 0 ? { AND: modelWhereConditions } : undefined;

    const hasFilters = Boolean(search) || Boolean(endpointFilter) || Boolean(statusFilter);

    let channelIds: string[] | undefined;
    if (hasFilters) {
      const channelsWithMatchingModels = await prisma.channel.findMany({
        where: {
          enabled: true,
          models: { some: modelWhere ?? {} },
        },
        select: { id: true },
      });
      channelIds = channelsWithMatchingModels.map((c) => c.id);
    }

    const totalChannels = hasFilters
      ? channelIds?.length || 0
      : await prisma.channel.count({ where: { enabled: true } });

    const channels = await prisma.channel.findMany({
      where: {
        enabled: true,
        ...(hasFilters && channelIds ? { id: { in: channelIds } } : {}),
      },
      select: {
        id: true,
        name: true,
        baseUrl: authenticated,
        createdAt: true,
        models: {
          where: modelWhere,
          select: {
            id: true,
            modelName: true,
            healthStatus: true,
            lastStatus: true,
            lastLatency: true,
            lastCheckedAt: true,
            modelEndpoints: {
              select: {
                endpointType: true,
                status: true,
                latency: true,
                statusCode: true,
                errorMsg: true,
                responseContent: true,
                checkedAt: true,
              },
              orderBy: { endpointType: "asc" },
            },
            checkLogs: {
              select: {
                id: true,
                status: true,
                latency: true,
                statusCode: true,
                endpointType: true,
                responseContent: true,
                errorMsg: true,
                createdAt: true,
              },
              orderBy: { createdAt: "desc" },
              take: 24,
            },
          },
        },
      },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "desc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const allChannelsForStats = await prisma.channel.findMany({
      where: { enabled: true },
      select: {
        models: {
          select: {
            id: true,
            healthStatus: true,
          },
        },
      },
    });

    const totalModels = allChannelsForStats.reduce((sum, ch) => sum + ch.models.length, 0);
    const healthyModels = allChannelsForStats.reduce(
      (sum, ch) => sum + ch.models.filter((m) => m.healthStatus === "HEALTHY").length,
      0
    );
    const partialModels = allChannelsForStats.reduce(
      (sum, ch) => sum + ch.models.filter((m) => m.healthStatus === "PARTIAL").length,
      0
    );

    const totalPages = Math.ceil(totalChannels / pageSize);

    const normalizedChannels = channels.map((channel) => ({
      ...channel,
      models: channel.models.map((model) => ({
        id: model.id,
        modelName: model.modelName,
        healthStatus: toHealthStatus(model.healthStatus),
        lastStatus: model.lastStatus,
        lastLatency: model.lastLatency,
        lastCheckedAt: model.lastCheckedAt,
        endpointStatuses: model.modelEndpoints,
        checkLogs: model.checkLogs,
      })),
    }));

    return NextResponse.json({
      authenticated,
      summary: {
        totalChannels,
        totalModels,
        healthyModels,
        partialModels,
        healthRate: totalModels > 0 ? Math.round((healthyModels / totalModels) * 100) : 0,
      },
      pagination: {
        page,
        pageSize,
        totalPages,
        totalChannels,
      },
      channels: normalizedChannels,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch dashboard data", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
