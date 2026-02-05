// Detection Service - Orchestrates detection jobs

import prisma from "@/lib/prisma";
import { getEndpointsToTest, fetchModels } from "@/lib/detection";
import { addDetectionJobsBulk, getQueueStats, getTestingModelIds, clearStoppedFlag } from "./queue";
import type { DetectionJobData } from "@/lib/detection/types";
import { EndpointType } from "@/generated/prisma";

/**
 * Trigger detection for all enabled channels
 * Optionally sync models from remote API before detection
 */
export async function triggerFullDetection(syncModelsFirst: boolean = false): Promise<{
  channelCount: number;
  modelCount: number;
  jobIds: string[];
  syncResults?: { channelId: string; added: number; total: number }[];
}> {

  // Clear stopped flag from previous detection stop
  await clearStoppedFlag();

  // Fetch all enabled channels
  const channels = await prisma.channel.findMany({
    where: { enabled: true },
  });

  // Reset all models status to "untested" state before detection
  // This clears the UI display while preserving checkLogs history
  const channelIds = channels.map((c) => c.id);
  if (channelIds.length > 0) {
    await prisma.model.updateMany({
      where: { channelId: { in: channelIds } },
      data: {
        lastStatus: null,
        lastLatency: null,
        lastCheckedAt: null,
        detectedEndpoints: [],
      },
    });
  }

  // Optionally sync models from remote API first
  let syncResults: { channelId: string; added: number; total: number }[] | undefined;
  if (syncModelsFirst) {
    syncResults = [];
    for (const channel of channels) {
      try {
        const result = await syncChannelModels(channel.id);
        syncResults.push({
          channelId: channel.id,
          added: result.added,
          total: result.total,
        });
      } catch (error) {
      }
    }
  }

  // Re-fetch channels with updated models
  const channelsWithModels = await prisma.channel.findMany({
    where: { enabled: true },
    include: {
      models: {
        select: {
          id: true,
          modelName: true,
          detectedEndpoints: true,
        },
      },
    },
  });

  const jobs: DetectionJobData[] = [];

  for (const channel of channelsWithModels) {
    for (const model of channel.models) {
      // Get all endpoints to test for this model (CHAT + CLI if applicable)
      const endpointsToTest = getEndpointsToTest(model.modelName);

      for (const endpointType of endpointsToTest) {
        jobs.push({
          channelId: channel.id,
          modelId: model.id,
          modelName: model.modelName,
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
          proxy: channel.proxy,
          endpointType,
        });
      }
    }
  }

  if (jobs.length === 0) {
    return { channelCount: 0, modelCount: 0, jobIds: [], syncResults };
  }

  // Add all jobs to queue
  const jobIds = await addDetectionJobsBulk(jobs);

  return {
    channelCount: channelsWithModels.length,
    modelCount: jobs.length,
    jobIds,
    syncResults,
  };
}

/**
 * Trigger detection for a specific channel
 * @param channelId - The channel ID
 * @param modelIds - Optional array of model IDs to test (for filtered testing)
 */
export async function triggerChannelDetection(
  channelId: string,
  modelIds?: string[]
): Promise<{
  modelCount: number;
  jobIds: string[];
}> {

  // Clear stopped flag from previous detection stop
  await clearStoppedFlag();

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: {
      models: {
        select: {
          id: true,
          modelName: true,
          detectedEndpoints: true,
        },
      },
    },
  });

  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  if (!channel.enabled) {
    throw new Error(`Channel is disabled: ${channelId}`);
  }

  // Filter models if modelIds provided
  const modelsToTest = modelIds
    ? channel.models.filter((m) => modelIds.includes(m.id))
    : channel.models;

  // Reset models status to "untested" state before detection
  if (modelsToTest.length > 0) {
    const modelIdsToReset = modelsToTest.map((m) => m.id);
    await prisma.model.updateMany({
      where: { id: { in: modelIdsToReset } },
      data: {
        lastStatus: null,
        lastLatency: null,
        lastCheckedAt: null,
        detectedEndpoints: [],
      },
    });
  }

  const jobs: DetectionJobData[] = [];

  for (const model of modelsToTest) {
    // Get all endpoints to test for this model
    const endpointsToTest = getEndpointsToTest(model.modelName);

    for (const endpointType of endpointsToTest) {
      jobs.push({
        channelId: channel.id,
        modelId: model.id,
        modelName: model.modelName,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        proxy: channel.proxy,
        endpointType,
      });
    }
  }

  if (jobs.length === 0) {
    return { modelCount: 0, jobIds: [] };
  }

  const jobIds = await addDetectionJobsBulk(jobs);

  return { modelCount: jobs.length, jobIds };
}

/**
 * Trigger detection for a specific model (all endpoints)
 */
export async function triggerModelDetection(modelId: string): Promise<{
  jobIds: string[];
}> {

  // Clear stopped flag from previous detection stop
  await clearStoppedFlag();

  const model = await prisma.model.findUnique({
    where: { id: modelId },
    include: { channel: true },
  });

  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }

  if (!model.channel.enabled) {
    throw new Error(`Channel is disabled: ${model.channel.id}`);
  }

  // Reset model status to "untested" state before detection
  await prisma.model.update({
    where: { id: modelId },
    data: {
      lastStatus: null,
      lastLatency: null,
      lastCheckedAt: null,
      detectedEndpoints: [],
    },
  });

  // Get all endpoints to test for this model
  const endpointsToTest = getEndpointsToTest(model.modelName);

  const jobs: DetectionJobData[] = endpointsToTest.map((endpointType) => ({
    channelId: model.channel.id,
    modelId: model.id,
    modelName: model.modelName,
    baseUrl: model.channel.baseUrl,
    apiKey: model.channel.apiKey,
    proxy: model.channel.proxy,
    endpointType,
  }));

  const jobIds = await addDetectionJobsBulk(jobs);

  return { jobIds };
}

