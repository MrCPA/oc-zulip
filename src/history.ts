import type { ZulipMessage } from "./client.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STRUCTURAL_BLOCK_TAGS = [
  "p",
  "div",
  "section",
  "article",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
];

export interface FormattedHistoryEntry {
  sender: string;
  body: string;
  timestamp: number;
}

export interface HistoryRenderConfig {
  botEmail: string;
  botName: string;
  mode: "dm" | "stream";
  includeTimestamps: boolean;
  maxMessageChars: number;
  maxTotalChars: number;
  recentExactCount: number;
  recentExactMaxChars: number;
  stream?: string;
  topic?: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function htmlToStructuredPlainText(value: string): string {
  let text = value;

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    const raw = decodeHtmlEntities(content.replace(/<[^>]+>/g, ""));
    return `\n\`\`\`\n${raw.trim()}\n\`\`\`\n`;
  });

  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => {
    const raw = decodeHtmlEntities(content.replace(/<[^>]+>/g, ""));
    return `\`${raw.trim()}\``;
  });

  for (const tag of STRUCTURAL_BLOCK_TAGS) {
    const escaped = escapeRegExp(tag);
    const open = new RegExp(`<${escaped}\\b[^>]*>`, "gi");
    const close = new RegExp(`</${escaped}>`, "gi");
    text = text.replace(open, tag === "li" ? "\n- " : "\n");
    text = text.replace(close, "\n");
  }

  text = decodeHtmlEntities(text.replace(/<[^>]+>/g, " "));
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function truncateExactText(value: string, maxChars: number): string {
  if (!value) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function normalizeHistoryText(value: string, maxChars: number): string {
  const normalized = htmlToStructuredPlainText(value).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 1) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatHistoryTimestamp(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}

function senderLabel(message: ZulipMessage, botEmail: string, botName: string): string {
  return message.sender_email === botEmail
    ? `${botName} (bot)`
    : message.sender_full_name || message.sender_email;
}

function trimFormattedHistoryEntries(
  entries: FormattedHistoryEntry[],
  maxTotalChars: number,
  includeTimestamps: boolean
): FormattedHistoryEntry[] {
  if (entries.length === 0) return [];
  const selected: FormattedHistoryEntry[] = [];
  let remainingChars = Math.max(maxTotalChars, 0);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const line = `${includeTimestamps ? `[${formatHistoryTimestamp(entry.timestamp)}] ` : ""}${entry.sender}: ${entry.body}`;
    if (selected.length > 0 && line.length > remainingChars) break;
    selected.push(entry);
    remainingChars -= line.length;
    if (remainingChars <= 0) break;
  }
  return selected.reverse();
}

function renderCompactBlock(params: {
  entries: FormattedHistoryEntry[];
  mode: "dm" | "stream";
  topic?: string;
  stream?: string;
  includeTimestamps: boolean;
}): string {
  if (params.entries.length === 0) return "";
  const label =
    params.mode === "stream"
      ? `older Zulip topic history (${params.stream ?? "stream"} > ${params.topic ?? "topic"})`
      : "older Zulip DM history";
  const lines = params.entries.map((entry) => {
    const prefix = params.includeTimestamps ? `[${formatHistoryTimestamp(entry.timestamp)}] ` : "";
    return `${prefix}${entry.sender}: ${entry.body}`;
  });
  return `--- ${label} ---\n${lines.join("\n")}\n--- end older history ---`;
}

function renderExactBlock(params: {
  messages: ZulipMessage[];
  mode: "dm" | "stream";
  botEmail: string;
  botName: string;
  includeTimestamps: boolean;
  recentExactMaxChars: number;
  stream?: string;
  topic?: string;
}): string {
  if (params.messages.length === 0) return "";
  const label =
    params.mode === "stream"
      ? `recent exact Zulip topic transcript (${params.stream ?? "stream"} > ${params.topic ?? "topic"})`
      : "recent exact Zulip DM transcript";

  const lines = params.messages.map((message) => {
    const prefix = params.includeTimestamps
      ? `[${formatHistoryTimestamp(message.timestamp * 1_000)}] `
      : "";
    const sender = senderLabel(message, params.botEmail, params.botName);
    const body = truncateExactText(
      htmlToStructuredPlainText(message.content),
      params.recentExactMaxChars
    );
    return `${prefix}${sender}:\n${body}`;
  });

  return `--- ${label} ---\n${lines.join("\n\n")}\n--- end exact history ---`;
}

function trimBlockToBudget(block: string, maxChars: number): string {
  if (!block) return "";
  if (block.length <= maxChars) return block;
  if (maxChars <= 1) return block.slice(0, maxChars);
  return `${block.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function renderHistoryContext(
  messages: ZulipMessage[],
  config: HistoryRenderConfig
): { recentExactBlock: string; olderSummaryBlock: string; historyBlock: string } {
  const recentCount = Math.max(0, config.recentExactCount);
  const recentMessages = recentCount > 0 ? messages.slice(-recentCount) : [];
  const olderMessages = recentCount > 0 ? messages.slice(0, -recentCount) : messages;

  const olderEntries = trimFormattedHistoryEntries(
    olderMessages
      .map((message) => ({
        sender: senderLabel(message, config.botEmail, config.botName),
        body: normalizeHistoryText(message.content, config.maxMessageChars),
        timestamp: message.timestamp * 1_000,
      }))
      .filter((entry) => Boolean(entry.body)),
    config.maxTotalChars,
    config.includeTimestamps
  );

  let recentExactBlock = renderExactBlock({
    messages: recentMessages,
    mode: config.mode,
    botEmail: config.botEmail,
    botName: config.botName,
    includeTimestamps: config.includeTimestamps,
    recentExactMaxChars: config.recentExactMaxChars,
    stream: config.stream,
    topic: config.topic,
  });

  let olderSummaryBlock = renderCompactBlock({
    entries: olderEntries,
    mode: config.mode,
    stream: config.stream,
    topic: config.topic,
    includeTimestamps: config.includeTimestamps,
  });

  if (recentExactBlock.length > config.maxTotalChars) {
    recentExactBlock = trimBlockToBudget(recentExactBlock, config.maxTotalChars);
    olderSummaryBlock = "";
  } else {
    const remaining = Math.max(0, config.maxTotalChars - recentExactBlock.length);
    olderSummaryBlock = trimBlockToBudget(olderSummaryBlock, remaining);
  }

  const historyBlock = [olderSummaryBlock, recentExactBlock].filter(Boolean).join("\n\n");
  return { recentExactBlock, olderSummaryBlock, historyBlock };
}

export function renderCurrentMessageText(value: string, maxChars?: number): string {
  const structured = htmlToStructuredPlainText(value);
  return typeof maxChars === "number" ? truncateExactText(structured, maxChars) : structured;
}
