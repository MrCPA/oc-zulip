/**
 * Zulip plugin runtime store.
 *
 * Holds the PluginRuntime reference set during plugin registration.
 */

import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>(
  "Zulip plugin runtime not initialized"
);

export const setZulipRuntime = store.setRuntime;
export const getZulipRuntime = store.getRuntime;
export const tryGetZulipRuntime = store.tryGetRuntime;