/**
 * Sync models from channel's /v1/models endpoint
 */
export async function syncChannelModels(channelId: string): Promise<{
  added: number;
  removed: number;
  total: number;
}> {

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
  });

  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  // Fetch models from API
  const result = await fetchModels(channel.baseUrl, channel.apiKey, channel.proxy);

  if (result.error) {
    throw new Error(`获取模型列表失败: ${result.error}`);
  }

  const remoteModels = result.models;

  if (remoteModels.length === 0) {
    return { added: 0, removed: 0, total: 0 };
  }

  // Get existing models
  const existingModels = await prisma.model.findMany({
    where: { channelId },
    select: { modelName: true },
  });

  const existingNames = new Set(existingModels.map((m) => m.modelName));
  const remoteNames = new Set(remoteModels);

  // Find models to add
  const toAdd = remoteModels.filter((name) => !existingNames.has(name));

  // Find models to remove (optional - could be kept for historical data)
  const toRemove = Array.from(existingNames).filter((name) => !remoteNames.has(name));

  // Add new models with empty detectedEndpoints (will be populated after testing)
  if (toAdd.length > 0) {
    await prisma.model.createMany({
      data: toAdd.map((modelName) => ({
        channelId,
        modelName,
      })),
      skipDuplicates: true,
    });
  }

  // Optionally remove stale models (disabled by default to preserve history)
  // if (toRemove.length > 0) {
  //   await prisma.model.deleteMany({
  //     where: {
  //       channelId,
  //       modelName: { in: toRemove },
  //     },
  //   });
  // }

  const total = remoteModels.length;

  return {
    added: toAdd.length,
    removed: 0, // Not actually removing
    total,
  };
}

/**
 * Get detection progress
 */
export async function getDetectionProgress() {
  const [stats, testingModelIds] = await Promise.all([
    getQueueStats(),
    getTestingModelIds(),
  ]);

  return {
    ...stats,
    isRunning: stats.active > 0 || stats.waiting > 0,
    progress:
      stats.total > 0 || stats.completed > 0 || stats.failed > 0
        ? Math.round(((stats.completed + stats.failed) / (stats.total + stats.completed + stats.failed)) * 100)
        : 0,
    testingModelIds,
  };
}

/**
 * Trigger detection for selected channels/models (scheduled detection)
 * @param channelIds - Array of channel IDs to test (null = all enabled channels)
 * @param modelIdsByChannel - Map of channel IDs to model IDs to test (null = all models per channel)
 */
export async function triggerSelectiveDetection(
  channelIds: string[] | null,
  modelIdsByChannel: Record<string, string[]> | null
): Promise<{
  channelCount: number;
  modelCount: number;
  jobIds: string[];
  syncResults?: { channelId: string; added: number; total: number }[];
}> {

  // Clear stopped flag from previous detection stop
  await clearStoppedFlag();

  // If no specific channels selected, fall back to full detection
  if (!channelIds || channelIds.length === 0) {
    return triggerFullDetection(true);
  }

  // Fetch selected channels
  const channels = await prisma.channel.findMany({
    where: {
      id: { in: channelIds },
      enabled: true,
    },
  });

  if (channels.length === 0) {
    return { channelCount: 0, modelCount: 0, jobIds: [] };
  }

  // Sync models from remote API for selected channels
  const syncResults: { channelId: string; added: number; total: number }[] = [];
  for (const channel of channels) {
    try {
      const result = await syncChannelModels(channel.id);
      syncResults.push({
        channelId: channel.id,
        added: result.added,
        total: result.total,
      });
    } catch (error) {
    }
  }

  // Re-fetch channels with models
  const channelsWithModels = await prisma.channel.findMany({
    where: {
      id: { in: channelIds },
      enabled: true,
    },
    include: {
      models: {
        select: {
          id: true,
          modelName: true,
          detectedEndpoints: true,
        },
      },
    },
  });

  const jobs: DetectionJobData[] = [];

  for (const channel of channelsWithModels) {
    // Get models to test for this channel
    let modelsToTest = channel.models;

    // If specific models are selected for this channel, filter them
    if (modelIdsByChannel && modelIdsByChannel[channel.id]) {
      const selectedModelIds = modelIdsByChannel[channel.id];
      modelsToTest = channel.models.filter((m) => selectedModelIds.includes(m.id));
    }

    for (const model of modelsToTest) {
      const endpointsToTest = getEndpointsToTest(model.modelName);

      for (const endpointType of endpointsToTest) {
        jobs.push({
          channelId: channel.id,
          modelId: model.id,
          modelName: model.modelName,
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
          proxy: channel.proxy,
          endpointType,
        });
      }
    }
  }

  if (jobs.length === 0) {
    return { channelCount: 0, modelCount: 0, jobIds: [], syncResults };
  }

  const jobIds = await addDetectionJobsBulk(jobs);

  return {
    channelCount: channelsWithModels.length,
    modelCount: jobs.length,
    jobIds,
    syncResults,
  };
}
