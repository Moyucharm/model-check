// Channel API - CRUD operations for channels

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function normalizeKeyMode(value: unknown): "single" | "multi" {
  return value === "multi" ? "multi" : "single";
}

function parseKeysText(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const dedup = new Set(
    value
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  return Array.from(dedup);
}

function buildExtraKeys(mainApiKey: string, keysValue: unknown): string[] {
  const parsed = parseKeysText(keysValue);
  if (parsed.length === 0) return [];
  return parsed.filter((key) => key !== mainApiKey);
}

// GET /api/channel - List all channels (authenticated)
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const channels = await prisma.channel.findMany({
      include: {
        _count: {
          select: { models: true, channelKeys: true },
        },
        models: {
          select: { lastStatus: true },
        },
      },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "desc" },
      ],
    });

    const maskedChannels = channels.map((channel) => ({
      ...channel,
      apiKey: channel.apiKey.slice(0, 8) + "..." + channel.apiKey.slice(-4),
    }));

    return NextResponse.json({ channels: maskedChannels });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch channels", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}

// POST /api/channel - Create new channel
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json() as Record<string, unknown>;

    const name = readTrimmedString(body.name);
    const baseUrlRaw = readTrimmedString(body.baseUrl);
    const apiKeyRaw = readTrimmedString(body.apiKey);
    const keysFromText = parseKeysText(body.keys);
    const apiKey = apiKeyRaw ?? keysFromText[0];
    const keyMode = normalizeKeyMode(body.keyMode);

    if (!name || !baseUrlRaw || !apiKey) {
      return NextResponse.json(
        { error: "Name, baseUrl, and apiKey are required", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    const existingByName = await prisma.channel.findFirst({
      where: { name },
      select: { id: true },
    });
    if (existingByName) {
      return NextResponse.json(
        { error: "渠道名称已存在", code: "DUPLICATE_NAME" },
        { status: 409 }
      );
    }

    const proxy = readTrimmedString(body.proxy) ?? null;
    const normalizedBaseUrl = normalizeBaseUrl(baseUrlRaw);

    const channel = await prisma.$transaction(async (tx) => {
      const minSort = await tx.channel.aggregate({
        _min: { sortOrder: true },
      });

      const nextSortOrder = (minSort._min.sortOrder ?? 0) - 1;

      return tx.channel.create({
        data: {
          name,
          baseUrl: normalizedBaseUrl,
          apiKey,
          proxy,
          enabled: true,
          sortOrder: nextSortOrder,
          keyMode,
        },
      });
    });

    if (keyMode === "multi") {
      const extraKeys = buildExtraKeys(apiKey, body.keys);
      if (extraKeys.length > 0) {
        await prisma.channelKey.createMany({
          data: extraKeys.map((key) => ({
            channelId: channel.id,
            apiKey: key,
          })),
        });
      }
    }

    if (Array.isArray(body.models) && body.models.length > 0) {
      const uniqueModels = Array.from(
        new Set(
          body.models
            .filter((model): model is string => typeof model === "string")
            .map((modelName) => modelName.trim())
            .filter(Boolean)
        )
      );

      if (uniqueModels.length > 0) {
        await prisma.model.createMany({
          data: uniqueModels.map((modelName) => ({
            channelId: channel.id,
            modelName,
          })),
        });
      }
    }

    return NextResponse.json({
      success: true,
      channel: {
        ...channel,
        apiKey: channel.apiKey.slice(0, 8) + "...",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to create channel", code: "CREATE_ERROR" },
      { status: 500 }
    );
  }
}

// PUT /api/channel - Update channel
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json() as Record<string, unknown>;
    const id = readTrimmedString(body.id);

    if (Array.isArray(body.orders)) {
      await prisma.$transaction(
        body.orders
          .filter(
            (item): item is { id: string; sortOrder: number } =>
              typeof item === "object"
              && item !== null
              && typeof (item as { id?: unknown }).id === "string"
              && typeof (item as { sortOrder?: unknown }).sortOrder === "number"
          )
          .map((item) =>
            prisma.channel.update({
              where: { id: item.id },
              data: { sortOrder: Math.floor(item.sortOrder) },
            })
          )
      );

      return NextResponse.json({ success: true });
    }

    if (!id) {
      return NextResponse.json(
        { error: "Channel ID is required", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    const name = body.name === undefined ? undefined : readTrimmedString(body.name);
    const baseUrl = body.baseUrl === undefined
      ? undefined
      : readTrimmedString(body.baseUrl);
    const apiKeyFromBody = body.apiKey === undefined
      ? undefined
      : readTrimmedString(body.apiKey);
    const keyMode = body.keyMode === undefined
      ? undefined
      : normalizeKeyMode(body.keyMode);

    if (body.name !== undefined && !name) {
      return NextResponse.json(
        { error: "Channel name cannot be empty", code: "INVALID_NAME" },
        { status: 400 }
      );
    }

    if (name) {
      const existingByName = await prisma.channel.findFirst({
        where: { name, id: { not: id } },
        select: { id: true },
      });
      if (existingByName) {
        return NextResponse.json(
          { error: "渠道名称已存在", code: "DUPLICATE_NAME" },
          { status: 409 }
        );
      }
    }

    const keysFromText = parseKeysText(body.keys);
    const inferredApiKey = apiKeyFromBody ?? (keysFromText.length > 0 ? keysFromText[0] : undefined);

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (baseUrl !== undefined) updateData.baseUrl = normalizeBaseUrl(baseUrl);
    if (inferredApiKey !== undefined) updateData.apiKey = inferredApiKey;
    if (body.proxy !== undefined) updateData.proxy = readTrimmedString(body.proxy) ?? null;
    if (body.enabled !== undefined) updateData.enabled = Boolean(body.enabled);
    if (keyMode !== undefined) updateData.keyMode = keyMode;

    const channel = await prisma.$transaction(async (tx) => {
      const updatedChannel = await tx.channel.update({
        where: { id },
        data: updateData,
      });

      if (keyMode === "multi" && body.keys !== undefined) {
        await tx.channelKey.deleteMany({ where: { channelId: id } });
        const mainApiKey = inferredApiKey ?? updatedChannel.apiKey;
        const extraKeys = buildExtraKeys(mainApiKey, body.keys);
        if (extraKeys.length > 0) {
          await tx.channelKey.createMany({
            data: extraKeys.map((key) => ({
              channelId: id,
              apiKey: key,
            })),
          });
        }
      } else if (keyMode === "single") {
        await tx.channelKey.deleteMany({ where: { channelId: id } });
      }

      return updatedChannel;
    });

    return NextResponse.json({
      success: true,
      channel: {
        ...channel,
        apiKey: channel.apiKey.slice(0, 8) + "...",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to update channel", code: "UPDATE_ERROR" },
      { status: 500 }
    );
  }
}

// DELETE /api/channel - Delete channel
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "Channel ID is required", code: "MISSING_ID" },
        { status: 400 }
      );
    }

    const channel = await prisma.channel.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "Channel not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    await prisma.channel.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete channel", code: "DELETE_ERROR" },
      { status: 500 }
    );
  }
}
