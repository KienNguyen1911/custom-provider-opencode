# custom-provider-opencode

An interactive provider and model manager for [OpenCode](https://opencode.ai).
Add any OpenAI-compatible endpoint, fetch its model list, and choose exactly
which models appear in OpenCode — all from the `/provider` command inside the
TUI. No hand-editing of `opencode.json` required.

```
┌ Provider Manager ─────────────────────────────────────────┐
│ ＋ Add provider (fetch & pick models)                    │
│ ↺ Import providers from opencode.json                    │
│ Example Provider   https://api.example.com/v1 · 2 models │
│ Exit                                                      │
└───────────────────────────────────────────────────────────┘
```

## Features

- **`/provider` TUI command** — add, inspect, edit, and delete providers.
- **Automatic model discovery** — calls `GET {baseURL}/models` and caches the
  catalog, with manual model-ID entry as a fallback.
- **Searchable multi-select picker** — type to filter, `↑`/`↓` to move,
  `Space` to toggle, `Enter` to save, `Esc` to cancel. Mouse clicks work too.
- **Live reload** — enabling or disabling models applies without restarting
  OpenCode (the plugin watches its store file and calls `provider.reload()`).
- **Stale model pruning** — models the provider no longer offers disappear from
  the selection instead of lingering as dead entries.
- **Import from `opencode.json`** — migrate providers you already configured
  manually into the manager.
- **No config pollution** — managed providers live in a plugin-owned store,
  not in your `opencode.json`.

## Requirements

- OpenCode **v2.1+**
- Node.js **20+** (for local development / building the picker)

## Install

### From GitHub (recommended)

```sh
opencode plugin add github:KienNguyen1911/custom-provider-opencode
```

Then restart the background service if it was already running:

```sh
opencode service restart
```

### Manually via `opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:KienNguyen1911/custom-provider-opencode"]
}
```

### Local development install

```sh
git clone https://github.com/KienNguyen1911/custom-provider-opencode.git \
  ~/.config/opencode/plugins/opencode-provider-manager
```

On Windows PowerShell:

```powershell
git clone https://github.com/KienNguyen1911/custom-provider-opencode.git `
  "$env:USERPROFILE\.config\opencode\plugins\opencode-provider-manager"
```

OpenCode discovers immediate plugin package directories under the global
`plugins/` directory automatically. Restart OpenCode after cloning.

## Usage

1. Open the TUI and run:

   ```
   /provider
   ```

2. Choose **Add provider** and enter:
   - **Provider ID** — lowercase slug, e.g. `my-provider`
   - **Display name** — shown in the model picker
   - **Base URL** — must be the OpenAI-compatible root, usually ending in `/v1`,
     e.g. `https://api.example.com/v1`
   - **API key** — optional; leave empty for unauthenticated endpoints

3. The plugin fetches `{baseURL}/models`, then opens the picker. Select the
   models you want and press `Enter`.

4. Press `Esc` to leave the manager. The enabled models are available
   immediately in OpenCode's model picker.

Existing providers can be reopened to:

- **View details** — URL, masked key, and enabled models
- **Choose enabled models** — refresh the catalog and change the selection
- **Edit connection** — update name, base URL, or API key
- **Delete provider**

## How it works

The package exposes two entry points:

| Export | File | Runtime | Responsibility |
| --- | --- | --- | --- |
| `.` | `index.js` | OpenCode server | Registers managed providers through `ctx.provider.transform()`, watches the store, reloads on change |
| `./tui` | `tui.js` | OpenCode TUI | Registers the `/provider` slash command and the dialogs/picker |

Providers are registered with the built-in
`@opencode/ai/providers/openai-compatible` package, so any endpoint that speaks
the OpenAI chat-completions API works.

The store is a plain JSON file:

```
~/.config/opencode/provider-manager.json
```

Override the config directory with `OPENCODE_CONFIG_DIR` if you use a
non-default location.

## Store format

```json
{
  "providers": {
    "example": {
      "name": "Example Provider",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "models": ["example-chat", "example-reasoning"],
      "catalog": {
        "example-chat": "Example Chat",
        "example-reasoning": "Example Reasoning"
      }
    }
  }
}
```

- `models` — enabled model IDs
- `catalog` — last fetched model inventory (`id → display name`), used for
  offline selection and display names
- `apiKey` — optional, stored in plain text

See [`provider-manager.example.json`](./provider-manager.example.json) for a
blank template.

## Security

- The store contains API keys in **plain text**. It is intentionally excluded
  from this repository via `.gitignore`; never commit a real
  `provider-manager.json`.
- On shared machines, restrict the file permissions:

  ```sh
  chmod 600 ~/.config/opencode/provider-manager.json
  ```

- Keys entered in the TUI are displayed masked (first 4 / last 4 characters)
  and are only sent to the configured `baseURL`.
- If a key leaks, rotate it with the provider and update it via
  **Edit connection**.

## Development

```sh
npm install

# Syntax-check the runtime files
npm run check

# Rebuild the precompiled picker from picker.jsx
npm run build:picker
```

`index.js` imports `picker.jsx` first when running from a writable local
directory (the OpenTUI Bun plugin transforms it with `babel-preset-solid` for
fully reactive props). When the package is installed under `node_modules`, that
transform is unavailable, so it falls back to the precompiled `picker.js`.
Always rebuild `picker.js` after changing `picker.jsx`.

## Limitations

- Only OpenAI-compatible providers are supported out of the box. Providers that
  need custom headers, OAuth, or a different protocol require code changes.
- Model capabilities and limits are conservative defaults (tools + text/image
  input, 256k context, 8k output). Edit `makeModelInfo()` in `index.js` if a
  provider needs different metadata.
- The plugin manages only models exposed by the provider's `/models` endpoint;
  use manual model IDs when discovery is unavailable.

## License

[MIT](./LICENSE)
