// Channel Import API - Import channels from configuration

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { syncChannelModels } from "@/lib/queue/service";
import { appendChannelToWebDAV, updateChannelInWebDAV, syncAllChannelsToWebDAV, isWebDAVConfigured } from "@/lib/webdav/sync";
import type { ChannelExportData } from "../export/route";

type ImportMode = "merge" | "replace";

type ImportChannelInput =
  Partial<ChannelExportData["channels"][number]>
  & Record<string, unknown>;

type NormalizedChannel = {
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  enabled: boolean;
  keyMode: "single" | "multi";
  channelKeys: { apiKey: string; name: string | null }[];
};

function readTrimmedString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function readBoolean(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
    }
  }
  return undefined;
}

function normalizeChannelKeys(value: unknown): { apiKey: string; name: string | null }[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const keys: { apiKey: string; name: string | null }[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const apiKey = item.trim();
      if (apiKey) keys.push({ apiKey, name: null });
      continue;
    }

    if (typeof item === "object" && item !== null) {
      const raw = item as Record<string, unknown>;
      const apiKey = readTrimmedString(raw, ["apiKey", "api_key", "key", "token"]);
      if (!apiKey) continue;
      const keyName = readTrimmedString(raw, ["name", "label"]);
      keys.push({ apiKey, name: keyName ?? null });
    }
  }

  return keys;
}

