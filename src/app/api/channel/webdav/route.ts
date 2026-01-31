// WebDAV Sync API - Sync channels to/from WebDAV server

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth";
import { syncChannelModels } from "@/lib/queue/service";
import type { ChannelExportData } from "../export/route";
import { ChannelType } from "@prisma/client";

interface WebDAVConfig {
  url: string;
  username?: string;
  password?: string;
  filename?: string;
}

// Helper function to build WebDAV headers
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

// Helper function to build full WebDAV URL
function buildWebDAVUrl(config: WebDAVConfig): string {
  let url = config.url.replace(/\/$/, "");
  const filename = config.filename || "newapi-channels.json";
  if (!url.endsWith(filename)) {
    url = `${url}/${filename}`;
  }
  return url;
}

// Helper function to ensure parent directories exist
async function ensureParentDirectories(fileUrl: string, headers: HeadersInit): Promise<void> {
  // Parse URL to get the path
  const url = new URL(fileUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);

  // Remove the filename (last part) to get directory path
  pathParts.pop();

  if (pathParts.length === 0) {
    return; // No parent directories needed
  }

  // Create each directory level
  let currentPath = "";
  for (const part of pathParts) {
    currentPath += "/" + part;
    const dirUrl = `${url.origin}${currentPath}`;

    try {
      // Try to create directory with MKCOL
      const response = await fetch(dirUrl, {
        method: "MKCOL",
        headers,
      });

      // 201 = Created, 405 = Already exists (Method Not Allowed), 409 = Already exists (坚果云)
      if (response.ok || response.status === 201 || response.status === 405 || response.status === 409) {
        console.log(`[WebDAV] Directory ensured: ${currentPath}`);
      } else if (response.status === 401 || response.status === 403) {
        throw new Error(`WebDAV authentication failed: ${response.status}`);
      }
      // Other errors are ignored - directory might already exist
    } catch (error) {
      // Network errors or auth errors should be thrown
      if (error instanceof Error && error.message.includes("authentication")) {
        throw error;
      }
      console.log(`[WebDAV] MKCOL for ${currentPath}: ${error}`);
    }
  }
}

// POST /api/channel/webdav - Sync with WebDAV
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action, url, username, password, filename, mode = "merge" } = body as {
      action: "upload" | "download";
      url: string;
      username?: string;
      password?: string;
      filename?: string;
      mode?: "merge" | "replace";
    };

    if (!action || !url) {
      return NextResponse.json(
        { error: "Action and URL are required", code: "MISSING_FIELDS" },
        { status: 400 }
      );
    }

    const config: WebDAVConfig = { url, username, password, filename };
    const webdavUrl = buildWebDAVUrl(config);
    const headers = buildWebDAVHeaders(config);

    if (action === "upload") {
      // Export channels and upload to WebDAV
      const channels = await prisma.channel.findMany({
        select: {
          name: true,
          baseUrl: true,
          apiKey: true,
          type: true,
          proxy: true,
          enabled: true,
        },
        orderBy: { createdAt: "asc" },
      });

      const exportData: ChannelExportData = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        channels: channels.map((ch) => ({
          name: ch.name,
          baseUrl: ch.baseUrl,
          apiKey: ch.apiKey,
          type: ch.type,
          proxy: ch.proxy,
          enabled: ch.enabled,
        })),
      };

      // Ensure parent directories exist before uploading
      await ensureParentDirectories(webdavUrl, headers);

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
        channelCount: channels.length,
        url: webdavUrl,
      });
    } else if (action === "download") {
      // Download from WebDAV and import channels
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

      const data = (await response.json()) as ChannelExportData;

      if (!data.channels || !Array.isArray(data.channels)) {
        return NextResponse.json(
          { error: "Invalid remote data format", code: "INVALID_DATA" },
          { status: 400 }
        );
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const importedChannelIds: string[] = [];

      // If replace mode, delete all existing channels first
      if (mode === "replace") {
        await prisma.channel.deleteMany({});
      }

      for (const ch of data.channels) {
        if (!ch.name || !ch.baseUrl || !ch.apiKey) {
          skipped++;
          continue;
        }

        const channelType: ChannelType = ch.type === "DIRECT" ? "DIRECT" : "NEWAPI";

        const existing = await prisma.channel.findFirst({
          where: { name: ch.name },
        });

        if (existing) {
          if (mode === "merge") {
            await prisma.channel.update({
              where: { id: existing.id },
              data: {
                baseUrl: ch.baseUrl.replace(/\/$/, ""),
                apiKey: ch.apiKey,
                type: channelType,
                proxy: ch.proxy || null,
                enabled: ch.enabled ?? true,
              },
            });
            importedChannelIds.push(existing.id);
            updated++;
          } else {
            skipped++;
          }
        } else {
          const newChannel = await prisma.channel.create({
            data: {
              name: ch.name,
              baseUrl: ch.baseUrl.replace(/\/$/, ""),
              apiKey: ch.apiKey,
              type: channelType,
              proxy: ch.proxy || null,
              enabled: ch.enabled ?? true,
            },
          });
          importedChannelIds.push(newChannel.id);
          imported++;
        }
      }

      // Auto-sync models for imported channels
      let syncedModels = 0;
      if (importedChannelIds.length > 0) {
        const CONCURRENCY = 3;
        for (let i = 0; i < importedChannelIds.length; i += CONCURRENCY) {
          const batch = importedChannelIds.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map((channelId) => syncChannelModels(channelId))
          );

          for (const result of results) {
            if (result.status === "fulfilled") {
              syncedModels += result.value.added;
            }
          }
        }
      }

      return NextResponse.json({
        success: true,
        action: "download",
        imported,
        updated,
        skipped,
        total: data.channels.length,
        syncedModels,
        remoteVersion: data.version,
        remoteExportedAt: data.exportedAt,
      });
    }

    return NextResponse.json(
      { error: "Invalid action", code: "INVALID_ACTION" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[API] WebDAV sync error:", error);
    const message = error instanceof Error ? error.message : "WebDAV sync failed";
    return NextResponse.json(
      { error: message, code: "WEBDAV_ERROR" },
      { status: 500 }
    );
  }
}
