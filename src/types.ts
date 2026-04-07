/**
 * Shared types for the Zulip OpenClaw plugin.
 */

/** OpenClaw config object passed by the host runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenClawConfig = any;

export interface ZulipStreamConfig {
  policy?: "allowlist" | "all";
  allowed?: string[];
  replyPolicy?: "dm-allowlist" | "mention-only" | "open";
}

export interface ZulipAccountConfig {
  accountId: string;
  botEmail: string;
  botApiKey: string;
  site: string;
  dmPolicy: string;
  allowFrom: string[];
  streams: ZulipStreamConfig;
}

export interface ZulipGatewayContext {
  account: ZulipAccountConfig & { configured: boolean };
  cfg: OpenClawConfig;
  log?: {
    info: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  setStatus: (status: Record<string, any>) => void;
}
