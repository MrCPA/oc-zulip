/**
 * Zulip inbound message handler using event queue long-polling.
 *
 * Registers a long-lived event queue with Zulip, polls for message events,
 * and dispatches inbound DMs and stream messages through the OpenClaw pipeline.
 */

import { ZulipClient, type ZulipMessage } from "./client.js";
import { isZulipSenderAllowed } from "./channel.js";
import type { ZulipGatewayContext } from "./types.js";
import {
  stripHtml,
  escapeRegex,
  resolveAllowedStreams,
  hasStreamListening,
  isStreamAllowed,
  sleep,
} from "./util.js";

const HISTORY_LIMIT = 20;

import {
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
  createPreCryptoDirectDmAuthorizer,
} from "openclaw/plugin-sdk/direct-dm";
import { resolveChannelMediaMaxBytes, saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const MAX_INBOUND_ATTACHMENTS = 8;

interface DownloadedInboundAttachment {
  url: string;
  path: string;
  contentType?: string;
  name?: string;
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

function stripInlineHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function isSameOriginZulipUpload(url: string, site: string): boolean {
  try {
    const parsed = new URL(url);
    const base = new URL(site);
    return parsed.origin === base.origin && parsed.pathname.startsWith("/user_uploads/");
  } catch {
    return false;
  }
}

function extractInboundAttachmentCandidates(
  html: string,
  site: string
): Array<{ url: string; name?: string }> {
  const matches: Array<{ url: string; name?: string }> = [];
  const seen = new Set<string>();

  const push = (rawUrl: string | undefined, rawName?: string) => {
    if (!rawUrl) return;
    let resolved: string;
    try {
      resolved = new URL(rawUrl, site).toString();
    } catch {
      return;
    }
    if (!isSameOriginZulipUpload(resolved, site) || seen.has(resolved)) return;
    seen.add(resolved);
    matches.push({
      url: resolved,
      name: rawName?.trim() ? stripInlineHtml(rawName) : undefined,
    });
  };

  const anchorRegex = /<a\b[^>]*\bhref=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    push(match[2], match[3]);
    if (matches.length >= MAX_INBOUND_ATTACHMENTS) return matches;
  }

  const mediaRegex = /<(?:img|source|video|audio)\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/gi;
  for (const match of html.matchAll(mediaRegex)) {
    push(match[2]);
    if (matches.length >= MAX_INBOUND_ATTACHMENTS) return matches;
  }

  return matches;
}

function resolveInboundMediaMaxBytes(cfg: Record<string, any>, accountId: string): number {
  return (
    resolveChannelMediaMaxBytes({
      cfg,
      accountId,
      resolveChannelLimitMb: ({ cfg }) => {
        const limit = (cfg.channels as Record<string, any> | undefined)?.zulip?.mediaMaxMb;
        return typeof limit === "number" && Number.isFinite(limit) && limit > 0
          ? limit
          : undefined;
      },
    }) ?? DEFAULT_INBOUND_MEDIA_MAX_BYTES
  );
}

function buildAttachmentNote(attachments: DownloadedInboundAttachment[]): string {
  if (attachments.length === 0) return "";
  const labels = attachments
    .map((attachment) => attachment.name?.trim())
    .filter((value): value is string => Boolean(value));
  if (labels.length === 0) {
    return attachments.length === 1 ? "[Attachment received]" : `[${attachments.length} attachments received]`;
  }
  const preview = labels.slice(0, 4).join(", ");
  const suffix = labels.length > 4 ? `, +${labels.length - 4} more` : "";
  return `[Attachments: ${preview}${suffix}]`;
}

async function downloadInboundAttachments(params: {
  html: string;
  client: ZulipClient;
  ctx: ZulipGatewayContext;
}): Promise<DownloadedInboundAttachment[]> {
  const { html, client, ctx } = params;
  const candidates = extractInboundAttachmentCandidates(html, ctx.account.site);
  if (candidates.length === 0) return [];

  const maxBytes = resolveInboundMediaMaxBytes(
    ctx.cfg as Record<string, any>,
    ctx.account.accountId
  );
  const attachments: DownloadedInboundAttachment[] = [];

  for (const candidate of candidates) {
    try {
      const downloaded = await client.downloadFile(candidate.url, { maxBytes });
      const saved = await saveMediaBuffer(
        downloaded.buffer,
        downloaded.contentType,
        "inbound",
        maxBytes,
        candidate.name ?? downloaded.fileName
      );
      attachments.push({
        url: downloaded.url,
        path: saved.path,
        contentType: saved.contentType,
        name: candidate.name ?? downloaded.fileName,
      });
    } catch (err) {
      ctx.log?.warn?.(
        `[${ctx.account.accountId}] failed to download Zulip attachment ${candidate.url}: ${String(err)}`
      );
    }
  }

  if (attachments.length > 0) {
    ctx.log?.info?.(
      `[${ctx.account.accountId}] downloaded ${attachments.length} Zulip attachment(s)`
    );
  }

  return attachments;
}

function shouldSendImmediateAck(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /(research|investigat|look into|dig into|find out|analy[sz]e|compare|evaluate|explore|figure out)/i.test(
    normalized
  );
}

function immediateAckText(chatType: "dm" | "stream"): string {
  return chatType === "stream"
    ? "Starting on that. I'll dig in and report back here."
    : "Starting on that. I'll dig in and report back.";
}

/**
 * Start the Zulip event queue listener for a single account.
 * Returns a stop function.
 */
export async function startZulipEventLoop(
  ctx: ZulipGatewayContext,
  runtime: PluginRuntime,
  client = new ZulipClient({
    botEmail: ctx.account.botEmail,
    botApiKey: ctx.account.botApiKey,
    site: ctx.account.site,
  })
): Promise<{ stop: () => void; done: Promise<void> }> {
  const { account, cfg } = ctx;

  let me: { user_id: number; email: string; full_name: string };
  try {
    me = await client.getOwnUser();
  } catch (err) {
    throw new Error(
      `Failed to connect to Zulip at ${account.site} - check site URL, botEmail, and botApiKey. ${String(err)}`
    );
  }
  ctx.log?.info?.(
    `[${account.accountId}] Zulip bot connected as ${me.full_name} (${me.email})`
  );

  const listenToStreams = hasStreamListening(account.streams);
  const streamNames = resolveAllowedStreams(account.streams);
  if (streamNames.length > 0) {
    await subscribeToStreams(client, streamNames, ctx);
  }

  let running = true;
  let currentQueueId: string | null = null;
  let reconnectDelay = RECONNECT_DELAY_MS;

  const pairing = createChannelPairingController({
    core: runtime,
    channel: "zulip",
    accountId: account.accountId,
  });

  // ── Helpers ──

  async function resolveAccess(senderEmail: string, rawBody: string) {
    return resolveInboundDirectDmAccessWithRuntime({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      senderId: senderEmail,
      rawBody,
      isSenderAllowed: isZulipSenderAllowed,
      runtime: {
        shouldComputeCommandAuthorized:
          runtime.channel.commands.shouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers:
          runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
      },
      modeWhenAccessGroupsOff: "configured",
    });
  }

  function resolveTableMode() {
    return runtime.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });
  }

  function convertTables(text: string): string {
    return runtime.channel.text.convertMarkdownTables(text, resolveTableMode());
  }

  function extractText(payload: unknown): string {
    if (payload && typeof payload === "object" && "text" in payload) {
      return String((payload as any).text ?? "");
    }
    if (typeof payload === "string") return payload;
    return "";
  }

  /**
   * Fetch recent conversation history and format it as context for the agent.
   * Excludes the current message (by id) so it isn't duplicated.
   */
  async function fetchHistory(
    mode: "dm" | "stream",
    opts: {
      currentMessageId: number;
      senderEmail?: string;
      stream?: string;
      topic?: string;
    }
  ): Promise<string> {
    try {
      const messages =
        mode === "dm"
          ? await client.getDmHistory(opts.senderEmail!, HISTORY_LIMIT)
          : await client.getStreamTopicHistory(
              opts.stream!,
              opts.topic!,
              HISTORY_LIMIT
            );

      const prior = messages.filter((m) => m.id !== opts.currentMessageId);
      if (prior.length === 0) return "";

      const lines = prior.map((m) => {
        const name =
          m.sender_email === account.botEmail
            ? `${me.full_name} (bot)`
            : m.sender_full_name;
        return `[${name}]: ${stripHtml(m.content)}`;
      });

      return (
        "--- conversation history ---\n" +
        lines.join("\n") +
        "\n--- end history ---\n\n"
      );
    } catch (err) {
      ctx.log?.debug?.(
        `[${account.accountId}] failed to fetch conversation history: ${String(err)}`
      );
      return "";
    }
  }

  const authorizeSender = createPreCryptoDirectDmAuthorizer({
    resolveAccess: async (senderId) => await resolveAccess(senderId, ""),
    issuePairingChallenge: async ({ senderId, reply }) => {
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `Zulip user: ${senderId}`,
        sendPairingReply: reply,
        onCreated: () => {
          ctx.log?.debug?.(
            `[${account.accountId}] zulip pairing request sender=${senderId}`
          );
        },
        onReplyError: (err: unknown) => {
          ctx.log?.warn?.(
            `[${account.accountId}] zulip pairing reply failed for ${senderId}: ${String(err)}`
          );
        },
      });
    },
    onBlocked: ({ senderId, reason }) => {
      ctx.log?.debug?.(
        `[${account.accountId}] blocked Zulip sender ${senderId} (${reason})`
      );
    },
  });

  // ── Stream messages ──

  async function handleStreamMessage(message: ZulipMessage) {
    const senderEmail = message.sender_email;
    const streamName =
      typeof message.display_recipient === "string"
        ? message.display_recipient
        : "";
    const topic = message.subject || "(no topic)";

    if (!isStreamAllowed(streamName, account.streams)) {
      ctx.log?.debug?.(
        `[${account.accountId}] ignoring stream message from non-allowed stream: ${streamName}`
      );
      return;
    }

    const rawBody = stripHtml(message.content);
    const attachments = await downloadInboundAttachments({
      html: message.content,
      client,
      ctx,
    });
    const attachmentNote = buildAttachmentNote(attachments);
    if (!rawBody.trim() && attachments.length === 0) return;

    const replyPolicy = account.streams.replyPolicy ?? "dm-allowlist";
    const botMentionPattern = new RegExp(
      `@\\*\\*${escapeRegex(me.full_name)}\\*\\*|@${escapeRegex(account.botEmail)}`,
      "i"
    );
    const wasMentioned = botMentionPattern.test(message.content);

    if (!shouldReplyToStream(replyPolicy, wasMentioned, senderEmail)) {
      ctx.log?.debug?.(
        `[${account.accountId}] stream message from ${senderEmail} in ${streamName}/${topic} skipped (policy=${replyPolicy}, mentioned=${wasMentioned})`
      );
      return;
    }

    ctx.log?.info?.(
      `[${account.accountId}] stream message from ${message.sender_full_name} in ${streamName}/${topic}: ${rawBody.slice(0, 60)}...`
    );

    const cleanBody =
      rawBody
        .replace(
          new RegExp(`@\\*\\*${escapeRegex(me.full_name)}\\*\\*`, "gi"),
          ""
        )
        .replace(new RegExp(`@${escapeRegex(account.botEmail)}`, "gi"), "")
        .trim() || rawBody;
    const effectiveBody = cleanBody || rawBody || attachmentNote;

    const topicCmd = cleanBody.trim().toLowerCase();
    if (wasMentioned && (topicCmd === "resolve" || topicCmd === "unresolve")) {
      try {
        if (topicCmd === "resolve") {
          await client.resolveTopic(message.id, topic);
          ctx.log?.info?.(
            `[${account.accountId}] resolved topic "${topic}" in ${streamName}`
          );
        } else {
          await client.unresolveTopic(message.id, topic);
          ctx.log?.info?.(
            `[${account.accountId}] unresolved topic "${topic}" in ${streamName}`
          );
        }
      } catch (err) {
        ctx.log?.error?.(
          `[${account.accountId}] failed to ${topicCmd} topic "${topic}": ${String(err)}`
        );
        await client.sendStreamMessage(
          streamName,
          topic,
          `Failed to ${topicCmd} this topic.`
        );
      }
      return;
    }

    const history = await fetchHistory("stream", {
      currentMessageId: message.id,
      stream: streamName,
      topic,
    });
    const bodyForAgent = [
      history + effectiveBody,
      attachmentNote && attachmentNote !== effectiveBody ? attachmentNote : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (shouldSendImmediateAck(cleanBody)) {
      await client.sendStreamMessage(streamName, topic, immediateAckText("stream"));
    }

    const streamTarget = `stream:${streamName}::topic:${topic}`;
    const sessionPeer = `zulip:stream:${streamName}:${topic}`;

    await dispatchReplyWithBufferedBlockDispatcher({
      ctx: finalizeInboundContext({
        Body: effectiveBody,
        BodyForAgent: bodyForAgent,
        RawBody: rawBody || attachmentNote,
        CommandBody: effectiveBody,
        From: `zulip:${senderEmail}`,
        To: streamTarget,
        SessionKey: `zulip:${account.accountId}:${sessionPeer}`,
        AccountId: account.accountId,
        ChatType: "channel" as const,
        ConversationLabel: `${streamName} > ${topic}`,
        SenderName: message.sender_full_name || senderEmail,
        SenderId: senderEmail,
        SenderUsername: senderEmail,
        GroupSubject: `#${streamName} > ${topic}`,
        GroupChannel: `#${streamName}`,
        WasMentioned: wasMentioned,
        MessageSid: `zulip-${message.id}`,
        Timestamp: message.timestamp * 1_000,
        CommandAuthorized: isZulipSenderAllowed(senderEmail, account.allowFrom),
        CommandSource: "text" as const,
        OriginatingChannel: "zulip",
        OriginatingTo: streamTarget,
        Provider: "zulip",
        Surface: "zulip",
        MediaPaths: attachments.map((attachment) => attachment.path),
        MediaUrls: attachments.map((attachment) => attachment.url),
        MediaTypes: attachments.map((attachment) => attachment.contentType),
      }),
      cfg,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          const text = extractText(payload);
          if (!text.trim()) return;
          await client.sendStreamMessage(streamName, topic, convertTables(text));
        },
        onError: (err: unknown, info: { kind: string }) => {
          ctx.log?.error?.(
            `[${account.accountId}] Zulip stream ${info.kind} reply failed: ${String(err)}`
          );
        },
      },
    });
  }

  function shouldReplyToStream(
    policy: string,
    wasMentioned: boolean,
    senderEmail: string
  ): boolean {
    switch (policy) {
      case "open":
        return true;
      case "mention-only":
        return wasMentioned;
      case "dm-allowlist":
      default:
        return isZulipSenderAllowed(senderEmail, account.allowFrom);
    }
  }

  // ── DM messages ──

  async function handleDirectMessage(message: ZulipMessage) {
    const senderEmail = message.sender_email;
    const rawBody = stripHtml(message.content);
    const attachments = await downloadInboundAttachments({
      html: message.content,
      client,
      ctx,
    });
    const attachmentNote = buildAttachmentNote(attachments);

    const authResult = await authorizeSender({
      senderId: senderEmail,
      reply: async (text: string) => {
        await client.sendDirectMessage(senderEmail, text);
      },
    });

    if (authResult !== "allow") {
      ctx.log?.debug?.(
        `[${account.accountId}] sender ${senderEmail} auth result: ${authResult}`
      );
      return;
    }

    const resolvedAccess = await resolveAccess(senderEmail, rawBody);
    if (resolvedAccess.access.decision !== "allow") {
      ctx.log?.warn?.(
        `[${account.accountId}] dropping Zulip DM after access drift (${senderEmail}, ${resolvedAccess.access.reason})`
      );
      return;
    }

    if (!rawBody.trim() && attachments.length === 0) {
      return;
    }

    const history = await fetchHistory("dm", {
      currentMessageId: message.id,
      senderEmail,
    });
    const effectiveBody = rawBody || attachmentNote;
    const bodyForAgent = [
      history + effectiveBody,
      attachmentNote && attachmentNote !== effectiveBody ? attachmentNote : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (shouldSendImmediateAck(rawBody)) {
      await client.sendDirectMessage(senderEmail, immediateAckText("dm"));
    }

    await dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime,
      channel: "zulip",
      channelLabel: "Zulip",
      accountId: account.accountId,
      peer: { kind: "direct", id: senderEmail },
      senderId: senderEmail,
      senderAddress: `zulip:${senderEmail}`,
      recipientAddress: `zulip:${account.botEmail}`,
      conversationLabel: message.sender_full_name || senderEmail,
      rawBody: effectiveBody,
      messageId: `zulip-${message.id}`,
      timestamp: message.timestamp * 1_000,
      commandAuthorized: resolvedAccess.commandAuthorized,
      commandBody: effectiveBody,
      bodyForAgent,
      deliver: async (payload) => {
        const text = extractText(payload);
        if (!text.trim()) return;
        await client.sendDirectMessage(senderEmail, convertTables(text));
      },
      onRecordError: (err) => {
        ctx.log?.error?.(
          `[${account.accountId}] failed recording Zulip inbound session: ${String(err)}`
        );
      },
      onDispatchError: (err, info) => {
        ctx.log?.error?.(
          `[${account.accountId}] Zulip ${info.kind} reply failed: ${String(err)}`
        );
      },
      extraContext: {
        MediaPaths: attachments.map((attachment) => attachment.path),
        MediaUrls: attachments.map((attachment) => attachment.url),
        MediaTypes: attachments.map((attachment) => attachment.contentType),
      },
    });
  }

  // ── Message router ──

  const conversationChains = new Map<string, Promise<void>>();

  function getConversationKey(message: ZulipMessage): string {
    if (message.type === "stream") {
      const streamName =
        typeof message.display_recipient === "string"
          ? message.display_recipient.trim().toLowerCase()
          : "";
      const topic = (message.subject || "(no topic)").trim().toLowerCase();
      return `stream:${streamName}:${topic}`;
    }

    return `dm:${message.sender_email.trim().toLowerCase()}`;
  }

  function enqueueMessage(message: ZulipMessage) {
    const key = getConversationKey(message);
    const previous = conversationChains.get(key) ?? Promise.resolve();

    const next = previous
      .catch(() => {})
      .then(async () => {
        if (!running) return;
        await handleMessage(message);
      })
      .catch((err) => {
        ctx.log?.error?.(
          `[${account.accountId}] error handling Zulip message for ${key}: ${String(err)}`
        );
      })
      .finally(() => {
        if (conversationChains.get(key) === next) {
          conversationChains.delete(key);
        }
      });

    conversationChains.set(key, next);
  }

  async function handleMessage(message: ZulipMessage) {
    if (message.sender_email === account.botEmail) return;

    if (message.type === "stream") {
      await handleStreamMessage(message);
      return;
    }

    if (message.type === "private" || message.type === "direct") {
      await handleDirectMessage(message);
      return;
    }

    ctx.log?.debug?.(
      `[${account.accountId}] ignoring unknown message type=${message.type}`
    );
  }

  // ── Event loop ──

  async function eventLoop() {
    while (running) {
      try {
        const queue = await client.registerQueue(listenToStreams);
        currentQueueId = queue.queue_id;
        let lastEventId = queue.last_event_id;
        reconnectDelay = RECONNECT_DELAY_MS;

        ctx.log?.info?.(
          `[${account.accountId}] Zulip event queue registered: ${queue.queue_id}`
        );

        while (running) {
          try {
            const response = await client.getEvents(queue.queue_id, lastEventId);

            if (response.result !== "success") {
              ctx.log?.warn?.(
                `[${account.accountId}] Zulip events error: ${response.msg}`
              );
              break;
            }

            for (const event of response.events) {
              lastEventId = event.id;
              if (event.type === "message" && event.message) {
                enqueueMessage(event.message);
              }
            }
          } catch (err: any) {
            if (!running) break;

            if (
              err?.message?.includes("BAD_EVENT_QUEUE_ID") ||
              err?.message?.includes("404")
            ) {
              ctx.log?.info?.(
                `[${account.accountId}] Zulip event queue expired, re-registering...`
              );
              break;
            }

            ctx.log?.error?.(
              `[${account.accountId}] Zulip poll error: ${String(err)}`
            );
            await sleep(2_000);
          }
        }

        if (currentQueueId) {
          await client.deleteQueue(currentQueueId).catch(() => {});
          currentQueueId = null;
        }
      } catch (err) {
        if (!running) break;
        ctx.log?.error?.(
          `[${account.accountId}] Zulip queue registration failed: ${String(err)}, retrying in ${reconnectDelay}ms`
        );
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  const done = eventLoop();

  return {
    done,
    stop: () => {
      running = false;
      if (currentQueueId) {
        client.deleteQueue(currentQueueId).catch(() => {});
      }
    },
  };
}

/** Subscribe the bot to named streams, logging results. */
async function subscribeToStreams(
  client: ZulipClient,
  streamNames: string[],
  ctx: ZulipGatewayContext
) {
  const { account } = ctx;
  try {
    const result = await client.subscribeToStreams(
      streamNames.map((name) => ({ name }))
    );
    const subscribed = Object.keys(result.subscribed ?? {});
    const already = Object.keys(result.already_subscribed ?? {});
    ctx.log?.info?.(
      `[${account.accountId}] Zulip streams: subscribed=[${subscribed.join(", ")}] already=[${already.join(", ")}]`
    );
  } catch (err) {
    ctx.log?.error?.(
      `[${account.accountId}] Failed to subscribe to streams: ${String(err)}`
    );
  }
}
