# @openclaw/zulip

OpenClaw channel plugin for [Zulip](https://zulip.com). Connects an OpenClaw instance to a Zulip server via the bot API, supporting both direct messages and stream/topic conversations.

## Features

- **DM routing** with allowlist, open, and pairing access policies
- **Stream/channel support** with per-stream allowlists and reply policies (mention-only, open, dm-allowlist)
- **Conversation history** — dual-layer same-conversation context with recent exact transcript plus older compacted history
- **Topic-aware** — each stream topic gets its own isolated session
- **Topic resolve/unresolve** — `@bot resolve` / `@bot unresolve` to toggle Zulip's topic resolved state
- **Event queue long-polling** for real-time inbound message handling
- **Markdown table conversion** via the OpenClaw text pipeline
- **Exponential backoff** reconnection on connection failures

## Prerequisites

- **OpenClaw** — a running OpenClaw instance
- **Zulip 7.0+** — uses the `"direct"` message type and `"dm"` narrow operator (introduced in Zulip 7.0)
- **Node.js 22+** — uses native `fetch` (no HTTP client dependency)
- **Zulip bot account** — create one via *Organization settings > Bots* ([docs](https://zulip.com/help/add-a-bot-or-integration))
  - Use a **Generic bot** type
  - Note the bot's **email address** and **API key**

### Bot permissions in Zulip

The bot account needs:

- Permission to send direct messages (enabled by default for bots)
- Subscription to any streams you want it to monitor (the plugin will auto-subscribe to streams listed in the `allowed` config when using `allowlist` policy)
- If using `streams.policy: "all"`, the bot must be manually subscribed to streams in Zulip — the plugin will listen to all streams it's subscribed to

## Installation

```bash
npm install @openclaw/zulip
```

## Building from source

```bash
git clone https://github.com/MrCPA/oc-zulip.git
cd oc-zulip
npm install
npm run build
```

The build output goes to `dist/`. The plugin is bundled with esbuild — all source is compiled to ESM JS, with `openclaw/*` imports marked as external (resolved at runtime from the host).

The `prepack` script ensures `dist/` is always built before `npm pack` or `npm publish`, so the published package always contains the compiled plugin code.

To type-check (no emit):

```bash
npm run typecheck
```

> **Note:** The typecheck may report errors if the installed `openclaw` SDK version has drifted from the types this plugin was written against. The esbuild bundler ignores types, so the plugin will still build and run correctly.

## Loading the plugin in OpenClaw

Register the plugin in your OpenClaw configuration. The plugin exposes two entry points:

| Entry | Path | Purpose |
|-------|------|---------|
| Main | `dist/index.js` | Full plugin — loaded when the channel is enabled |
| Setup | `dist/setup-entry.js` | Lightweight entry — loaded when the channel is unconfigured |

These are declared in `package.json` under the `openclaw` field and in `openclaw.plugin.json`. OpenClaw discovers and loads them automatically when the package is installed.

## Configuration

Add the Zulip channel to your OpenClaw config:

```json
{
  "channels": {
    "zulip": {
      "botEmail": "bot@your-org.zulipchat.com",
      "botApiKey": "your-bot-api-key",
      "site": "https://your-org.zulipchat.com",
      "history": {
        "dmLimit": 30,
        "streamLimit": 40,
        "attachmentLookback": 12,
        "maxMessageChars": 1200,
        "maxTotalChars": 24000,
        "recentExactCount": 6,
        "recentExactMaxChars": 8000,
        "includeTimestamps": true
      },
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["user@example.com"]
      },
      "streams": {
        "policy": "allowlist",
        "allowed": ["general", "support"],
        "replyPolicy": "mention-only"
      }
    }
  }
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `botEmail` | The bot's email address in Zulip |
| `botApiKey` | The bot's API key (from *Settings > Bots* in Zulip) |
| `site` | Full URL of the Zulip server (e.g. `https://your-org.zulipchat.com`) |

### History context

Controls how much same-conversation context is fetched from Zulip and injected ahead of the current message.

| Field | Description |
|-------|-------------|
| `history.dmLimit` | How many recent DM messages to consider for prompt context, default `30` |
| `history.streamLimit` | How many recent messages from the same stream topic to consider, default `40` |
| `history.attachmentLookback` | How many earlier messages to scan for referenced uploads, default `12` |
| `history.maxMessageChars` | Per-message cap for older compacted history lines, default `1200` |
| `history.maxTotalChars` | Hard total char budget for all injected history, default `24000` |
| `history.recentExactCount` | Number of newest same-DM or same-topic messages kept in a higher-fidelity transcript block, default `6` |
| `history.recentExactMaxChars` | Per-message cap for the recent exact transcript block, default `8000` |
| `history.includeTimestamps` | Include ISO timestamps in injected history lines, default `true` |

The plugin now uses a dual-layer history strategy:

- **Recent exact block**: the newest messages from the same DM or stream topic are kept with much higher fidelity, preserving paragraph breaks and common quote, list, and code structure where possible.
- **Older summary block**: older conversation history stays compacted so prompts remain bounded.

Both layers share the same hard `history.maxTotalChars` budget. If the exact block alone would exceed that budget, it is trimmed and the older summary block is dropped first.

### DM policies

Controls who can send direct messages to the bot.

| Policy | Behavior |
|--------|----------|
| `allowlist` | Only emails in `allowFrom` can DM the bot **(default)** |
| `open` | Anyone on the Zulip server can DM the bot |
| `pairing` | Unknown senders receive a pairing challenge; approved senders are added to the allowlist |

When `policy` is `allowlist` or `pairing`, the `allowFrom` array specifies allowed email addresses. Use `"*"` as a wildcard to allow all senders (equivalent to `open`).

### Stream access policies

Controls which streams the bot monitors.

| Policy | Behavior |
|--------|----------|
| `allowlist` | Only streams listed in `allowed` are monitored **(default)**. The plugin auto-subscribes the bot to these streams on startup. |
| `all` | All streams the bot is subscribed to are monitored. You must manually subscribe the bot to streams in Zulip. |

### Stream reply policies

Controls when the bot replies to messages in monitored streams.

| Policy | Behavior |
|--------|----------|
| `dm-allowlist` | Bot replies only to senders in the DM `allowFrom` list **(default)** |
| `mention-only` | Bot replies only when @-mentioned |
| `open` | Bot replies to all messages in allowed streams |

### Topic commands

In streams, users can `@mention` the bot with `resolve` or `unresolve` to toggle Zulip's resolved-topic state:

- `@bot resolve` — prepends `✔ ` to the topic name across all messages
- `@bot unresolve` — removes the `✔ ` prefix

These commands require the bot to have permission to edit topics in the stream.

## Architecture

```
src/
  types.ts     — Shared interfaces
  util.ts      — Text utilities (stripHtml, escapeRegex, etc.)
  client.ts    — Zulip REST API client (fetch-based, HTTP Basic auth)
  runtime.ts   — OpenClaw plugin runtime store
  channel.ts   — Plugin definition, config, outbound messaging
  inbound.ts   — Event queue long-polling, DM and stream handlers
index.ts       — Main plugin entry point
setup-entry.ts — Lightweight setup entry (loaded when unconfigured)
```

### Event flow

1. On startup, the plugin connects to Zulip and verifies credentials via `GET /api/v1/users/me`
2. If using `allowlist` stream policy, the bot auto-subscribes to the configured streams
3. An event queue is registered via `POST /api/v1/register` with either:
   - DM-only narrow (if no stream listening is configured)
   - All-messages scope (if any stream listening is configured — filtering happens in the handler)
4. The plugin long-polls `GET /api/v1/events` for new messages
5. Inbound messages are routed through the OpenClaw dispatch pipeline
6. Outbound replies are sent via `POST /api/v1/messages`

If the event queue expires (`BAD_EVENT_QUEUE_ID`), the plugin automatically re-registers. On connection errors, it reconnects with exponential backoff (5s → 60s max).

## Troubleshooting

### "Zulip authentication failed (401)"

- Verify `botEmail` and `botApiKey` are correct
- Regenerate the API key in Zulip (*Settings > Bots > API key*)
- Make sure the bot account is active (not deactivated)

### "Zulip permission denied (403)"

- The bot may lack permission to send DMs or post to a stream
- Check the bot's subscription to the target stream
- Check Zulip's organization-level permissions for bots

### "Invalid Zulip site URL"

- `site` must be a full URL starting with `https://` (e.g. `https://your-org.zulipchat.com`)
- Do not include a trailing slash or path

### Bot doesn't respond in streams

- Check `streams.policy` — if `allowlist`, ensure the stream is in the `allowed` array
- Check `streams.replyPolicy`:
  - `mention-only` requires `@mentioning` the bot
  - `dm-allowlist` requires the sender to be in `dm.allowFrom`
- Verify the bot is subscribed to the stream in Zulip

### Bot doesn't respond to DMs

- Check `dm.policy` — if `allowlist`, ensure the sender's email is in `dm.allowFrom`
- For `pairing` policy, the sender needs to complete the pairing challenge first

### Event queue keeps re-registering

- This is normal if the Zulip server restarts or the connection is interrupted
- Check network connectivity between OpenClaw and the Zulip server
- Long-polling timeouts are handled automatically

## Compatibility

- **Zulip 7.0+** required (uses `"direct"` message type and `"dm"` narrow operator)
- **Node.js 22+** required (native `fetch`)
- **OpenClaw** — compatible with current plugin SDK conventions

## License

[MIT](LICENSE)
