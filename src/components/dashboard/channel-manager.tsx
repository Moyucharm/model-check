// Channel manager component - Add, edit, delete, sync channels

"use client";

import { useState, useEffect, useCallback, FormEvent } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  Settings,
  Copy,
  Check,
  Download,
  Upload,
  Cloud,
  Key,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useToast } from "@/components/ui/toast";
import { ModelFilterModal } from "@/components/dashboard/model-filter-modal";
import { cn } from "@/lib/utils";

interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  enabled: boolean;
  models?: { lastStatus: boolean | null }[];
  sortOrder?: number;
  keyMode?: string;
  _count?: { models: number; channelKeys: number };
}

interface ChannelManagerProps {
  onUpdate: () => void;
  className?: string;
}

interface ChannelFormData {
  name: string;
  baseUrl: string;
  proxy: string;
  multiKeys: string;
}

interface ChannelKeyInfo {
  id: string;
  maskedKey: string;
  fullKey: string;
  lastValid: boolean | null;
}

interface ValidateResult {
  keyId: string | null;
  maskedKey: string;
  valid: boolean;
  modelCount: number;
  models: string[];
  error?: string;
}

const initialFormData: ChannelFormData = {
  name: "",
  baseUrl: "",
  proxy: "",
  multiKeys: "",
};

function getChannelBorderClass(channel: Channel): string {
  if ((channel._count?.models ?? 0) === 0) {
    return "border-red-500";
  }

  const statuses = channel.models?.map((m) => m.lastStatus) || [];
  if (statuses.length === 0) {
    return "border-border";
  }

  const availableCount = statuses.filter((status) => status === true).length;
  const unavailableCount = statuses.filter((status) => status === false).length;

  if (availableCount === statuses.length) {
    return "border-green-500";
  }

  if (unavailableCount === statuses.length) {
    return "border-red-500";
  }

  if (availableCount > 0 && availableCount < statuses.length) {
    return "border-yellow-500";
  }

  return "border-border";
}

