/**
 * CLI (TUI) entrypoint for the provider-manager plugin.
 *
 * The TUI feature is detected through this module — it must import
 * `@opencode/plugin/tui` and export a Plugin.define with a `setup`.
 * The actual UX lives in index.js (tuiSetup).
 */
import { Plugin } from "@opencode/plugin/tui"
import { tuiSetup } from "./index.js"

export default Plugin.define({
  id: "provider-manager",
  setup(context) {
    try {
      tuiSetup(context)
    } catch (error) {
      console.error("[provider-manager] tui setup failed:", error?.message ?? error)
    }
  },
})
