# @openclaw/zulip

OpenClaw channel plugin for [Zulip](https://zulip.com). Connects an OpenClaw instance to a Zulip server via the bot API, supporting both direct messages and stream/channel conversations.

## Features

- **DM routing** with allowlist, open, and pairing access policies
- **Stream/channel support** with per-stream allowlists and reply policies (mention-only, open, dm-allowlist)
- **Conversation history** — fetches recent messages so the agent has context
- **Topic-aware** — each stream topic gets its own isolated session
- **Event queue long-polling** for real-time inbound message handling
- **Markdown table conversion** via the OpenClaw text pipeline
- **Exponential backoff** reconnection on connection failures

## Prerequisites

- An OpenClaw instance
- A Zulip server (7.0+) with a [bot account](https://zulip.com/help/add-a-bot-or-integration)
- The bot's email address and API key

## Installation

```bash
npm install @openclaw/zulip
```

## Configuration

Add the Zulip channel to your OpenClaw config:

```json
{
  "channels": {
    "zulip": {
      "botEmail": "bot@your-org.zulipchat.com",
      "botApiKey": "your-bot-api-key",
      "site": "https://your-org.zulipchat.com",
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

### DM policies

| Policy | Behavior |
|--------|----------|
| `allowlist` | Only emails in `allowFrom` can DM the bot (default) |
| `open` | Anyone on the Zulip server can DM the bot |
| `pairing` | Unknown senders receive a pairing challenge |

### Stream reply policies

| Policy | Behavior |
|--------|----------|
| `mention-only` | Bot replies only when @-mentioned |
| `dm-allowlist` | Bot replies only to senders in the DM allowlist (default) |
| `open` | Bot replies to all messages in allowed streams |

### Stream access policies

| Policy | Behavior |
|--------|----------|
| `allowlist` | Only streams listed in `allowed` are monitored (default) |
| `all` | All streams the bot is subscribed to are monitored |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Type check (no emit)
npm run typecheck
```

### Architecture

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

The plugin uses Zulip's [event queue API](https://zulip.com/api/real-time-events) for real-time message delivery. Inbound messages are routed through the OpenClaw dispatch pipeline; outbound replies are sent via the [send message API](https://zulip.com/api/send-message).

## Compatibility

- **Zulip 7.0+** required (uses `"direct"` message type and `"dm"` narrow operator)
- **Node.js 22+** required
- Uses native `fetch` (no HTTP client dependency)

## License

[MIT](LICENSE)