function normalizeKeysText(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeChannel(raw: ImportChannelInput): NormalizedChannel | { error: string } {
  const name = readTrimmedString(raw, ["name", "channelName", "channel_name", "title"]);
  const baseUrl = readTrimmedString(raw, ["baseUrl", "base_url", "url", "apiBaseUrl", "api_base_url"]);
  const proxy = readTrimmedString(raw, ["proxy", "proxyUrl", "proxy_url"]);
  const enabled = readBoolean(raw, ["enabled", "isEnabled", "active", "status"]) ?? true;

  const keyModeRaw = readTrimmedString(raw, ["keyMode", "key_mode"]);
  const keyMode: "single" | "multi" = keyModeRaw === "multi" ? "multi" : "single";

  const directApiKey = readTrimmedString(raw, ["apiKey", "api_key", "key", "token"]);
  const channelKeysFromArray =
    normalizeChannelKeys(raw.channelKeys ?? raw.channel_keys ?? raw.keys);
  const keysFromText = normalizeKeysText(raw.keysText ?? raw.keys ?? raw.apiKeys ?? raw.api_keys);

  const keysFromTextAsObjects =
    keysFromText.length > 0
      ? keysFromText.map((apiKey) => ({ apiKey, name: null }))
      : [];

  const allChannelKeys = [...channelKeysFromArray, ...keysFromTextAsObjects];
  const uniqueKeyMap = new Map<string, { apiKey: string; name: string | null }>();
  for (const key of allChannelKeys) {
    if (!uniqueKeyMap.has(key.apiKey)) {
      uniqueKeyMap.set(key.apiKey, key);
    }
  }
  const dedupedKeys = Array.from(uniqueKeyMap.values());

  let apiKey = directApiKey;
  const channelKeys = [...dedupedKeys];

  if (!apiKey && channelKeys.length > 0) {
    apiKey = channelKeys[0].apiKey;
    channelKeys.shift();
  }

  if (!name) {
    return { error: "Missing name/channelName field" };
  }
  if (!baseUrl) {
    return { error: "Missing baseUrl/base_url/url field" };
  }
  if (!apiKey) {
    return { error: "Missing apiKey/api_key/key/token field" };
  }

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const normalizedApiKey = apiKey.trim();
  const filteredChannelKeys = channelKeys.filter((key) => key.apiKey !== normalizedApiKey);

  return {
    name: name.trim(),
    baseUrl: normalizedBaseUrl,
    apiKey: normalizedApiKey,
    proxy: proxy ?? null,
    enabled,
    keyMode,
    channelKeys: filteredChannelKeys,
  };
}

function extractChannels(body: unknown): ImportChannelInput[] | null {
  if (Array.isArray(body)) {
    return body as ImportChannelInput[];
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const payload = body as Record<string, unknown>;
  if (Array.isArray(payload.channels)) {
    return payload.channels as ImportChannelInput[];
  }

  const payloadData = payload.data;
  if (typeof payloadData === "object" && payloadData !== null) {
    const dataRecord = payloadData as Record<string, unknown>;
    if (Array.isArray(dataRecord.channels)) {
      return dataRecord.channels as ImportChannelInput[];
    }
  }

  return null;
}

// POST /api/channel/import - Import channels
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const mode: ImportMode = body?.mode === "replace" ? "replace" : "merge";
    const syncModels = body?.syncModels !== false;
    const channelsToImport = extractChannels(body);

    if (!channelsToImport || !Array.isArray(channelsToImport)) {
      return NextResponse.json(
        { error: "Invalid import data: channels array required", code: "INVALID_DATA" },
        { status: 400 }
      );
    }

    const normalizedChannels: NormalizedChannel[] = [];
    const invalidEntries: Array<{ index: number; name?: string; reason: string }> = [];

    channelsToImport.forEach((raw, index) => {
      const normalized = normalizeChannel(raw);
      if ("error" in normalized) {
        const possibleName =
          typeof raw?.name === "string"
            ? raw.name
            : typeof raw?.channelName === "string"
              ? raw.channelName
              : undefined;
        invalidEntries.push({ index, name: possibleName, reason: normalized.error });
        return;
      }
      normalizedChannels.push(normalized);
    });

    if (normalizedChannels.length === 0) {
      return NextResponse.json(
        {
          error: "No valid channels found in import payload",
          code: "INVALID_DATA",
          invalid: invalidEntries.length,
          invalidEntries,
        },
        { status: 400 }
      );
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let duplicates = 0;
    const importedChannelIds: string[] = [];

    // Track channels for WebDAV sync
    const channelsToSync: Array<{
      name: string;
      baseUrl: string;
      apiKey: string;
      proxy: string | null;
      enabled: boolean;
      keyMode?: string;
      channelKeys?: { apiKey: string; name: string | null }[];
      action: "create" | "update";
    }> = [];

    // If replace mode, delete all existing channels first
    if (mode === "replace") {
      await prisma.channel.deleteMany({});
    }

    const existingChannels = await prisma.channel.findMany({
      select: { id: true, name: true, baseUrl: true, apiKey: true },
    });
    const existingByName = new Map(
      existingChannels.map((channel) => [channel.name.trim().toLowerCase(), channel])
    );
    const importNameSet = new Set<string>();

    for (const ch of normalizedChannels) {
      const normalizedNameKey = ch.name.toLowerCase();
      if (importNameSet.has(normalizedNameKey)) {
        duplicates++;
        continue;
      }
      importNameSet.add(normalizedNameKey);

      const existing = mode === "replace" ? null : existingByName.get(normalizedNameKey);

      if (existing) {
        if (mode === "merge") {
          await prisma.channel.update({
            where: { id: existing.id },
            data: {
              name: ch.name,
              baseUrl: ch.baseUrl,
              apiKey: ch.apiKey,
              proxy: ch.proxy,
              enabled: ch.enabled ?? true,
              keyMode: ch.keyMode,
            },
          });

          await prisma.channelKey.deleteMany({ where: { channelId: existing.id } });
          if (ch.channelKeys.length > 0) {
            await prisma.channelKey.createMany({
              data: ch.channelKeys.map((key) => ({
                channelId: existing.id,
                apiKey: key.apiKey,
                name: key.name,
              })),
            });
          }

          importedChannelIds.push(existing.id);
          updated++;
          channelsToSync.push({
            name: ch.name,
            baseUrl: ch.baseUrl,
            apiKey: ch.apiKey,
            proxy: ch.proxy,
            enabled: ch.enabled ?? true,
            keyMode: ch.keyMode,
            channelKeys: ch.channelKeys,
            action: "update",
          });
        } else {
          skipped++;
        }
      } else {
        const newChannel = await prisma.channel.create({
          data: {
            name: ch.name,
            baseUrl: ch.baseUrl,
            apiKey: ch.apiKey,
            proxy: ch.proxy,
            enabled: ch.enabled ?? true,
            keyMode: ch.keyMode,
          },
        });

        if (ch.channelKeys.length > 0) {
          await prisma.channelKey.createMany({
            data: ch.channelKeys.map((key) => ({
              channelId: newChannel.id,
              apiKey: key.apiKey,
              name: key.name,
            })),
          });
        }

        importedChannelIds.push(newChannel.id);
        imported++;
        channelsToSync.push({
          name: newChannel.name,
          baseUrl: ch.baseUrl,
          apiKey: ch.apiKey,
          proxy: ch.proxy,
          enabled: ch.enabled ?? true,
          keyMode: ch.keyMode,
          channelKeys: ch.channelKeys,
          action: "create",
        });
        existingByName.set(normalizedNameKey, {
          id: newChannel.id,
          name: newChannel.name,
          baseUrl: newChannel.baseUrl,
          apiKey: newChannel.apiKey,
        });
      }
    }

    let syncedModels = 0;
    const syncErrors: string[] = [];

    if (syncModels && importedChannelIds.length > 0) {
      const CONCURRENCY = 3;
      for (let i = 0; i < importedChannelIds.length; i += CONCURRENCY) {
        const batch = importedChannelIds.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((channelId) => syncChannelModels(channelId))
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === "fulfilled") {
            syncedModels += result.value.added;
          } else {
            syncErrors.push(batch[j]);
          }
        }
      }
    }

    const webdavStatus = { synced: false, error: null as string | null };
    if (isWebDAVConfigured() && channelsToSync.length > 0) {
      try {
        if (mode === "replace") {
          const allChannels = await prisma.channel.findMany({
            select: {
              name: true,
              baseUrl: true,
              apiKey: true,
              proxy: true,
              enabled: true,
              keyMode: true,
              channelKeys: { select: { apiKey: true, name: true } },
            },
          });
          await syncAllChannelsToWebDAV(allChannels);
        } else {
          for (const ch of channelsToSync) {
            if (ch.action === "create") {
              await appendChannelToWebDAV(ch);
            } else {
              await updateChannelInWebDAV(ch);
            }
          }
        }
        webdavStatus.synced = true;
      } catch (err) {
        webdavStatus.error = err instanceof Error ? err.message : "WebDAV sync failed";
      }
    }

    return NextResponse.json({
      success: true,
      imported,
      updated,
      skipped,
      duplicates,
      invalid: invalidEntries.length,
      invalidEntries: invalidEntries.length > 0 ? invalidEntries : undefined,
      total: channelsToImport.length,
      processed: normalizedChannels.length,
      syncedModels,
      syncErrors: syncErrors.length > 0 ? syncErrors : undefined,
      webdav: webdavStatus,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to import channels", code: "IMPORT_ERROR" },
      { status: 500 }
    );
  }
}
