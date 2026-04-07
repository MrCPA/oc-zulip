/**
 * Zulip channel plugin for OpenClaw.
 *
 * Supports DM and stream/channel messages.
 * Uses Zulip REST API with event queue long-polling for inbound.
 */

import {
  createChatChannelPlugin,
  createChannelPluginBase,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";

/** OpenClaw config object passed by the host runtime. */
type OpenClawConfig = any;

import { ZulipClient } from "./client.js";
import { startZulipEventLoop } from "./inbound.js";
import { getZulipRuntime } from "./runtime.js";
import type { ZulipStreamConfig } from "./types.js";

// ── Config types ──

export interface ZulipChannelConfig {
  botEmail?: string;
  botApiKey?: string;
  site?: string;
  dm?: {
    policy?: string;
    allowFrom?: string[];
  };
  streams?: ZulipStreamConfig;
}

export interface ResolvedZulipAccount {
  accountId: string;
  name?: string;
  botEmail: string;
  botApiKey: string;
  site: string;
  dmPolicy: string;
  allowFrom: string[];
  streams: ZulipStreamConfig;
  configured: boolean;
  enabled: boolean;
}

// ── Helpers ──

const DEFAULT_ACCOUNT_ID = "default";

function getZulipSection(cfg: OpenClawConfig): ZulipChannelConfig | undefined {
  return (cfg.channels as Record<string, any>)?.zulip;
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedZulipAccount {
  const section = getZulipSection(cfg);
  const botEmail = section?.botEmail ?? "";
  const botApiKey = section?.botApiKey ?? "";
  const site = section?.site ?? "";
  const configured = Boolean(botEmail && botApiKey && site);

  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    botEmail,
    botApiKey,
    site,
    dmPolicy: section?.dm?.policy ?? "allowlist",
    allowFrom: section?.dm?.allowFrom ?? [],
    streams: section?.streams ?? {},
    configured,
    enabled: configured,
  };
}

function inspectAccount(cfg: OpenClawConfig) {
  const section = getZulipSection(cfg);
  const configured = Boolean(
    section?.botEmail && section?.botApiKey && section?.site
  );
  return {
    enabled: configured,
    configured,
    tokenStatus: section?.botApiKey ? "available" : ("missing" as const),
  };
}

/** Check if a sender email is in the allowlist. */
export function isZulipSenderAllowed(
  senderEmail: string,
  allowFrom: string[]
): boolean {
  const normalizedSender = senderEmail.trim().toLowerCase();
  for (const entry of allowFrom) {
    const normalized = entry.trim().toLowerCase();
    if (normalized === "*") return true;
    if (normalized === normalizedSender) return true;
  }
  return false;
}

// Active account instances for outbound and lifecycle management
interface ActiveAccount {
  client: ZulipClient;
  stop: () => void;
}
const activeAccounts = new Map<string, ActiveAccount>();

// ── Config schema ──

const ZulipConfigSchema = {
  type: "object" as const,
  properties: {
    botEmail: { type: "string" as const },
    botApiKey: { type: "string" as const },
    site: { type: "string" as const },
    dm: {
      type: "object" as const,
      properties: {
        policy: {
          type: "string" as const,
          enum: ["allowlist", "open", "pairing"],
        },
        allowFrom: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    streams: {
      type: "object" as const,
      properties: {
        policy: {
          type: "string" as const,
          enum: ["allowlist", "all"],
        },
        allowed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        replyPolicy: {
          type: "string" as const,
          enum: ["dm-allowlist", "mention-only", "open"],
        },
      },
    },
  },
  required: ["botEmail", "botApiKey", "site"] as string[],
};

// ── Plugin ──

export const zulipPlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: "zulip",
      meta: {
        id: "zulip",
        label: "Zulip",
        selectionLabel: "Zulip (Bot API)",
        docsLabel: "zulip",
        blurb: "Connect OpenClaw to a Zulip server via bot API with DM routing.",
        order: 95,
      },
      capabilities: {
        chatTypes: ["direct", "channel"],
        media: false,
      },
      reload: { configPrefixes: ["channels.zulip"] },
      configSchema: buildChannelConfigSchema(ZulipConfigSchema),
      setup: {
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
          resolveAccount(cfg, accountId),
        inspectAccount: (cfg: OpenClawConfig) => inspectAccount(cfg),
      },
      config: {
        listAccountIds: (cfg: OpenClawConfig) =>
          getZulipSection(cfg)?.botEmail ? [DEFAULT_ACCOUNT_ID] : [],
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
          resolveAccount(cfg, accountId),
        inspectAccount: (cfg: OpenClawConfig) => inspectAccount(cfg),
        isConfigured: (account: ResolvedZulipAccount) => account.configured,
        describeAccount: (account: ResolvedZulipAccount) => ({
          accountId: account.accountId,
          configured: account.configured,
          enabled: account.enabled,
        }),
      },
      messaging: {
        normalizeTarget: (target: string) => target.trim().toLowerCase(),
        targetResolver: {
          looksLikeId: (input: string) =>
            input.trim().includes("@") && input.trim().includes("."),
          hint: "<email address>",
        },
      },
    }),
    gateway: {
      startAccount: async (ctx: any) => {
        const account = resolveAccount(ctx.cfg, ctx.account?.accountId);
        if (!account.configured) {
          throw new Error("Zulip bot credentials not configured");
        }

        ctx.setStatus?.({
          accountId: account.accountId,
          botEmail: account.botEmail,
          site: account.site,
        });

        ctx.log?.info(
          `[${account.accountId}] starting Zulip provider (bot: ${account.botEmail})`
        );

        // Stop any existing instance for this account to prevent leaks
        const existing = activeAccounts.get(account.accountId);
        if (existing) {
          ctx.log?.warn?.(
            `[${account.accountId}] stopping previous Zulip provider before restart`
          );
          existing.stop();
          activeAccounts.delete(account.accountId);
        }

        const runtime = getZulipRuntime();

        const client = new ZulipClient({
          botEmail: account.botEmail,
          botApiKey: account.botApiKey,
          site: account.site,
        });

        const lifecycle = await startZulipEventLoop(
          {
            account: { ...account, configured: true },
            cfg: ctx.cfg,
            log: ctx.log,
            setStatus: ctx.setStatus ?? (() => {}),
          },
          runtime
        );

        activeAccounts.set(account.accountId, { client, stop: lifecycle.stop });
        ctx.log?.info(`[${account.accountId}] Zulip provider started`);

        lifecycle.done.catch((err) => {
          ctx.log?.error?.(
            `[${account.accountId}] Zulip event loop fatal error: ${String(err)}`
          );
        });

        return waitUntilAbort(ctx.abortSignal, async () => {
          lifecycle.stop();
          activeAccounts.delete(account.accountId);
          await lifecycle.done.catch(() => {});
          ctx.log?.info(`[${account.accountId}] Zulip provider stopped`);
        });
      },
    },
  },

  security: {
    dm: {
      channelKey: "zulip",
      resolvePolicy: (account: ResolvedZulipAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedZulipAccount) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  pairing: {
    text: {
      idLabel: "Zulip email",
      message: "Your pairing request has been approved!",
      normalizeAllowEntry: (entry: string) => entry.trim().toLowerCase(),
      notify: async ({ id, message }: { id: string; message: string }) => {
        const active = activeAccounts.get(DEFAULT_ACCOUNT_ID);
        if (active) await active.client.sendDirectMessage(id, message);
      },
    },
  },

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10_000,
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string;
    }) => {
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const active = activeAccounts.get(aid);
      if (!active)
        throw new Error(`Zulip client not running for account ${aid}`);

      const finalMessage = (text ?? "").trim();
      if (!finalMessage) return { channel: "zulip" as const, to, messageId: "" };

      const runtime = getZulipRuntime();
      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "zulip",
        accountId: aid,
      });
      const converted = runtime.channel.text.convertMarkdownTables(
        finalMessage,
        tableMode
      );

      const streamMatch = to.match(/^stream:(.+?)::topic:(.+)$/);
      if (streamMatch) {
        const [, streamName, topicName] = streamMatch;
        const result = await active.client.sendStreamMessage(streamName, topicName, converted);
        return { channel: "zulip" as const, to, messageId: `zulip-${result.id}` };
      }

      const result = await active.client.sendDirectMessage(to, converted);
      return { channel: "zulip" as const, to, messageId: `zulip-${result.id}` };
    },
  },
});
