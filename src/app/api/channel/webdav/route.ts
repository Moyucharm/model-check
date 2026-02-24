// WebDAV Sync API - Sync channels and scheduler config to/from WebDAV server

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { syncChannelModels } from "@/lib/queue/service";
import type { ChannelExportData } from "../export/route";

const ENV_WEBDAV_URL = process.env.WEBDAV_URL;
const ENV_WEBDAV_USERNAME = process.env.WEBDAV_USERNAME;
const ENV_WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD;
const ENV_WEBDAV_FILENAME = process.env.WEBDAV_FILENAME;
const ENV_AUTO_DETECT_ALL_CHANNELS = process.env.AUTO_DETECT_ALL_CHANNELS !== "false";

interface WebDAVConfig {
  url: string;
  username?: string;
  password?: string;
  filename?: string;
}

interface RemoteDownloadPayload extends ChannelExportData {
  schedulerConfig?: Record<string, unknown>;
}

interface RemoteChannel {
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy?: string | null;
  enabled?: boolean;
  keyMode?: string;
  channelKeys?: { apiKey: string; name: string | null }[];
}

function buildWebDAVHeaders(config: WebDAVConfig): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (config.username && config.password) {
    const auth = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    headers["Authorization"] = `Basic ${auth}`;
  }

  return headers;
}

function buildWebDAVUrl(config: WebDAVConfig): string {
  let url = config.url.replace(/\/$/, "");
  const filename = config.filename || "channels.json";
  if (!url.endsWith(filename)) {
    url = `${url}/${filename}`;
  }
  return url;
}

async function ensureParentDirectories(baseUrl: string, filename: string, headers: HeadersInit): Promise<void> {
  const filenameParts = filename.split("/").filter(Boolean);
  filenameParts.pop();

  if (filenameParts.length === 0) {
    return;
  }

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  let currentPath = normalizedBaseUrl;

  for (const part of filenameParts) {
    currentPath += `/${part}`;
    const dirUrl = currentPath.endsWith("/") ? currentPath : `${currentPath}/`;

    try {
      await fetch(dirUrl, {
        method: "MKCOL",
        headers: {
          ...headers,
          "Content-Type": "application/xml",
        },
      });
    } catch {
      // Ignore directory creation errors; PUT will surface final failure if any.
    }
  }
}

