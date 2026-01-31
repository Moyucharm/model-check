// Unit tests for detection strategy factory

import { describe, it, expect } from "vitest";
import { detectEndpointType, buildEndpointDetection } from "@/lib/detection/strategies";
import { EndpointType } from "@prisma/client";

describe("Detection Strategy Factory", () => {
  describe("detectEndpointType", () => {
    it("should route claude models to CLAUDE endpoint", () => {
      expect(detectEndpointType("claude-3-opus")).toBe(EndpointType.CLAUDE);
      expect(detectEndpointType("claude-3-sonnet")).toBe(EndpointType.CLAUDE);
      expect(detectEndpointType("claude-3.5-sonnet")).toBe(EndpointType.CLAUDE);
      expect(detectEndpointType("Claude-2")).toBe(EndpointType.CLAUDE);
    });

    it("should route gemini models to GEMINI endpoint", () => {
      expect(detectEndpointType("gemini-pro")).toBe(EndpointType.GEMINI);
      expect(detectEndpointType("gemini-1.5-flash")).toBe(EndpointType.GEMINI);
      expect(detectEndpointType("Gemini-Ultra")).toBe(EndpointType.GEMINI);
    });

    it("should route only gpt-5.1/gpt-5.2 models to CODEX endpoint", () => {
      // Only gpt-5.1 and gpt-5.2 series use CODEX
      expect(detectEndpointType("gpt-5.1")).toBe(EndpointType.CODEX);
      expect(detectEndpointType("gpt-5.1-turbo")).toBe(EndpointType.CODEX);
      expect(detectEndpointType("gpt-5.2")).toBe(EndpointType.CODEX);
      expect(detectEndpointType("gpt-5.2-preview")).toBe(EndpointType.CODEX);
    });

    it("should route other gpt/o1/o3/codex models to CHAT endpoint", () => {
      // gpt-4, gpt-3.5, gpt-4o, o1, o3, codex etc. should use CHAT, not CODEX
      expect(detectEndpointType("gpt-4")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("gpt-3.5-turbo")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("gpt-4o")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("gpt-4-turbo")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("o1-preview")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("o1-mini")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("o3-mini")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("codex-davinci")).toBe(EndpointType.CHAT);
    });

    it("should route other models to CHAT endpoint", () => {
      expect(detectEndpointType("llama-2-70b")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("mistral-7b")).toBe(EndpointType.CHAT);
      expect(detectEndpointType("qwen-7b")).toBe(EndpointType.CHAT);
    });
  });

  describe("buildEndpointDetection", () => {
    const baseUrl = "https://api.example.com";
    const apiKey = "test-key";

    it("should build correct Claude endpoint URL", () => {
      const endpoint = buildEndpointDetection(
        baseUrl,
        apiKey,
        "claude-3-opus",
        EndpointType.CLAUDE
      );

      expect(endpoint.url).toBe("https://api.example.com/v1/messages");
      expect(endpoint.headers["x-api-key"]).toBe(apiKey);
      expect(endpoint.headers["anthropic-version"]).toBe("2023-06-01");
      expect(endpoint.requestBody).toHaveProperty("model", "claude-3-opus");
      expect(endpoint.requestBody).toHaveProperty("messages");
    });

    it("should build correct Gemini endpoint URL", () => {
      const endpoint = buildEndpointDetection(
        baseUrl,
        apiKey,
        "gemini-pro",
        EndpointType.GEMINI
      );

      expect(endpoint.url).toBe(
        "https://api.example.com/v1beta/models/gemini-pro:generateContent"
      );
      expect(endpoint.headers["x-goog-api-key"]).toBe(apiKey);
      expect(endpoint.requestBody).toHaveProperty("contents");
    });

    it("should build correct Codex endpoint URL", () => {
      const endpoint = buildEndpointDetection(
        baseUrl,
        apiKey,
        "o1-preview",
        EndpointType.CODEX
      );

      expect(endpoint.url).toBe("https://api.example.com/v1/responses");
      expect(endpoint.headers["Authorization"]).toBe(`Bearer ${apiKey}`);
      expect(endpoint.requestBody).toHaveProperty("model", "o1-preview");
      expect(endpoint.requestBody).toHaveProperty("input");
    });

    it("should build correct Chat endpoint URL", () => {
      const endpoint = buildEndpointDetection(
        baseUrl,
        apiKey,
        "gpt-4",
        EndpointType.CHAT
      );

      expect(endpoint.url).toBe("https://api.example.com/v1/chat/completions");
      expect(endpoint.headers["Authorization"]).toBe(`Bearer ${apiKey}`);
      expect(endpoint.requestBody).toHaveProperty("model", "gpt-4");
      expect(endpoint.requestBody).toHaveProperty("messages");
    });

    it("should normalize base URL with trailing slash", () => {
      const endpoint = buildEndpointDetection(
        "https://api.example.com/",
        apiKey,
        "gpt-4",
        EndpointType.CHAT
      );

      expect(endpoint.url).toBe("https://api.example.com/v1/chat/completions");
    });
  });
});
