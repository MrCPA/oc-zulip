/**
 * Zulip plugin runtime store.
 *
 * Holds the PluginRuntime reference set during plugin registration.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore(
  "Zulip plugin runtime not initialized"
);

export const setZulipRuntime = store.setRuntime;
export const getZulipRuntime = store.getRuntime;
