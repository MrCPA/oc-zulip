/**
 * Shared utilities for the Zulip OpenClaw plugin.
 */

import type { ZulipStreamConfig } from "./types.js";

/** Strip HTML tags from Zulip message content to plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Escape special regex characters. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve which stream names to explicitly subscribe to (allowlist only). */
export function resolveAllowedStreams(streams: ZulipStreamConfig): string[] {
  if (!streams?.allowed?.length) return [];
  return streams.allowed;
}

/** Whether the config includes any stream listening (allowlist or all). */
export function hasStreamListening(streams: ZulipStreamConfig): boolean {
  if (!streams) return false;
  if (streams.policy === "all") return true;
  return (streams.allowed?.length ?? 0) > 0;
}

/** Check if a stream name is in the allowed list. */
export function isStreamAllowed(
  streamName: string,
  streams: ZulipStreamConfig
): boolean {
  if (!streams) return false;
  if (streams.policy === "all") return true;
  if (!streams.allowed) return false;
  const normalized = streamName.trim().toLowerCase();
  return streams.allowed.some((s) => s.trim().toLowerCase() === normalized);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
