/**
 * Lightweight setup entry for the Zulip plugin.
 * Loaded when channel is disabled/unconfigured.
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { zulipPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(zulipPlugin);