function normalizeChannelInput(ch: RemoteChannel): RemoteChannel | null {
  if (!ch.name || !ch.baseUrl || !ch.apiKey) {
    return null;
  }

  return {
    name: ch.name,
    baseUrl: ch.baseUrl.replace(/\/$/, ""),
    apiKey: ch.apiKey,
    proxy: ch.proxy || null,
    enabled: ch.enabled ?? true,
    keyMode: ch.keyMode || "single",
    channelKeys: ch.channelKeys,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  return NextResponse.json({
    configured: !!(ENV_WEBDAV_URL && ENV_WEBDAV_USERNAME && ENV_WEBDAV_PASSWORD),
    url: ENV_WEBDAV_URL || "",
    username: ENV_WEBDAV_USERNAME || "",
    hasPassword: !!ENV_WEBDAV_PASSWORD,
    filename: ENV_WEBDAV_FILENAME || "channels.json",
  });
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action, url, username, password, filename, mode = "merge" } = body as {
      action: "upload" | "download";
      url?: string;
      username?: string;
      password?: string;
      filename?: string;
      mode?: "merge" | "replace";
    };

    const finalUrl = url || ENV_WEBDAV_URL;
    const finalUsername = username || ENV_WEBDAV_USERNAME;
    const finalPassword = password || ENV_WEBDAV_PASSWORD;
    const finalFilename = filename || ENV_WEBDAV_FILENAME;

    if (!action || !finalUrl) {
      return NextResponse.json(
        { error: "Action and URL are required (set WEBDAV_URL env or provide in request)", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    const config: WebDAVConfig = {
      url: finalUrl,
      username: finalUsername,
      password: finalPassword,
      filename: finalFilename,
    };

    const webdavUrl = buildWebDAVUrl(config);
    const headers = buildWebDAVHeaders(config);

    if (action === "upload") {
      const channels = await prisma.channel.findMany({
        select: {
          name: true,
          baseUrl: true,
          apiKey: true,
          proxy: true,
          enabled: true,
          keyMode: true,
          channelKeys: {
            select: { apiKey: true, name: true },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const schedulerConfig = await prisma.schedulerConfig.findUnique({
        where: { id: "default" },
      });

      const localChannels = channels.map((ch) => ({
        name: ch.name,
        baseUrl: ch.baseUrl.replace(/\/$/, ""),
        apiKey: ch.apiKey,
        proxy: ch.proxy,
        enabled: ch.enabled,
        keyMode: ch.keyMode,
        ...(ch.channelKeys.length > 0 && {
          channelKeys: ch.channelKeys.map((k) => ({ apiKey: k.apiKey, name: k.name })),
        }),
      }));

      const finalChannels = [...localChannels];
      let merged = 0;

      if (mode === "merge") {
        try {
          const downloadResponse = await fetch(webdavUrl, {
            method: "GET",
            headers,
          });

          if (downloadResponse.ok) {
            const remoteData = (await downloadResponse.json()) as RemoteDownloadPayload;
            if (Array.isArray(remoteData.channels)) {
              const localKeySet = new Set(localChannels.map((ch) => `${ch.baseUrl}|${ch.apiKey}`));

              for (const remoteRaw of remoteData.channels) {
                const normalizedRemote = normalizeChannelInput(remoteRaw as RemoteChannel);
                if (!normalizedRemote) continue;

                const remoteKey = `${normalizedRemote.baseUrl}|${normalizedRemote.apiKey}`;
                if (localKeySet.has(remoteKey)) {
                  continue;
                }

                finalChannels.push({
                  name: normalizedRemote.name,
                  baseUrl: normalizedRemote.baseUrl,
                  apiKey: normalizedRemote.apiKey,
                  proxy: normalizedRemote.proxy || null,
                  enabled: normalizedRemote.enabled ?? true,
                  keyMode: normalizedRemote.keyMode || "single",
                  ...(normalizedRemote.channelKeys?.length && { channelKeys: normalizedRemote.channelKeys }),
                });
                merged += 1;
              }
            }
          }
        } catch {
          // Continue with local-only upload.
        }
      }

      const exportData = {
        version: "2.0",
        exportedAt: new Date().toISOString(),
        channels: finalChannels,
        schedulerConfig: schedulerConfig
          ? {
              enabled: schedulerConfig.enabled,
              cronSchedule: schedulerConfig.cronSchedule,
              timezone: schedulerConfig.timezone,
              channelConcurrency: schedulerConfig.channelConcurrency,
              maxGlobalConcurrency: schedulerConfig.maxGlobalConcurrency,
              minDelayMs: schedulerConfig.minDelayMs,
              maxDelayMs: schedulerConfig.maxDelayMs,
              detectAllChannels: schedulerConfig.detectAllChannels,
              selectedChannelIds: schedulerConfig.selectedChannelIds,
              selectedModelIds: schedulerConfig.selectedModelIds,
            }
          : undefined,
      };

      await ensureParentDirectories(finalUrl, finalFilename || "channels.json", headers);

      const response = await fetch(webdavUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify(exportData, null, 2),
      });

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        const text = await response.text().catch(() => "");
        throw new Error(`WebDAV upload failed: ${response.status} ${response.statusText} ${text}`);
      }

      return NextResponse.json({
        success: true,
        action: "upload",
        mode,
        localCount: localChannels.length,
        mergedFromRemote: merged,
        totalUploaded: finalChannels.length,
        replaced: mode === "replace",
        url: webdavUrl,
      });
    }

    if (action === "download") {
      const response = await fetch(webdavUrl, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return NextResponse.json(
            { error: "Remote file not found", code: "NOT_FOUND" },
            { status: 404 }
          );
        }
        throw new Error(`WebDAV download failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as RemoteDownloadPayload;

      if (!Array.isArray(data.channels)) {
        return NextResponse.json(
          { error: "Invalid remote data format", code: "INVALID_DATA" },
          { status: 400 }
        );
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let duplicates = 0;
      const importedChannelIds: string[] = [];

      const validChannels: RemoteChannel[] = [];
      for (const raw of data.channels) {
        const normalized = normalizeChannelInput(raw as RemoteChannel);
        if (!normalized) {
          skipped += 1;
          continue;
        }
        validChannels.push(normalized);
      }

      if (mode === "replace") {
        if (validChannels.length === 0) {
          return NextResponse.json(
            {
              error: "Remote data contains no valid channels. Replace cancelled to prevent data loss.",
              code: "NO_VALID_CHANNELS",
            },
            { status: 400 }
          );
        }

        await prisma.$transaction(async (tx) => {
          await tx.channel.deleteMany({});

          const importKeySet = new Set<string>();

          for (const ch of validChannels) {
            const channelKey = `${ch.baseUrl}|${ch.apiKey}`;
            if (importKeySet.has(channelKey)) {
              duplicates += 1;
              continue;
            }
            importKeySet.add(channelKey);

            const newChannel = await tx.channel.create({
              data: {
                name: ch.name,
                baseUrl: ch.baseUrl,
                apiKey: ch.apiKey,
                proxy: ch.proxy || null,
                enabled: ch.enabled ?? true,
                keyMode: ch.keyMode || "single",
              },
            });

            if (ch.channelKeys && ch.channelKeys.length > 0) {
              await tx.channelKey.createMany({
                data: ch.channelKeys
                  .filter((k) => k.apiKey?.trim())
                  .map((k) => ({
                    channelId: newChannel.id,
                    apiKey: k.apiKey.trim(),
                    name: k.name?.trim() || null,
                  })),
              });
            }

            importedChannelIds.push(newChannel.id);
            imported += 1;
          }
        });
      } else {
        const existingChannels = await prisma.channel.findMany({
          select: { id: true, name: true, baseUrl: true, apiKey: true },
        });

        const existingByKey = new Map<string, (typeof existingChannels)[number]>(
          existingChannels.map((ch) => [`${ch.baseUrl.replace(/\/$/, "")}|${ch.apiKey}`, ch] as const)
        );

        const existingKeySet = new Set(existingByKey.keys());
        const existingNameSet = new Set(existingChannels.map((ch) => ch.name));

        const importKeySet = new Set<string>();
        const importNameSet = new Set<string>();

        const generateUniqueName = (baseName: string): string => {
          let name = baseName;
          let suffix = 1;
          while (existingNameSet.has(name) || importNameSet.has(name)) {
            name = `${baseName}-${suffix}`;
            suffix += 1;
          }
          return name;
        };

        for (const ch of validChannels) {
          const channelKey = `${ch.baseUrl}|${ch.apiKey}`;
          if (importKeySet.has(channelKey)) {
            duplicates += 1;
            continue;
          }
          importKeySet.add(channelKey);

          if (existingKeySet.has(channelKey)) {
            const existing = existingByKey.get(channelKey);
            if (!existing) {
              duplicates += 1;
              continue;
            }

            await prisma.channel.update({
              where: { id: existing.id },
              data: {
                baseUrl: ch.baseUrl,
                apiKey: ch.apiKey,
                proxy: ch.proxy || null,
                enabled: ch.enabled ?? true,
                keyMode: ch.keyMode || "single",
              },
            });

            await prisma.channelKey.deleteMany({ where: { channelId: existing.id } });
            if (ch.channelKeys && ch.channelKeys.length > 0) {
              await prisma.channelKey.createMany({
                data: ch.channelKeys
                  .filter((k) => k.apiKey?.trim())
                  .map((k) => ({
                    channelId: existing.id,
                    apiKey: k.apiKey.trim(),
                    name: k.name?.trim() || null,
                  })),
              });
            }

            importedChannelIds.push(existing.id);
            updated += 1;
            continue;
          }

          const finalName = generateUniqueName(ch.name);
          importNameSet.add(finalName);

          const newChannel = await prisma.channel.create({
            data: {
              name: finalName,
              baseUrl: ch.baseUrl,
              apiKey: ch.apiKey,
              proxy: ch.proxy || null,
              enabled: ch.enabled ?? true,
              keyMode: ch.keyMode || "single",
            },
          });

          if (ch.channelKeys && ch.channelKeys.length > 0) {
            await prisma.channelKey.createMany({
              data: ch.channelKeys
                .filter((k) => k.apiKey?.trim())
                .map((k) => ({
                  channelId: newChannel.id,
                  apiKey: k.apiKey.trim(),
                  name: k.name?.trim() || null,
                })),
            });
          }

          importedChannelIds.push(newChannel.id);
          imported += 1;
        }
      }

      let syncedModels = 0;
      if (importedChannelIds.length > 0) {
        const CONCURRENCY = 3;
        for (let i = 0; i < importedChannelIds.length; i += CONCURRENCY) {
          const batch = importedChannelIds.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(batch.map((channelId) => syncChannelModels(channelId)));

          for (const result of results) {
            if (result.status === "fulfilled") {
              syncedModels += result.value.added;
            }
          }
        }
      }

      let schedulerConfigRestored = false;
      if (data.schedulerConfig) {
        try {
          await prisma.schedulerConfig.upsert({
            where: { id: "default" },
            update: {
              enabled: (data.schedulerConfig.enabled as boolean) ?? true,
              cronSchedule: (data.schedulerConfig.cronSchedule as string) ?? "0 * * * *",
              timezone: (data.schedulerConfig.timezone as string) ?? "Asia/Shanghai",
              channelConcurrency: (data.schedulerConfig.channelConcurrency as number) ?? 5,
              maxGlobalConcurrency: (data.schedulerConfig.maxGlobalConcurrency as number) ?? 30,
              minDelayMs: (data.schedulerConfig.minDelayMs as number) ?? 3000,
              maxDelayMs: (data.schedulerConfig.maxDelayMs as number) ?? 5000,
              detectAllChannels: (data.schedulerConfig.detectAllChannels as boolean) ?? ENV_AUTO_DETECT_ALL_CHANNELS,
              selectedChannelIds: (data.schedulerConfig.selectedChannelIds as string[]) ?? null,
              selectedModelIds: (data.schedulerConfig.selectedModelIds as Record<string, string[]>) ?? null,
            },
            create: {
              id: "default",
              enabled: (data.schedulerConfig.enabled as boolean) ?? true,
              cronSchedule: (data.schedulerConfig.cronSchedule as string) ?? "0 * * * *",
              timezone: (data.schedulerConfig.timezone as string) ?? "Asia/Shanghai",
              channelConcurrency: (data.schedulerConfig.channelConcurrency as number) ?? 5,
              maxGlobalConcurrency: (data.schedulerConfig.maxGlobalConcurrency as number) ?? 30,
              minDelayMs: (data.schedulerConfig.minDelayMs as number) ?? 3000,
              maxDelayMs: (data.schedulerConfig.maxDelayMs as number) ?? 5000,
              detectAllChannels: (data.schedulerConfig.detectAllChannels as boolean) ?? ENV_AUTO_DETECT_ALL_CHANNELS,
              selectedChannelIds: (data.schedulerConfig.selectedChannelIds as string[]) ?? null,
              selectedModelIds: (data.schedulerConfig.selectedModelIds as Record<string, string[]>) ?? null,
            },
          });

          schedulerConfigRestored = true;
        } catch {
          // Keep download successful even when scheduler restore fails.
        }
      }

      return NextResponse.json({
        success: true,
        action: "download",
        imported,
        updated,
        skipped,
        duplicates,
        total: data.channels.length,
        syncedModels,
        schedulerConfigRestored,
        remoteVersion: data.version,
        remoteExportedAt: data.exportedAt,
      });
    }

    return NextResponse.json(
      { error: "Invalid action", code: "INVALID_ACTION" },
      { status: 400 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "WebDAV sync failed";
    return NextResponse.json(
      { error: message, code: "WEBDAV_ERROR" },
      { status: 500 }
    );
  }
}
