/**
 * Zulip channel plugin entry point for OpenClaw.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { zulipPlugin } from "./src/channel.js";
import { setZulipRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "zulip",
  name: "Zulip",
  description: "Zulip channel plugin for OpenClaw",
  plugin: zulipPlugin,
  setRuntime: setZulipRuntime,
});

export { zulipPlugin, setZulipRuntime };
