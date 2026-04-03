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

/** Resolve which stream names to subscribe to. */
export function resolveAllowedStreams(streams: ZulipStreamConfig): string[] {
  if (!streams?.allowed?.length) return [];
  return streams.allowed;
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