export function ChannelManager({ onUpdate, className }: ChannelManagerProps) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [isExpanded, setIsExpanded] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [formData, setFormData] = useState<ChannelFormData>(initialFormData);
  const [submitting, setSubmitting] = useState(false);

  // Sync state
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  // Per-channel sync status message (shown on the channel card)
  const [syncStatus, setSyncStatus] = useState<Record<string, { message: string; type: "success" | "error" }>>({});
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Copy API key state
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Import/Export state
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [importText, setImportText] = useState("");

  // Channel keys info (for multi-key edit display)
  const [channelKeysInfo, setChannelKeysInfo] = useState<ChannelKeyInfo[]>([]);
  const [validating, setValidating] = useState(false);
  const [validateResults, setValidateResults] = useState<ValidateResult[]>([]);
  const [maskedApiKey, setMaskedApiKey] = useState<string>("");

  // Key management in edit modal
  const [keyViewMode, setKeyViewMode] = useState<"list" | "edit">("list");
  const [newSingleKey, setNewSingleKey] = useState("");
  const [addingSingleKey, setAddingSingleKey] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [mainKeyFull, setMainKeyFull] = useState<string>("");
  const [editingKeyTarget, setEditingKeyTarget] = useState<string | null>(null); // "main" | keyId
  const [editKeyValue, setEditKeyValue] = useState("");
  const [savingKeys, setSavingKeys] = useState(false);

  // Model filter modal state
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterChannels, setFilterChannels] = useState<{ id: string; name: string }[]>([]);
  const [syncAllMode, setSyncAllMode] = useState(false);
  const [filterFromEdit, setFilterFromEdit] = useState(false);

  // Pagination state
  const [channelPage, setChannelPage] = useState(1);
  const CHANNELS_PER_PAGE = 12;

  // 浜戦€氱煡 state
  const [showWebDAVModal, setShowWebDAVModal] = useState(false);
  const [webdavUploading, setWebdavUploading] = useState(false);
  const [webdavDownloading, setWebdavDownloading] = useState(false);
  const [webdavConfig, setWebdavConfig] = useState({
    url: "",
    username: "",
    password: "",
    filename: "channels.json",
  });
  const [webdavEnvConfigured, setWebdavEnvConfigured] = useState(false);
  const [webdavMode, setWebdavMode] = useState<"merge" | "replace">("merge");

  // Handle ESC key to close modals
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showModal) setShowModal(false);
        if (showImportModal) setShowImportModal(false);
        if (showWebDAVModal) setShowWebDAVModal(false);
        if (showFilterModal) setShowFilterModal(false);
      }
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [showModal, showImportModal, showWebDAVModal, showFilterModal]);

  // Load cloud sync config from localStorage and API
  useEffect(() => {
    const loadWebdavConfig = async () => {
      // First load from localStorage
      let config = {
        url: "",
        username: "",
        password: "",
        filename: "channels.json",
      };

      if (typeof window !== "undefined") {
        const saved = sessionStorage.getItem("webdav-config");
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            config = { ...config, ...parsed };
          } catch {
            // ignore parse errors
          }
        }
      }

      // Then try to get env config from API
      if (token) {
        try {
          const response = await fetch("/api/channel/webdav", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (response.ok) {
            const envConfig = await response.json();
            setWebdavEnvConfigured(envConfig.configured);

            // Use env config as default if localStorage is empty
            if (!config.url && envConfig.url) {
              config.url = envConfig.url;
            }
            if (!config.username && envConfig.username) {
              config.username = envConfig.username;
            }
            if (!config.filename && envConfig.filename) {
              config.filename = envConfig.filename;
            }
            // Don't load password from env for security, but show hint
          }
        } catch {
          // ignore API errors
        }
      }

      setWebdavConfig(config);
    };

    loadWebdavConfig();
  }, [token]);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // Fetch channels
  const fetchChannels = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/channel", {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal,
      });
      if (!response.ok) throw new Error("鑾峰彇娓犻亾鍒楄〃澶辫触");
      const data = await response.json();
      if (!signal?.aborted) {
        setChannels(data.channels || []);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : "鏈煡閿欒");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (isExpanded && token) {
      const controller = new AbortController();
      fetchChannels(controller.signal);
      return () => controller.abort();
    }
  }, [isExpanded, token, fetchChannels]);

  // Open add modal
  const handleAdd = () => {
    setEditingChannel(null);
    setFormData(initialFormData);
    setMaskedApiKey("");
    setMainKeyFull("");
    setChannelKeysInfo([]);
    setValidateResults([]);
    setShowModal(true);
  };

  // Open edit modal
  const handleEdit = async (channel: Channel) => {
    setEditingChannel(channel);
    setMaskedApiKey(channel.apiKey);
    setMainKeyFull("");
    setFormData({
      name: channel.name,
      baseUrl: channel.baseUrl,
      proxy: channel.proxy || "",
      multiKeys: "",
    });
    setChannelKeysInfo([]);
    setValidateResults([]);
    setKeyViewMode("list");
    setNewSingleKey("");
    setEditingKeyTarget(null);
    setShowModal(true);
    // Load existing keys (full values) + main key
    try {
      const [keysRes, mainKeyRes] = await Promise.all([
        fetch(`/api/channel/${channel.id}/keys`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`/api/channel/${channel.id}/key`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (keysRes.ok) {
        const data = await keysRes.json();
        if (data.keys?.length > 0) {
          setChannelKeysInfo(data.keys.map((k: { id: string; maskedKey: string; fullKey: string; lastValid?: boolean | null }) => ({
            id: k.id,
            maskedKey: k.maskedKey,
            fullKey: k.fullKey,
            lastValid: k.lastValid ?? null,
          })));
        }
      }
      if (mainKeyRes.ok) {
        const data = await mainKeyRes.json();
        if (data.apiKey) {
          setMainKeyFull(data.apiKey);
        }
      }
    } catch {
      // ignore
    }
  };

  // Submit form (create or update)
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (editingChannel) {
        // Update
        const updateBody: Record<string, unknown> = {
          id: editingChannel.id,
          name: formData.name,
          baseUrl: formData.baseUrl,
          proxy: formData.proxy || null,
          keyMode: "multi",
        };

        // Send keys if textarea has content (works in both edit and list mode after editing)
        let keysSubmitted = false;
        if (formData.multiKeys.trim()) {
          const keyList = formData.multiKeys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
          if (keyList.length > 0) {
            updateBody.apiKey = keyList[0];
            updateBody.keys = formData.multiKeys;
            keysSubmitted = true;
          }
        }
        // In list mode, keys are managed individually via API, no need to send

        const response = await fetch("/api/channel", {
          method: "PUT",
          headers,
          body: JSON.stringify(updateBody),
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "鏇存柊娓犻亾澶辫触");
        }

        setShowModal(false);
        // 鍙湁鏈鎻愪氦浜?keys 鎵嶆墦寮€妯″瀷閫夋嫨椤甸潰锛屽惁鍒欑洿鎺ヤ繚瀛樺叧闂?
        if (keysSubmitted) {
          setFilterChannels([{ id: editingChannel.id, name: editingChannel.name }]);
          setFilterFromEdit(true);
          setSyncAllMode(false);
          setShowFilterModal(true);
        }
      } else {
        // Create - always use textarea
        const keyList = formData.multiKeys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
        if (keyList.length === 0) {
          throw new Error("璇疯嚦灏戣緭鍏ヤ竴涓?API Key");
        }
        const createBody: Record<string, unknown> = {
          name: formData.name,
          baseUrl: formData.baseUrl,
          apiKey: keyList[0],
          proxy: formData.proxy || null,
          keyMode: "multi",
          keys: formData.multiKeys,
        };

        const response = await fetch("/api/channel", {
          method: "POST",
          headers,
          body: JSON.stringify(createBody),
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "鍒涘缓娓犻亾澶辫触");
        }

        const createData = await response.json();
        if (createData.channel?.id) {
          setShowModal(false);
          setFilterChannels([{ id: createData.channel.id, name: formData.name }]);
          setFilterFromEdit(false);
          setSyncAllMode(false);
          setShowFilterModal(true);
        } else {
          setShowModal(false);
        }
      }

      fetchChannels();
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "鎿嶄綔澶辫触");
    } finally {
      setSubmitting(false);
    }
  };

  // Validate keys
  const handleValidateKeys = async () => {
    if (!editingChannel || validating) return;
    setValidating(true);
    setValidateResults([]);
    try {
      const res = await fetch(`/api/channel/${editingChannel.id}/validate-keys`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error("楠岃瘉澶辫触");
      const data = await res.json();
      const results: ValidateResult[] = data.results || [];
      setValidateResults(results);
      // Update channelKeysInfo lastValid based on results
      setChannelKeysInfo((prev) =>
        prev.map((k) => {
          const result = results.find((r) => r.keyId === k.id);
          if (result) return { ...k, lastValid: result.valid };
          return k;
        })
      );
      // Simplified result toast
      const validCount = results.filter((r) => r.valid).length;
      const invalidCount = results.filter((r) => !r.valid).length;
      toast(`Validation complete: ${validCount} valid, ${invalidCount} invalid`, validCount > 0 ? "success" : "error");
    } catch (err) {
      toast(err instanceof Error ? err.message : "楠岃瘉澶辫触", "error");
    } finally {
      setValidating(false);
    }
  };

  // Add single key to existing channel
  const handleAddSingleKey = async () => {
    if (!editingChannel || !newSingleKey.trim() || addingSingleKey) return;
    setAddingSingleKey(true);
    try {
      const res = await fetch(`/api/channel/${editingChannel.id}/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ apiKey: newSingleKey.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "娣诲姞澶辫触");
      }
      const data = await res.json();
      const fullKeyValue = newSingleKey.trim();
      setChannelKeysInfo((prev) => [
        ...prev,
        {
          id: data.key.id,
          maskedKey: data.key.apiKey,
          fullKey: fullKeyValue,
          lastValid: null,
        },
      ]);
      setNewSingleKey("");
      toast("Key added", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "娣诲姞澶辫触", "error");
    } finally {
      setAddingSingleKey(false);
    }
  };

  // Delete single key
  const handleDeleteSingleKey = async (keyId: string) => {
    if (!editingChannel) return;
    setDeletingKeyId(keyId);
    try {
      const res = await fetch(`/api/channel/${editingChannel.id}/keys?keyId=${keyId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error("鍒犻櫎澶辫触");
      setChannelKeysInfo((prev) => prev.filter((k) => k.id !== keyId));
      setValidateResults((prev) => prev.filter((r) => r.keyId !== keyId));
      toast("Key deleted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "鍒犻櫎澶辫触", "error");
    } finally {
      setDeletingKeyId(null);
    }
  };

  // Delete main key: promote first extra key to main, then delete it from channelKey
  const [deletingMainKey, setDeletingMainKey] = useState(false);
  const handleDeleteMainKey = async () => {
    if (!editingChannel || deletingMainKey) return;
    if (channelKeysInfo.length === 0) {
      toast("No extra key available to promote", "error");
      return;
    }
    setDeletingMainKey(true);
    try {
      const firstExtra = channelKeysInfo[0];
      // Promote first extra key to main key
      const res = await fetch("/api/channel", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id: editingChannel.id, apiKey: firstExtra.fullKey }),
      });
      if (!res.ok) throw new Error("鏇存柊澶辫触");
      // Delete the promoted key from channelKey table
      await fetch(`/api/channel/${editingChannel.id}/keys?keyId=${firstExtra.id}`, {
        method: "DELETE",
        headers,
      });
      // Update local state
      setMainKeyFull(firstExtra.fullKey);
      const masked = firstExtra.fullKey.length > 12
        ? firstExtra.fullKey.slice(0, 8) + "..." + firstExtra.fullKey.slice(-4)
        : "***";
      setMaskedApiKey(masked);
      setChannelKeysInfo((prev) => prev.filter((k) => k.id !== firstExtra.id));
      toast("涓?Key 宸插垹闄わ紝宸叉彁鍗囦笅涓€涓?Key 涓轰富 Key", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "鍒犻櫎澶辫触", "error");
    } finally {
      setDeletingMainKey(false);
    }
  };

  // Batch delete invalid keys
  const handleBatchDeleteInvalid = async () => {
    if (!editingChannel) return;
    const invalidKeys = channelKeysInfo.filter((k) => k.lastValid === false);
    if (invalidKeys.length === 0) return;
    setBatchDeleting(true);
    let deleted = 0;
    for (const k of invalidKeys) {
      try {
        await fetch(`/api/channel/${editingChannel.id}/keys?keyId=${k.id}`, {
          method: "DELETE",
          headers,
        });
        deleted++;
      } catch {
        // continue
      }
    }
    const deletedIds = new Set(invalidKeys.map((k) => k.id));
    setChannelKeysInfo((prev) => prev.filter((k) => !deletedIds.has(k.id)));
    setValidateResults((prev) => prev.filter((r) => !r.keyId || !deletedIds.has(r.keyId)));
    toast(`宸插垹闄?${deleted} 涓棤鏁?Key`, "success");
    setBatchDeleting(false);
  };

  // Save inline key edit
  const handleEditKeySave = async () => {
    if (!editingChannel || !editingKeyTarget || !editKeyValue.trim()) return;
    try {
      if (editingKeyTarget === "main") {
        // Update main key via channel API
        const res = await fetch("/api/channel", {
          method: "PUT",
          headers,
          body: JSON.stringify({ id: editingChannel.id, apiKey: editKeyValue.trim() }),
        });
        if (!res.ok) throw new Error("鏇存柊澶辫触");
        setMainKeyFull(editKeyValue.trim());
        const masked = editKeyValue.trim().length > 12
          ? editKeyValue.trim().slice(0, 8) + "..." + editKeyValue.trim().slice(-4)
          : "***";
        setMaskedApiKey(masked);
      } else {
        // Update extra key
        const res = await fetch(`/api/channel/${editingChannel.id}/keys`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ keyId: editingKeyTarget, apiKey: editKeyValue.trim() }),
        });
        if (!res.ok) throw new Error("鏇存柊澶辫触");
        const masked = editKeyValue.trim().length > 12
          ? editKeyValue.trim().slice(0, 8) + "..." + editKeyValue.trim().slice(-4)
          : "***";
        setChannelKeysInfo((prev) =>
          prev.map((k) =>
            k.id === editingKeyTarget
              ? { ...k, fullKey: editKeyValue.trim(), maskedKey: masked }
              : k
          )
        );
      }
      setEditingKeyTarget(null);
      toast("Key updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "鏇存柊澶辫触", "error");
    }
  };

  // Save keys from textarea (edit mode) without closing modal
  const handleSaveKeysFromTextarea = async () => {
    if (!editingChannel || savingKeys) return;
    const keyList = formData.multiKeys.split(/[,\n]/).map((k: string) => k.trim()).filter(Boolean);
    if (keyList.length === 0) {
      toast("璇疯嚦灏戣緭鍏ヤ竴涓?Key", "error");
      return;
    }
    setSavingKeys(true);
    try {
      const res = await fetch("/api/channel", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          id: editingChannel.id,
          apiKey: keyList[0],
          keyMode: "multi",
          keys: formData.multiKeys,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "淇濆瓨澶辫触");
      }
      toast(`宸蹭繚瀛?${keyList.length} 涓?Key`, "success");
      setFormData((prev) => ({ ...prev, multiKeys: "" }));
      fetchChannels();
    } catch (err) {
      toast(err instanceof Error ? err.message : "淇濆瓨澶辫触", "error");
    } finally {
      setSavingKeys(false);
    }
  };

  // Delete channel
  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`/api/channel?id=${id}`, {
        method: "DELETE",
        headers,
      });
      if (!response.ok) throw new Error("鍒犻櫎娓犻亾澶辫触");

      setDeleteConfirm(null);
      fetchChannels();
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "鍒犻櫎澶辫触");
    }
  };

  // Sync models
  const handleSync = async (id: string) => {
    setSyncingId(id);
    // Clear any previous status for this channel
    setSyncStatus((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const response = await fetch(`/api/channel/${id}/sync`, {
        method: "POST",
        headers,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "鍚屾澶辫触");

      toast(`Fetched ${data.total} models`, "success");
    } catch (err) {
      // Show error message on the channel card instead of global error
      const message = err instanceof Error ? err.message : "鍚屾澶辫触";
      setSyncStatus((prev) => ({ ...prev, [id]: { message, type: "error" } }));

      // Auto clear after 8 seconds for errors
      setTimeout(() => {
        setSyncStatus((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 8000);
    } finally {
      setSyncingId(null);
    }
  };

  const handleSyncAll = async () => {
    if (syncingAll || channels.length === 0) return;

    setSyncingAll(true);
    setError(null);

    try {
      const concurrency = 3;
      let totalModels = 0;
      let failedCount = 0;

      for (let index = 0; index < channels.length; index += concurrency) {
        const batch = channels.slice(index, index + concurrency);
        const results = await Promise.allSettled(
          batch.map(async (channel) => {
            const response = await fetch(`/api/channel/${channel.id}/sync`, {
              method: "POST",
              headers,
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error(data.error || "鍚屾澶辫触");
            }
            return Number(data.total) || 0;
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            totalModels += result.value;
          } else {
            failedCount += 1;
          }
        }
      }

      if (failedCount > 0) {
        toast(`Sync finished: ${totalModels} models fetched, ${failedCount} channels failed`, "error");
      } else {
        toast(`Sync finished: ${totalModels} models fetched`, "success");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "鍏ㄩ噺鍚屾澶辫触", "error");
    } finally {
      setSyncingAll(false);
      onUpdate();
    }
  };

  const persistChannelOrder = async (orderedChannels: Channel[]) => {
    const orders = orderedChannels.map((channel, index) => ({
      id: channel.id,
      sortOrder: index,
    }));

    const response = await fetch("/api/channel", {
      method: "PUT",
      headers,
      body: JSON.stringify({ orders }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "鎺掑簭淇濆瓨澶辫触");
    }
  };

  const handleDropChannel = async (targetChannelId: string) => {
    if (!draggingChannelId || draggingChannelId === targetChannelId) {
      setDraggingChannelId(null);
      return;
    }

    const previousChannels = channels;
    const fromIndex = previousChannels.findIndex((channel) => channel.id === draggingChannelId);
    const toIndex = previousChannels.findIndex((channel) => channel.id === targetChannelId);

    if (fromIndex < 0 || toIndex < 0) {
      setDraggingChannelId(null);
      return;
    }

    const nextChannels = [...previousChannels];
    const [moved] = nextChannels.splice(fromIndex, 1);
    nextChannels.splice(toIndex, 0, moved);

    setChannels(nextChannels);
    setDraggingChannelId(null);

    try {
      await persistChannelOrder(nextChannels);
      onUpdate();
    } catch (err) {
      setChannels(previousChannels);
      toast(err instanceof Error ? err.message : "鎺掑簭澶辫触", "error");
    }
  };

  // Copy API key
  const handleCopyApiKey = async (id: string) => {
    setCopyingId(id);
    try {
      const response = await fetch(`/api/channel/${id}/key`, { headers });
      if (!response.ok) throw new Error("鑾峰彇 API Key 澶辫触");
      const data = await response.json();
      await navigator.clipboard.writeText(data.apiKey);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "澶嶅埗澶辫触");
    } finally {
      setCopyingId(null);
    }
  };

  // Export channels
  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/channel/export", { headers });
      if (!response.ok) throw new Error("瀵煎嚭澶辫触");
      const data = await response.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `channels-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("瀵煎嚭鎴愬姛", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "瀵煎嚭澶辫触", "error");
    } finally {
      setExporting(false);
    }
  };

  // Import channels
  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const data = JSON.parse(importText);
      const response = await fetch("/api/channel/import", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...data, mode: importMode }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "瀵煎叆澶辫触");
      }
      const result = await response.json();
      setShowImportModal(false);
      setImportText("");
      fetchChannels();
      onUpdate();
      const syncInfo = result.syncedModels > 0 ? `, 鍚屾妯″瀷 ${result.syncedModels}` : "";
      toast(`瀵煎叆鎴愬姛: 鏂板 ${result.imported}, 鏇存柊 ${result.updated}, 璺宠繃 ${result.skipped}${syncInfo}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "瀵煎叆澶辫触", "error");
    } finally {
      setImporting(false);
    }
  };

  // Handle file import
  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setImportText(event.target?.result as string);
    };
    reader.readAsText(file);
  };

  // 浜戦€氱煡 sync
  const handleWebDAVSync = async (action: "upload" | "download") => {
    if (action === "upload") {
      setWebdavUploading(true);
    } else {
      setWebdavDownloading(true);
    }
    setError(null);

    // Save config to sessionStorage before request (password excluded for security)
    // Note: Password is not persisted - user must re-enter or rely on env variable
    sessionStorage.setItem("webdav-config", JSON.stringify({
      url: webdavConfig.url,
      username: webdavConfig.username,
      filename: webdavConfig.filename,
    }));

    try {
      const response = await fetch("/api/channel/webdav", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action,
          ...webdavConfig,
          mode: webdavMode,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "鍚屾澶辫触");

      if (action === "download") {
        fetchChannels();
        onUpdate();
        const syncInfo = result.syncedModels > 0 ? `, 鍚屾妯″瀷 ${result.syncedModels}` : "";
        const dupInfo = result.duplicates > 0 ? `, 閲嶅璺宠繃 ${result.duplicates}` : "";
        toast(`涓嬭浇鎴愬姛: 鏂板 ${result.imported}, 璺宠繃 ${result.skipped}${dupInfo}${syncInfo}`, "success");
      } else {
        const mergeInfo = result.mergedFromRemote > 0 ? `, 鍚堝苟杩滅 ${result.mergedFromRemote}` : "";
        toast(`涓婁紶鎴愬姛: 鏈湴 ${result.localCount} 涓笭閬? 鍏变笂浼?${result.totalUploaded} 涓?{mergeInfo}`, "success");
      }
      setShowWebDAVModal(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "鍚屾澶辫触", "error");
    } finally {
      if (action === "upload") {
        setWebdavUploading(false);
      } else {
        setWebdavDownloading(false);
      }
    }
  };

  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      {/* Header - Toggle */}
      <div className="flex items-center gap-2 p-4 overflow-hidden">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-center justify-between gap-2 hover:bg-accent/50 px-3 py-2 -ml-3 rounded transition-colors min-w-0"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Settings className="h-5 w-5 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">娓犻亾绠＄悊</span>
            {channels.length > 0 && (
              <span className="text-sm text-muted-foreground shrink-0">
                ({channels.length})
              </span>
            )}
          </div>
          {isExpanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
        </button>

        {/* Action buttons - compact on mobile */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Add channel button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleAdd();
            }}
            className="inline-flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            title="娣诲姞娓犻亾"
            aria-label="娣诲姞娓犻亾"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">娣诲姞</span>
          </button>

          {/* Import button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowImportModal(true);
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors"
            title="瀵煎叆娓犻亾"
            aria-label="瀵煎叆娓犻亾"
          >
            <Upload className="h-4 w-4" />
          </button>

          {/* Export button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleExport();
            }}
            disabled={exporting}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors disabled:opacity-50"
            title="瀵煎嚭娓犻亾"
            aria-label="瀵煎嚭娓犻亾"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          </button>

          {/* Sync all models button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSyncAllMode(true);
              setFilterFromEdit(false);
              setFilterChannels(channels.map((c) => ({ id: c.id, name: c.name })));
              setShowFilterModal(true);
            }}
            disabled={channels.length === 0}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors disabled:opacity-50"
            title="鍏ㄩ噺鍚屾妯″瀷"
            aria-label="鍏ㄩ噺鍚屾妯″瀷"
          >
            <RefreshCw className="h-4 w-4" />
          </button>

          {/* 浜戦€氱煡鎸夐挳 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowWebDAVModal(true);
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-input bg-background hover:bg-accent transition-colors"
            title="浜戦€氱煡"
            aria-label="浜戦€氱煡"
          >
            <Cloud className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Error */}
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Channel list */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              鏆傛棤娓犻亾锛岀偣鍑讳笂鏂规寜閽坊鍔?
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {channels
                  .slice((channelPage - 1) * CHANNELS_PER_PAGE, channelPage * CHANNELS_PER_PAGE)
                  .map((channel) => (
                <div
                  key={channel.id}
                  draggable
                  onDragStart={() => setDraggingChannelId(channel.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDropChannel(channel.id)}
                  onDragEnd={() => setDraggingChannelId(null)}
                  className={cn(
                    "flex flex-col p-3 rounded-md border bg-background",
                    getChannelBorderClass(channel),
                    draggingChannelId === channel.id && "opacity-60"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="font-medium truncate">
                        {channel.name}
                      </span>
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {channel.baseUrl}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {channel._count?.models || 0} 涓ā鍨?
                    {(channel._count?.channelKeys ?? 0) > 0 && (
                      <> | <Key className="inline h-3 w-3" /> {(channel._count?.channelKeys ?? 0) + 1} 涓?Key</>
                    )}
                    {" "}| Key: {channel.apiKey}
                  </div>
                  {/* Sync status message */}
                  {syncStatus[channel.id] && (
                    <div
                      className={cn(
                        "text-xs mt-2 px-2 py-1 rounded",
                        syncStatus[channel.id].type === "success"
                          ? "bg-green-500/10 text-green-600 dark:text-green-400"
                          : "bg-destructive/10 text-destructive"
                      )}
                    >
                      {syncStatus[channel.id].message}
                    </div>
                  )}
                  <div className="flex items-center gap-1 mt-3 pt-2 border-t border-border">
                    <button
                      onClick={() => handleCopyApiKey(channel.id)}
                      disabled={copyingId === channel.id}
                      className="p-2 rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                      title="澶嶅埗 API Key"
                      aria-label="澶嶅埗 API Key"
                    >
                      {copyingId === channel.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : copiedId === channel.id ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                    <button
                      onClick={() => {
                        setSyncAllMode(false);
                        setFilterFromEdit(false);
                        setFilterChannels([{ id: channel.id, name: channel.name }]);
                        setShowFilterModal(true);
                      }}
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                      title="鍚屾妯″瀷鍒楄〃"
                      aria-label="鍚屾妯″瀷鍒楄〃"
                    >
                      <RefreshCw className="h-4 w-4 text-blue-500" />
                    </button>
                    <button
                      onClick={() => handleEdit(channel)}
                      className="p-2 rounded-md hover:bg-accent transition-colors"
                      title="缂栬緫"
                      aria-label="缂栬緫娓犻亾"
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>
                    {deleteConfirm === channel.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleDelete(channel.id)}
                          className="px-2 py-1 text-xs rounded bg-destructive text-destructive-foreground"
                        >
                          纭
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="px-2 py-1 text-xs rounded bg-muted"
                        >
                          鍙栨秷
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(channel.id)}
                        className="p-2 rounded-md hover:bg-accent transition-colors"
                        title="鍒犻櫎"
                        aria-label="鍒犻櫎娓犻亾"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {channels.length > CHANNELS_PER_PAGE && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  onClick={() => setChannelPage((p) => Math.max(1, p - 1))}
                  disabled={channelPage <= 1}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                    channelPage <= 1
                      ? "text-muted-foreground cursor-not-allowed"
                      : "text-foreground hover:bg-accent"
                  )}
                >
                  <ChevronUp className="h-4 w-4 rotate-[-90deg]" />
                </button>
                <span className="text-sm text-muted-foreground">
                  {channelPage} / {Math.ceil(channels.length / CHANNELS_PER_PAGE)}
                </span>
                <button
                  onClick={() => setChannelPage((p) => Math.min(Math.ceil(channels.length / CHANNELS_PER_PAGE), p + 1))}
                  disabled={channelPage >= Math.ceil(channels.length / CHANNELS_PER_PAGE)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                    channelPage >= Math.ceil(channels.length / CHANNELS_PER_PAGE)
                      ? "text-muted-foreground cursor-not-allowed"
                      : "text-foreground hover:bg-accent"
                  )}
                >
                  <ChevronDown className="h-4 w-4 rotate-[-90deg]" />
                </button>
              </div>
            )}
          </>
          )}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="channel-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 id="channel-modal-title" className="text-lg font-semibold">
                {editingChannel ? "缂栬緫娓犻亾" : "娣诲姞娓犻亾"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="鍏抽棴"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal form */}
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  娓犻亾鍚嶇О <span className="text-destructive">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="OpenAI"
                  required
                />
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  Base URL <span className="text-destructive">*</span>
                </label>
                <input
                  type="url"
                  value={formData.baseUrl}
                  onChange={(e) =>
                    setFormData({ ...formData, baseUrl: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="https://api.openai.com"
                  required
                />
              </div>

              {/* API Key + View Toggle */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium">
                    API Key{" "}
                    {!editingChannel && (
                      <span className="text-destructive">*</span>
                    )}
                  </label>
                  <div className="flex items-center gap-3">
                    {/* View toggle (only when editing with existing keys) */}
                    {editingChannel && (channelKeysInfo.length > 0 || maskedApiKey) && (
                      <div className="flex items-center rounded-md border border-input bg-background text-xs overflow-hidden">
                        <button
                          type="button"
                          onClick={async () => {
                            if (keyViewMode === "edit" && editingChannel) {
                              // Reload keys from server when returning to list mode.
                              try {
                                const [keysRes, mainKeyRes] = await Promise.all([
                                  fetch(`/api/channel/${editingChannel.id}/keys`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                  }),
                                  fetch(`/api/channel/${editingChannel.id}/key`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                  }),
                                ]);
                                if (keysRes.ok) {
                                  const data = await keysRes.json();
                                  setChannelKeysInfo((data.keys || []).map((k: { id: string; maskedKey: string; fullKey: string; lastValid?: boolean | null }) => ({
                                    id: k.id,
                                    maskedKey: k.maskedKey,
                                    fullKey: k.fullKey,
                                    lastValid: k.lastValid ?? null,
                                  })));
                                }
                                if (mainKeyRes.ok) {
                                  const data = await mainKeyRes.json();
                                  if (data.apiKey) {
                                    setMainKeyFull(data.apiKey);
                                    const masked = data.apiKey.length > 12 ? data.apiKey.slice(0, 8) + "..." + data.apiKey.slice(-4) : "***";
                                    setMaskedApiKey(masked);
                                  }
                                }
                              } catch {
                                // Ignore reload failure, keep UI switch responsive.
                              }
                              setValidateResults([]);
                            }
                            setKeyViewMode("list");
                          }}
                          className={cn(
                            "px-2.5 py-1 transition-colors",
                            keyViewMode === "list"
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent"
                          )}
                        >
                          List
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const allKeys = [mainKeyFull, ...channelKeysInfo.map((k) => k.fullKey)]
                              .filter(Boolean)
                              .join("\n");
                            setFormData((prev) => ({ ...prev, multiKeys: allKeys }));
                            setKeyViewMode("edit");
                          }}
                          className={cn(
                            "px-2.5 py-1 transition-colors",
                            keyViewMode === "edit"
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent"
                          )}
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* List view (editing existing channel) */}
                {editingChannel && keyViewMode === "list" && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Total {channelKeysInfo.length + (maskedApiKey ? 1 : 0)} keys
                    </p>
                    <div className="rounded-md border border-border max-h-48 overflow-y-auto divide-y divide-border">
                      {/* Main key row */}
                      {mainKeyFull && (
                        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-blue-500/5 overflow-hidden">
                          {editingKeyTarget === "main" ? (
                            <>
                              <input
                                type="text"
                                value={editKeyValue}
                                onChange={(e) => setEditKeyValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); handleEditKeySave(); }
                                  if (e.key === "Escape") setEditingKeyTarget(null);
                                }}
                                className="flex-1 min-w-0 px-2 py-0.5 rounded border border-input bg-background text-xs font-mono"
                                autoFocus
                              />
                              <button type="button" onClick={handleEditKeySave} className="shrink-0 p-0.5 rounded hover:text-primary"><Check className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => setEditingKeyTarget(null)} className="shrink-0 p-0.5 rounded hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                            </>
                          ) : (
                            <>
                              <span className="text-xs font-mono flex-1 min-w-0 truncate select-all" title={mainKeyFull}>{mainKeyFull}</span>
                              <span className="text-xs text-blue-500 shrink-0">Main</span>
                              <button
                                type="button"
                                onClick={() => { setEditingKeyTarget("main"); setEditKeyValue(mainKeyFull); }}
                                className="shrink-0 p-0.5 rounded hover:text-primary transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={handleDeleteMainKey}
                                disabled={deletingMainKey}
                                className="shrink-0 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                                title={channelKeysInfo.length === 0 ? "娌℃湁鍏朵粬 Key 鍙彁鍗囷紝鏃犳硶鍒犻櫎" : "鍒犻櫎涓?Key锛屼笅涓€涓?Key 灏嗘彁鍗囦负涓?Key"}
                              >
                                {deletingMainKey ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {/* Extra keys */}
                      {channelKeysInfo.map((k) => (
                        <div
                          key={k.id}
                          className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 overflow-hidden",
                            k.lastValid === true
                              ? "bg-green-500/5"
                              : k.lastValid === false
                                ? "bg-red-500/5"
                                : ""
                          )}
                        >
                          {editingKeyTarget === k.id ? (
                            <>
                              <input
                                type="text"
                                value={editKeyValue}
                                onChange={(e) => setEditKeyValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); handleEditKeySave(); }
                                  if (e.key === "Escape") setEditingKeyTarget(null);
                                }}
                                className="flex-1 min-w-0 px-2 py-0.5 rounded border border-input bg-background text-xs font-mono"
                                autoFocus
                              />
                              <button type="button" onClick={handleEditKeySave} className="shrink-0 p-0.5 rounded hover:text-primary"><Check className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => setEditingKeyTarget(null)} className="shrink-0 p-0.5 rounded hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                            </>
                          ) : (
                            <>
                              <span className="text-xs font-mono flex-1 min-w-0 truncate select-all" title={k.fullKey}>{k.fullKey}</span>
                              <span
                                className={cn(
                                  "text-xs shrink-0",
                                  k.lastValid === true
                                    ? "text-green-600 dark:text-green-400"
                                    : k.lastValid === false
                                      ? "text-red-600 dark:text-red-400"
                                      : "text-muted-foreground"
                                )}
                              >
                                {k.lastValid === true ? "鏈夋晥" : k.lastValid === false ? "鏃犳晥" : ""}
                              </span>
                              <button
                                type="button"
                                onClick={() => { setEditingKeyTarget(k.id); setEditKeyValue(k.fullKey); }}
                                className="shrink-0 p-0.5 rounded hover:text-primary transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSingleKey(k.id)}
                                disabled={deletingKeyId === k.id}
                                className="shrink-0 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
                              >
                                {deletingKeyId === k.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleValidateKeys}
                        disabled={validating}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-input bg-background hover:bg-accent disabled:opacity-50 transition-colors"
                      >
                        {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        楠岃瘉鎵€鏈塊ey
                      </button>
                      {channelKeysInfo.some((k) => k.lastValid === false) && (
                        <button
                          type="button"
                          onClick={handleBatchDeleteInvalid}
                          disabled={batchDeleting}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-red-500/50 text-red-600 dark:text-red-400 bg-red-500/5 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
                        >
                          {batchDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          鍒犻櫎鏃犳晥Key
                        </button>
                      )}
                    </div>

                    {/* Add single key */}
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newSingleKey}
                        onChange={(e) => setNewSingleKey(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); handleAddSingleKey(); }
                        }}
                        className="flex-1 px-3 py-1.5 rounded-md border border-input bg-background text-sm font-mono"
                        placeholder="杈撳叆鏂?Key 娣诲姞..."
                      />
                      <button
                        type="button"
                        onClick={handleAddSingleKey}
                        disabled={addingSingleKey || !newSingleKey.trim()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {addingSingleKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        娣诲姞
                      </button>
                    </div>
                  </div>
                )}

                {/* Edit view (batch textarea) - for editing existing channel when toggled to edit, or always for create */}
                {(!editingChannel || (editingChannel && keyViewMode === "edit")) && (
                  <div className="space-y-2">
                    <textarea
                      value={formData.multiKeys}
                      onChange={(e) =>
                        setFormData({ ...formData, multiKeys: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm font-mono resize-none"
                      style={{ minHeight: "120px", maxHeight: "240px" }}
                      placeholder={editingChannel ? "Save to replace all keys, one per line" : "One key per line, first key is main"}
                    />
                    {editingChannel && (
                      <button
                        type="button"
                        onClick={handleSaveKeysFromTextarea}
                        disabled={savingKeys || !formData.multiKeys.trim()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {savingKeys ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        淇濆瓨 Key
                      </button>
                    )}
                    {!editingChannel && (
                      <p className="text-xs text-muted-foreground">
                        鏀寔涓€琛屼竴涓垨閫楀彿鍒嗛殧锛岀涓€涓狵ey涓轰富Key
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Proxy */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  浠ｇ悊鍦板潃
                </label>
                <input
                  type="text"
                  value={formData.proxy}
                  onChange={(e) =>
                    setFormData({ ...formData, proxy: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="http://... 鎴?socks5://...锛堝彲閫夛級"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  鏀寔 HTTP/HTTPS/SOCKS5 浠ｇ悊
                </p>
              </div>

              {/* Error in modal */}
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Submit */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
                >
                  鍙栨秷
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingChannel ? "淇濆瓨" : "娣诲姞"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowImportModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 id="import-modal-title" className="text-lg font-semibold">瀵煎叆娓犻亾</h2>
              <button
                onClick={() => setShowImportModal(false)}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="鍏抽棴"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Import mode */}
              <div>
                <label className="block text-sm font-medium mb-1">瀵煎叆妯″紡</label>
                <select
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value as "merge" | "replace")}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                >
                  <option value="merge">鍚堝苟锛堟洿鏂板悓鍚嶆笭閬擄級</option>
                  <option value="replace">鏇挎崲锛堝垹闄ゆ墍鏈夌幇鏈夋笭閬擄級</option>
                </select>
              </div>

              {/* File input */}
              <div>
                <label className="block text-sm font-medium mb-1">閫夋嫨鏂囦欢</label>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileImport}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>

              {/* JSON textarea */}
              <div>
                <label className="block text-sm font-medium mb-1">鎴栫矘璐?JSON</label>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background font-mono text-sm h-40"
                  placeholder='{"version":"1.0","channels":[...]}'
                />
              </div>

              {/* Error in modal */}
              {error && importing && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Submit */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
                >
                  鍙栨秷
                </button>
                <button
                  onClick={handleImport}
                  disabled={importing || !importText.trim()}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                  瀵煎叆
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 浜戦€氱煡 Modal */}
      {showWebDAVModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="webdav-modal-title"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setShowWebDAVModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-lg mx-4 bg-card rounded-lg shadow-lg border border-border max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 id="webdav-modal-title" className="text-lg font-semibold">浜戦€氱煡</h2>
              <button
                onClick={() => setShowWebDAVModal(false)}
                className="p-1 rounded-md hover:bg-accent transition-colors"
                aria-label="鍏抽棴"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Env config hint */}
              {webdavEnvConfigured && (
                <div className="p-3 rounded-md bg-green-500/10 border border-green-500/20 text-sm text-green-600 dark:text-green-400">
                  宸蹭粠鐜鍙橀噺鍔犺浇浜戦€氱煡閰嶇疆銆傚瘑鐮佺暀绌哄皢浣跨敤鐜鍙橀噺涓殑瀵嗙爜銆?
                </div>
              )}

              {/* Jianguoyun hint */}
              <div className="p-3 rounded-md bg-blue-500/10 border border-blue-500/20 text-sm text-blue-600 dark:text-blue-400">
                Jianguoyun users: create the target folder first on web, then use that folder URL. Use an app password, not your login password.
              </div>

              {/* WebDAV URL */}
              <div>
                <label className="block text-sm font-medium mb-1">
                  Service URL <span className="text-destructive">*</span>
                </label>
                <input
                  type="url"
                  value={webdavConfig.url}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, url: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="https://dav.jianguoyun.com/dav/your-folder"
                />
              </div>

              {/* Username */}
              <div>
                <label className="block text-sm font-medium mb-1">Username</label>
                <input
                  type="text"
                  value={webdavConfig.username}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, username: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="email or username"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-medium mb-1">Password</label>
                <input
                  type="password"
                  value={webdavConfig.password}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, password: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder={webdavEnvConfigured ? "Leave empty to use env password" : "App password"}
                />
              </div>

              {/* Filename */}
              <div>
                <label className="block text-sm font-medium mb-1">File path</label>
                <input
                  type="text"
                  value={webdavConfig.filename}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, filename: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  placeholder="channels.json"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Subfolders are supported, for example `backup/channels.json`.
                </p>
              </div>

              {/* Sync mode */}
              <div>
                <label className="block text-sm font-medium mb-1">Sync mode</label>
                <select
                  value={webdavMode}
                  onChange={(e) => setWebdavMode(e.target.value as "merge" | "replace")}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                >
                  <option value="merge">Merge (keep existing channels, add/update from remote)</option>
                  <option value="replace">Replace (clear local channels before import)</option>
                </select>
              </div>

              {/* Error in modal */}
              {error && (webdavUploading || webdavDownloading) && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowWebDAVModal(false)}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
                >
                  鍙栨秷
                </button>
                <button
                  onClick={() => handleWebDAVSync("download")}
                  disabled={webdavUploading || webdavDownloading || !webdavConfig.url}
                  className="px-4 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {webdavDownloading && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Download className="h-4 w-4" />
                  涓嬭浇
                </button>
                <button
                  onClick={() => handleWebDAVSync("upload")}
                  disabled={webdavUploading || webdavDownloading || !webdavConfig.url}
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {webdavUploading && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Upload className="h-4 w-4" />
                  涓婁紶
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Model Filter Modal - shown after save or sync */}
      {showFilterModal && filterChannels.length > 0 && (
        <ModelFilterModal
          channels={filterChannels}
          onClose={() => {
            setShowFilterModal(false);
            setFilterChannels([]);
            setSyncAllMode(false);
            setFilterFromEdit(false);
          }}
          onBack={filterFromEdit ? () => {
            setShowFilterModal(false);
            setFilterFromEdit(false);
            setShowModal(true);
          } : undefined}
          onSyncComplete={() => {
            fetchChannels();
            onUpdate();
          }}
        />
      )}
    </div>
  );
}
