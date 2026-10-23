/**
 * Provider Manager plugin for OpenCode.
 *
 * One file serving both runtimes (same module handles each side):
 *  - TUI  (ctx.ui/dialog/keymap): interactive `/provider` slash command.
 *  - Server (ctx.provider.transform): registers managed providers/models and
 *    hot-reloads when the store file changes on disk.
 *
 * Store: ~/.config/opencode/provider-manager.json
 */
import os from "node:os"
import path from "node:path"
import { watch } from "node:fs"
import { readFile, writeFile, rename } from "node:fs/promises"

const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR
  ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
  : path.join(os.homedir(), ".config", "opencode")
const STORE_PATH = path.join(CONFIG_DIR, "provider-manager.json")
const OPENCODE_JSON = path.join(CONFIG_DIR, "opencode.json")

/* ---------------------------------------------------------------- helpers */

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, "utf8"))
    return { providers: parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {} }
  } catch {
    return { providers: {} }
  }
}

/** Atomic write (tmp + rename) so the server watcher never reads a torn file. */
async function writeStore(store) {
  const tmp = `${STORE_PATH}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8")
  await rename(tmp, STORE_PATH)
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider"
}

function maskKey(key) {
  if (!key) return "(none)"
  if (key.length <= 8) return "****"
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

function makeProviderInfo(id, p) {
  return {
    id,
    name: p.name || id,
    activation: "enabled",
    package: "@opencode/ai/providers/openai-compatible",
    settings: p.apiKey ? { baseURL: p.baseURL, apiKey: p.apiKey } : { baseURL: p.baseURL },
  }
}

function makeModelInfo(providerID, modelID, p) {
  return {
    id: modelID,
    modelID,
    providerID,
    name: p.catalog?.[modelID] || modelID,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 256000, output: 8192 },
  }
}

function fetchCatalog(baseURL, apiKey) {
  const url = `${String(baseURL).replace(/\/+$/, "")}/models`
  return fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      return res.json()
    })
    .then((json) => {
      const raw = Array.isArray(json) ? json : json?.data ?? json?.models ?? []
      const out = new Map()
      for (const item of raw) {
        const id = typeof item === "string" ? item : String(item?.id ?? item?.name ?? "")
        if (!id) continue
        const label = typeof item === "string" ? id : String(item?.name ?? item?.display_name ?? id)
        if (!out.has(id)) out.set(id, label)
      }
      return [...out].map(([id, name]) => ({ id, name }))
    })
}

/* ------------------------------------------------------------ server side */

const booted = { server: false, tui: false }

async function serverSetup(ctx) {
  if (booted.server) return
  if (typeof ctx?.provider?.transform !== "function") return
  booted.server = true

  let current = await readStore()
  try {
    await ctx.provider.transform((editor) => {
      for (const [id, p] of Object.entries(current.providers)) {
        // Only register models that still exist in the cached catalog, so a
        // stale entry in the store never surfaces as a dead model in opencode.
        const known = p.catalog && typeof p.catalog === "object" ? p.catalog : undefined
        const enabled = (p.models ?? []).filter((m) => !known || Object.hasOwn(known, m))
        editor.add({
          info: makeProviderInfo(id, p),
          models: enabled.map((m) => makeModelInfo(id, m, p)),
        })
      }
    })
  } catch (error) {
    console.error("[provider-manager] provider transform failed:", error?.message ?? error)
    return
  }

  // Watch the config directory (atomic rename detaches a file-only watch).
  let timer
  let fsWatcher
  try {
    fsWatcher = watch(CONFIG_DIR, (_event, filename) => {
      if (filename && filename !== "provider-manager.json" && filename !== "provider-manager.json.tmp") return
      clearTimeout(timer)
      timer = setTimeout(() => {
        void (async () => {
          current = await readStore()
          await ctx.provider.reload()
        })().catch((error) => console.error("[provider-manager] reload failed:", error))
      }, 250)
    })
  } catch (error) {
    console.error("[provider-manager] store watch failed:", error)
  }

  return () => {
    clearTimeout(timer)
    fsWatcher?.close()
  }
}

/* -------------------------------------------------------------- TUI side */

async function invalidateData(context) {
  try {
    const location = context.location ?? context.data.location.default()
    await context.data.location.provider.invalidate(location)
    await context.data.location.model.invalidate(location)
  } catch {
    // cache invalidation is best-effort
  }
}

/**
 * Multi-select picker — preferred UX: a custom Solid dialog (searchable live
 * list, instant ☑/☐ re-render on Space, Enter saves, Esc cancels), built on
 * OpenTUI via `ui.dialog.show`. Falls back to the dialog.select toggle loop
 * when the OpenTUI stack is unavailable or errors (e.g. server-side context).
 */
let pickerModule
async function chooseToggle(context, title, entries, initial, describe) {
  try {
    // Primary: import the .jsx source directly. The OpenTUI Bun plugin
    // installed by OpenCode transforms non-node_modules .jsx with
    // babel-preset-solid, which is what makes props/children truly reactive
    // (esbuild's JSX output evaluates props eagerly and freezes row styling).
    // Fallback: the prebuilt picker.js (static-props behaviour, still usable).
    let picker
    try {
      picker = await import(`./picker.jsx?v=${Date.now()}`)
    } catch {
      try {
        picker = await import(`./picker.js?v=${Date.now()}`)
      } catch {
        picker = pickerModule ??= await import("./picker.js")
      }
    }
    pickerModule = picker
    const picked = await picker.pickModels(context, {
      title,
      entries: entries.map((entry) => ({ id: entry.id, label: describe(entry) ?? "" })),
      initial,
    })
    return picked
  } catch (error) {
    context.ui?.toast?.show?.({
      title: "Provider Manager",
      message: `Custom picker unavailable (${String(error?.message ?? error).slice(0, 90)}) — dialog fallback`,
      variant: "warning",
      duration: 2500,
    })
  }

  // Fallback: dialog.select toggle loop (Enter toggles and reopens).
  const dialog = context.ui.dialog
  const selected = new Set(initial)
  for (;;) {
    let saved = false
    const pick = await dialog.select({
      title,
      options: entries.map((entry) => ({
        title: `${selected.has(entry.id) ? "☑" : "☐"} ${entry.id}`,
        value: entry.id,
        description: describe(entry),
        category: "Models",
      })),
      actions: [
        {
          bind: "space",
          title: "Toggle",
          onTrigger: (value) => {
            if (!value) return
            if (selected.has(value)) selected.delete(value)
            else selected.add(value)
            context.ui.toast.show({
              title: "Selected",
              message: `${value} — ${selected.size} model(s). Enter saves.`,
              duration: 1200,
            })
          },
        },
        {
          bind: "return",
          title: "Save",
          selection: "none",
          onTrigger: () => {
            saved = true
            dialog.clear()
          },
        },
      ],
      search: (query, enabled) => {
        const q = (query ?? "").toLowerCase()
        if (!q) return enabled
        return enabled.filter(
          (o) => o.title.toLowerCase().includes(q) || String(o.description ?? "").toLowerCase().includes(q),
        )
      },
    })
    if (saved) return [...selected]
    if (!pick) return undefined
    // Degraded path: if the Enter binding is not honoured and an option
    // resolves instead, treat it as a toggle and reopen with the count hint.
    context.ui.toast.show({
      title: "Hint",
      message: "Enter is Save. Press Space to toggle models.",
      duration: 2000,
    })
  }
}

async function fetchAndPick(context, provider) {
  const dialog = context.ui.dialog
  let catalog = []
  let failure
  try {
    context.ui.toast.show({ title: "Provider Manager", message: `Fetching models from ${provider.baseURL}…` })
    catalog = await fetchCatalog(provider.baseURL, provider.apiKey)
  } catch (error) {
    failure = error
  }

  if (catalog.length === 0) {
    const cached = provider.catalog && typeof provider.catalog === "object"
      ? Object.entries(provider.catalog).map(([id, name]) => ({ id, name }))
      : []
    if (cached.length > 0) {
      catalog = cached
      context.ui.toast.show({
        title: "Provider Manager",
        message: `Fetch failed (${String(failure?.message ?? failure).slice(0, 80)}) — using cached catalog`,
        variant: "warning",
        duration: 3500,
      })
    } else {
      await dialog.alert({
        title: "Fetch failed",
        message: `${failure?.message ?? failure}\n\nTip: check the Base URL (must include /v1) and API key. You can still enter model IDs manually.`,
      })
      const manual = await dialog.prompt({
        title: "Model IDs (comma-separated)",
        placeholder: "model-a, model-b",
      })
      if (!manual) return
      catalog = String(manual)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => ({ id, name: id }))
    }
  }
  if (catalog.length === 0) {
    await dialog.alert({ title: "No models", message: "The endpoint returned no models." })
    return
  }

  // A fresh catalog is the source of truth: drop enabled models the provider no
  // longer offers so opencode never lists dead models.
  const offered = new Set(catalog.map((m) => m.id))
  const before = provider.models ?? []
  const keep = before.filter((id) => offered.has(id))
  const removed = before.length - keep.length
  provider.catalog = Object.fromEntries(catalog.map((m) => [m.id, m.name]))
  provider.models = keep
  if (removed > 0) {
    context.ui.toast.show({
      title: "Provider Manager",
      message: `Removed ${removed} model(s) no longer offered`,
      duration: 3000,
    })
  }

  const picked = await chooseToggle(
    context,
    `Enable models · ${provider.name} (${catalog.length} found)`,
    catalog,
    keep,
    (m) => (m.name !== m.id ? m.name : undefined),
  )
  if (picked) provider.models = picked.filter((id) => offered.has(id))
}

async function addProvider(context) {
  const dialog = context.ui.dialog
  const idRaw = await dialog.prompt({ title: "Provider ID", placeholder: "e.g. vyce (a-z, 0-9, -)" })
  if (!idRaw) return
  const id = slugify(String(idRaw))
  const store = await readStore()
  if (store.providers[id]) {
    await dialog.alert({ title: "Exists", message: `Provider "${id}" already exists. Edit it instead.` })
    return
  }
  const name = String((await dialog.prompt({ title: "Display name", placeholder: id })) ?? "").trim() || id
  const baseURL = String((await dialog.prompt({ title: "Base URL", placeholder: "https://api.example.com/v1" })) ?? "").trim()
  if (!baseURL) return
  const apiKey = String((await dialog.prompt({ title: "API key (optional)", placeholder: "sk-… — leave empty if none" })) ?? "").trim()

  const provider = { name, baseURL, models: [] }
  if (apiKey) provider.apiKey = apiKey
  await fetchAndPick(context, provider)
  if ((provider.models ?? []).length === 0) {
    const saveAnyway = await dialog.confirm({
      title: "No models enabled",
      message: "No models selected. Save this provider anyway?",
      label: { confirm: "Save", cancel: "Discard" },
    })
    if (!saveAnyway) return
  }
  store.providers[id] = provider
  await writeStore(store)
  await invalidateData(context)
  context.ui.toast.show({ title: "Provider Manager", message: `Provider "${id}" saved`, variant: "success" })
}

async function openProvider(context, id) {
  const dialog = context.ui.dialog
  for (;;) {
    const store = await readStore()
    const provider = store.providers[id]
    if (!provider) return

    // Proactively drop enabled models missing from the cached catalog, so a
    // rotated-away free model disappears as soon as the provider is opened.
    if (provider.catalog && typeof provider.catalog === "object") {
      const before = (provider.models ?? []).length
      provider.models = (provider.models ?? []).filter((m) => Object.hasOwn(provider.catalog, m))
      if (provider.models.length !== before) {
        await writeStore(store)
        await invalidateData(context)
        context.ui.toast.show({
          title: "Provider Manager",
          message: `Removed ${before - provider.models.length} stale model(s)`,
          duration: 3000,
        })
      }
    }

    const enabledCount = (provider.models ?? []).length
    const pick = await dialog.select({
      title: `Provider · ${provider.name} (${id})`,
      options: [
        { title: "👁 View details", value: "view", category: "Info" },
        { title: `🎛 Choose enabled models (${enabledCount})`, value: "models", category: "Edit" },
        { title: "✏️ Edit connection (name / baseURL / apiKey)", value: "conn", category: "Edit" },
        { title: "🗑 Delete provider", value: "delete", category: "Danger" },
        { title: "← Back", value: "back", category: "Actions" },
      ],
    })
    if (!pick || pick === "back") return

    if (pick === "view") {
      const models = provider.models?.length ? provider.models.join(", ") : "(none)"
      await dialog.alert({
        title: provider.name,
        message: `ID:      ${id}\nName:    ${provider.name}\nURL:     ${provider.baseURL}\nAPI key: ${maskKey(provider.apiKey)}\nEnabled models (${provider.models?.length ?? 0}): ${models}`,
      })
      continue
    }

    if (pick === "models") {
      // Single entry point: refresh the catalog (falling back to the cached
      // one offline), auto-prune models the provider dropped, then let the
      // user toggle the rest.
      await fetchAndPick(context, provider)
      await writeStore(store)
      await invalidateData(context)
      context.ui.toast.show({
        title: "Provider Manager",
        message: `${(provider.models ?? []).length} models enabled for "${id}"`,
        variant: "success",
      })
      continue
    }

    if (pick === "conn") {
      const name = String((await dialog.prompt({ title: "Display name (empty = keep)", placeholder: provider.name })) ?? "").trim()
      const baseURL = String((await dialog.prompt({ title: "Base URL (empty = keep)", placeholder: provider.baseURL })) ?? "").trim()
      const apiKey = String((await dialog.prompt({ title: "API key (empty = keep, type 'none' to remove)", placeholder: maskKey(provider.apiKey) })) ?? "").trim()
      if (name) provider.name = name
      if (baseURL) provider.baseURL = baseURL
      if (apiKey) provider.apiKey = apiKey.toLowerCase() === "none" ? undefined : apiKey
      await writeStore(store)
      await invalidateData(context)
      context.ui.toast.show({ title: "Provider Manager", message: `Provider "${id}" updated`, variant: "success" })
      continue
    }

    if (pick === "delete") {
      const confirmed = await dialog.confirm({
        title: "Delete provider?",
        message: `Remove "${provider.name}" (${id}) from the manager?`,
        label: { confirm: "Delete", cancel: "Cancel" },
      })
      if (!confirmed) continue
      delete store.providers[id]
      await writeStore(store)
      await invalidateData(context)
      context.ui.toast.show({ title: "Provider Manager", message: `Provider "${id}" deleted`, variant: "success" })
      return
    }
  }
}

async function importFromConfig(context) {
  const dialog = context.ui.dialog
  let config
  try {
    config = JSON.parse(await readFile(OPENCODE_JSON, "utf8"))
  } catch (error) {
    await dialog.alert({ title: "Import", message: `Cannot read opencode.json:\n${error?.message ?? error}` })
    return
  }
  const sources = {}
  for (const key of ["provider", "providers"]) {
    const block = config?.[key]
    if (block && typeof block === "object") Object.assign(sources, block)
  }
  const entries = Object.entries(sources).filter(([id]) => id && id !== "$schema")
  if (entries.length === 0) {
    await dialog.alert({ title: "Import", message: "No providers found in the global opencode.json." })
    return
  }

  const candidates = entries.map(([id, block]) => {
    const settings = block?.settings ?? block?.options ?? {}
    const modelMap = block?.models ?? {}
    const models = Object.keys(modelMap).filter((k) => !(modelMap[k] && modelMap[k].disabled))
    return { id, name: block?.name ?? id, baseURL: String(settings.baseURL ?? ""), apiKey: settings.apiKey, models }
  })

  const picked = await chooseToggle(
    context,
    "Import providers from opencode.json",
    candidates.map((c) => ({ id: c.id, name: c.baseURL || "(no baseURL)" })),
    [],
    (m) => {
      const c = candidates.find((x) => x.id === m.id)
      if (!c) return undefined
      return c.baseURL ? `${c.baseURL} · ${c.models.length} models` : "⚠ no baseURL — you will be asked"
    },
  )
  if (!picked || picked.length === 0) return

  const store = await readStore()
  for (const id of picked) {
    const c = candidates.find((x) => x.id === id)
    if (!c) continue
    let baseURL = c.baseURL
    if (!baseURL) {
      baseURL = String((await dialog.prompt({ title: `Base URL for "${id}"`, placeholder: "https://api.example.com/v1" })) ?? "").trim()
      if (!baseURL) continue
    }
    store.providers[slugify(id)] = {
      name: c.name,
      baseURL,
      ...(c.apiKey ? { apiKey: c.apiKey } : {}),
      models: c.models,
    }
  }
  await writeStore(store)
  await invalidateData(context)
  context.ui.toast.show({ title: "Provider Manager", message: `Imported ${picked.length} provider(s)`, variant: "success" })
}

async function mainMenu(context) {
  const dialog = context.ui.dialog
  for (;;) {
    const store = await readStore()
    const ids = Object.keys(store.providers)
    const options = [
      { title: "＋ Add provider (fetch & pick models)", value: "add", category: "Actions" },
      { title: "↺ Import providers from opencode.json", value: "import", category: "Actions" },
      ...ids.map((id) => ({
        title: store.providers[id].name || id,
        value: `open:${id}`,
        description: `${store.providers[id].baseURL} · ${(store.providers[id].models ?? []).length} models enabled · key ${maskKey(store.providers[id].apiKey)}`,
        category: "Providers",
      })),
      { title: "Exit", value: "exit", category: "Actions" },
    ]
    const pick = await dialog.select({
      title: "Provider Manager",
      options,
      search: (query, enabled) => {
        const q = (query ?? "").toLowerCase()
        if (!q) return enabled
        return enabled.filter(
          (o) => o.title.toLowerCase().includes(q) || String(o.description ?? "").toLowerCase().includes(q),
        )
      },
    })
    if (!pick || pick === "exit") return
    if (pick === "add") await addProvider(context)
    else if (pick === "import") await importFromConfig(context)
    else if (pick.startsWith("open:")) await openProvider(context, pick.slice(5))
  }
}

async function tuiSetup(context) {
  if (booted.tui) return
  if (typeof context?.keymap?.layer !== "function" || typeof context?.ui?.dialog?.select !== "function") return
  booted.tui = true

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "provider-manager.menu",
        title: "Manage providers & models",
        group: "Provider Manager",
        palette: true,
        slash: { name: "provider" },
        run: () => void mainMenu(context),
      },
    ],
  }))
  try {
    context.ui.toast.show({ title: "Provider Manager", message: "Loaded — type /provider to manage providers", duration: 4000 })
  } catch {
    // toasts are cosmetic
  }
}

/* ------------------------------------------------------------ entrypoint */

/**
 * Handles both server and TUI loads. The same module instance may be loaded
 * per process, so each branch runs at most once.
 */
async function bootstrap(ctx) {
  if (!ctx) return undefined
  if (typeof ctx.keymap?.layer === "function" && typeof ctx.ui?.dialog?.select === "function") {
    await tuiSetup(ctx)
    return undefined
  }
  if (ctx.provider?.transform) return serverSetup(ctx)
  return undefined
}

const plugin = {
  id: "provider-manager",
  server: bootstrap,
  setup: bootstrap,
}

export default plugin
export { plugin as ProviderManagerPlugin, tuiSetup }
