/** @jsxImportSource @opentui/solid */
/**
 * Custom searchable multi-select dialog for the provider-manager plugin.
 *
 * UX (exactly as requested):
 *   - type anywhere to filter models live
 *   - arrow keys move the cursor, SPACE toggles the highlighted model
 *   - ticks (☑/☐) re-render instantly (Solid signals)
 *   - ENTER saves the selection, ESC cancels
 *
 * kb6 — keyboard capture is attached in pickModels() (plain module code, no
 * component lifecycle involved) on THREE channels, lowest first:
 *   1. renderer.prependInputHandler(rawSequence)  — sees stdin sequences before
 *      the keypress event exists; consumes them (returns true) while open.
 *   2. renderer.keyInput.prependListener("keypress") — fallback if the raw
 *      channel is unavailable; also records which channel receives keys.
 *   3. stdin "data" listener — last resort if the plugin holds a stale renderer
 *      reference (e.g. after an in-process renderer handoff). It stays inert
 *      once channel 1 has delivered a single sequence.
 * The footer shows attach status and the last received key ("key: …"), so one
 * screenshot tells exactly which channel is alive:
 *   "ready kb=y raw=y" → nothing pressed yet
 *   "raw:…"            → renderer raw channel works
 *   "kb:…"             → keypress channel works
 *   "stdin:…"          → only the process stdin fallback works
 *
 * Compiled with esbuild (--jsx=automatic --jsx-import-source=@opentui/solid)
 * into picker.js which is dynamically imported by the TUI side only.
 */
import { createSignal, For, Show } from "solid-js";
import { CliRenderEvents, TextAttributes } from "@opentui/core";
// Written as "@opentui/solid" so the compiled output matches the runtime package name.
import { useTerminalDimensions } from "@opentui/solid";

export function pickModels(context, { title, entries, initial }) {
  const store = { result: null };
  const [selected, setSelected] = createSignal(new Set(initial ?? []));
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [diag, setDiag] = createSignal("booting…");
  const view = { scroll: undefined };

  const filtered = () => {
    const q = query().trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.id.toLowerCase().includes(q) ||
        String(entry.label ?? "").toLowerCase().includes(q),
    );
  };

  const note = (text) => setDiag(text);
  const scrollToTop = () => {
    try {
      view.scroll?.scrollTo(0);
    } catch {}
  };
  // Keep the highlighted row inside the scroll viewport. Same technique the
  // built-in DialogSelect uses: wait one frame, then compare the row's y with
  // the viewport bounds. Never mix scrolling into cursor movement directly.
  let pendingScroll;
  const ensureVisible = (index) => {
    const scroll = view.scroll;
    if (!scroll) return;
    const run = () => {
      try {
        const target = scroll.getChildren?.()[index];
        if (!target) {
          // Fallback for layouts where children are wrapped: rows are one
          // line tall, so index math is enough to keep the cursor visible.
          const top = scroll.scrollTop ?? 0;
          const view = scroll.height ?? 0;
          if (view > 0 && index < top) scroll.scrollTo(index);
          else if (view > 0 && index >= top + view) scroll.scrollTo(index - view + 1);
          return;
        }
        const y = target.y - scroll.y;
        if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1);
        else if (y < 0) scroll.scrollBy(y);
      } catch {}
    };
    const renderer = context.renderer;
    if (!renderer?.once) return run();
    if (pendingScroll) {
      try {
        renderer.off(CliRenderEvents.FRAME, pendingScroll);
      } catch {}
    }
    pendingScroll = () => {
      pendingScroll = undefined;
      run();
    };
    try {
      renderer.once(CliRenderEvents.FRAME, pendingScroll);
      renderer.requestRender?.();
    } catch {
      run();
    }
  };
  const toggleId = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAt = (index) => {
    const entry = filtered()[index];
    if (entry) toggleId(entry.id);
  };
  const moveCursor = (delta) => {
    const count = filtered().length;
    if (count === 0) return;
    const next = (((cursor() + delta) % count) + count) % count;
    setCursor(next);
    ensureVisible(next);
  };
  const jumpTo = (index) => {
    const count = filtered().length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(index, count - 1));
    setCursor(next);
    ensureVisible(next);
  };
  const typeChar = (ch) => {
    setQuery(query() + ch);
    setCursor(0);
    scrollToTop();
  };
  const backspace = () => {
    const q = query();
    if (!q) return;
    setQuery([...q].slice(0, -1).join(""));
    setCursor(0);
    scrollToTop();
  };
  const save = () => {
    store.result = [...selected()];
    context.ui.dialog.clear();
  };
  const cancel = () => context.ui.dialog.clear();

  const applyAction = (action) => {
    if (!action) return;
    switch (action.type) {
      case "up": moveCursor(-1); break;
      case "down": moveCursor(1); break;
      case "pageup": jumpTo(cursor() - 10); break;
      case "pagedown": jumpTo(cursor() + 10); break;
      case "home": jumpTo(0); scrollToTop(); break;
      case "end": jumpTo(filtered().length - 1); break;
      case "space": toggleAt(cursor()); break;
      case "return": save(); break;
      case "escape": cancel(); break;
      case "ctrl-c": cancel(); break;
      case "backspace": backspace(); break;
      case "char": typeChar(action.ch); break;
      default: break;
    }
  };

  // --------------------------------------------------------------------------
  // Attach keyboard capture BEFORE the dialog mounts; detach when it closes.
  // --------------------------------------------------------------------------
  const renderer = context.renderer;
  const keyInput = renderer?.keyInput;
  const disposers = [];
  let rawWorks = false;
  let rawSeq = 0;

  if (keyInput && typeof keyInput.prependListener === "function") {
    const onKey = (event) => {
      note("kb:" + (typeof event?.name === "string" && event.name ? event.name : "?"));
      if (!rawWorks) applyAction(actionFromKeyEvent(event));
      try {
        event?.preventDefault?.();
        event?.stopPropagation?.();
      } catch {}
    };
    keyInput.prependListener("keypress", onKey);
    disposers.push(() => {
      try {
        keyInput.off("keypress", onKey);
      } catch {}
    });
  }

  if (typeof renderer?.prependInputHandler === "function") {
    const onRaw = (sequence) => {
      rawWorks = true;
      rawSeq += 1;
      const action = parseRawSequence(sequence);
      note(`raw:${action ? action.type + (action.ch ? " " + action.ch : "") : describeSequence(sequence)}`);
      applyAction(action);
      return shouldConsume(sequence);
    };
    renderer.prependInputHandler(onRaw);
    disposers.push(() => {
      try {
        renderer.removeInputHandler?.(onRaw);
      } catch {}
    });
  }

  // Channel 3: raw bytes straight off the stdin stream. The renderer registers
  // its own "data" listener during startup, so it always runs before this one;
  // if the renderer channel is alive, rawSeq has already advanced and this
  // listener stays inert. It only acts when no renderer sequence ever arrived.
  const stdin = renderer?.stdin ?? (typeof process !== "undefined" ? process.stdin : undefined);
  if (stdin && typeof stdin.on === "function") {
    const onChunk = (chunk) => {
      if (rawSeq > 0) return;
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (!text) return;
      note(`stdin:${describeSequence(text)}`);
      for (const action of parseChunk(text)) applyAction(action);
    };
    stdin.on("data", onChunk);
    disposers.push(() => {
      try {
        stdin.off("data", onChunk);
      } catch {}
    });
  }

  const detach = () => {
    while (disposers.length) {
      try {
        disposers.pop()();
      } catch {}
    }
  };

  note(
    `ready kb=${keyInput && typeof keyInput.prependListener === "function" ? "y" : "n"}` +
      ` raw=${typeof renderer?.prependInputHandler === "function" ? "y" : "n"}`,
  );

  return new Promise((resolve) => {
    try {
      context.ui.dialog.show(
        () =>
          PickerView({
            context,
            title,
            entries,
            selected,
            query,
            cursor,
            diag,
            filtered,
            view,
            toggleAt,
          }),
        () => {
          detach();
          resolve(store.result);
        },
      );
      context.ui.dialog.set({ size: "large", centered: true });
    } catch (error) {
      detach();
      throw error;
    }
  });
}

function PickerView(props) {
  const theme = () => props.context.theme.surface("dialog");
  const dimensions = useTerminalDimensions();

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme().text.base}>
          {props.title}
        </text>
        <text fg={theme().text.muted}>{`${props.selected().size} selected`}</text>
      </box>

      <box flexDirection="row" paddingLeft={1}>
        <text wrapMode="none" fg={theme().text.action.primary.selected} attributes={TextAttributes.BOLD}>
          {`❯ ${props.query()}`}
        </text>
        <text wrapMode="none" fg={theme().text.action.primary.selected}>
          {"▌"}
        </text>
      </box>

      <scrollbox
        ref={(element) => {
          props.view.scroll = element;
        }}
        flexDirection="column"
        maxHeight={Math.max(6, Math.floor(dimensions().height * 0.65))}
      >
        <Show
          when={props.filtered().length > 0}
          fallback={<text fg={theme().text.muted}>No model matches the filter (esc to cancel)</text>}
        >
          <For each={props.filtered()}>
            {(entry, index) => {
              const active = () => index() === props.cursor();
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme().background.action.primary.focused : undefined}
                  onMouseUp={() => {
                    props.toggleAt(index());
                  }}
                >
                  <text
                    wrapMode="none"
                    fg={active() ? theme().text.action.primary.focused : theme().text.base}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                  >
                    {`${active() ? "▸" : " "}${props.selected().has(entry.id) ? "☑" : "☐"} ${entry.id}`}
                  </text>
                  <text wrapMode="none" fg={active() ? theme().text.action.primary.focused : theme().text.muted}>
                    {entry.label ? `  ${entry.label}` : ""}
                  </text>
                </box>
              );
            }}
          </For>
        </Show>
      </scrollbox>

      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.muted}>
          {`⏎ save · ␣ toggle · ↑↓ move · esc cancel · key: ${props.diag()}`}
        </text>
        <text fg={theme().text.muted}>{`${props.filtered().length}/${props.entries.length} models · kb6`}</text>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Key decoders
// ---------------------------------------------------------------------------

function printableChar(event) {
  const name = typeof event.name === "string" ? event.name : "";
  const sequence = typeof event.sequence === "string" ? event.sequence : "";
  const candidate = [...sequence].length === 1 ? sequence : [...name].length === 1 ? name : undefined;
  if (!candidate || candidate < " ") return undefined;
  return candidate;
}

function actionFromKeyEvent(event) {
  const name = typeof event?.name === "string" ? event.name : "";
  const ctrl = event?.ctrl === true;
  if (name === "escape") return { type: "escape" };
  if (name === "return" || name === "enter") return { type: "return" };
  if (ctrl && name === "c") return { type: "ctrl-c" };
  if (ctrl) return null;
  if (name === "space") return { type: "space" };
  if (name === "up") return { type: "up" };
  if (name === "down") return { type: "down" };
  if (name === "pageup") return { type: "pageup" };
  if (name === "pagedown") return { type: "pagedown" };
  if (name === "home") return { type: "home" };
  if (name === "end") return { type: "end" };
  if (name === "backspace") return { type: "backspace" };
  const ch = printableChar(event);
  if (ch) return { type: "char", ch };
  return null;
}

function csiAction(final, params) {
  switch (final) {
    case "A": return { type: "up" };
    case "B": return { type: "down" };
    case "H": return { type: "home" };
    case "F": return { type: "end" };
    case "~": {
      const code = Number((params || "").split(";")[0]);
      if (code === 1 || code === 7) return { type: "home" };
      if (code === 4 || code === 8) return { type: "end" };
      if (code === 5) return { type: "pageup" };
      if (code === 6) return { type: "pagedown" };
      return { type: "ignore" };
    }
    default:
      return { type: "ignore" };
  }
}

/** Decodes one raw stdin sequence (the parser already split them per key). */
function parseRawSequence(sequence) {
  if (typeof sequence !== "string" || sequence.length === 0) return null;
  if (sequence === "\r" || sequence === "\n") return { type: "return" };
  if (sequence === "\x7f" || sequence === "\x08") return { type: "backspace" };
  if (sequence === "\x03") return { type: "ctrl-c" };
  if (sequence === "\x1b") return { type: "escape" };
  if (sequence === " ") return { type: "space" };
  if (sequence === "\t") return { type: "ignore" };

  if (sequence.length > 1 && sequence.charCodeAt(0) === 0x1b) {
    // kitty CSI-u: ESC [ codepoint (;modifiers)? u
    let match = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(sequence);
    if (match) {
      const code = Number(match[1]);
      const mods = match[2] ? Number(match[2]) - 1 : 0;
      const ctrl = (mods & 4) !== 0;
      if (code === 13 || code === 10) return { type: "return" };
      if (code === 27) return { type: "escape" };
      if (code === 32) return { type: "space" };
      if (code === 127) return { type: "backspace" };
      if (ctrl) return code === 99 ? { type: "ctrl-c" } : { type: "ignore" };
      if (code >= 32) return { type: "char", ch: String.fromCodePoint(code) };
      return { type: "ignore" };
    }
    // CSI cursor/edit keys: ESC [ params final
    match = /^\x1b\[([0-9;]*)([A-Za-z~])$/.exec(sequence);
    if (match) return csiAction(match[2], match[1]);
    // SS3 cursor keys: ESC O final
    match = /^\x1bO([A-Za-z])$/.exec(sequence);
    if (match) return csiAction(match[1], "");
    return { type: "ignore" };
  }

  const chars = [...sequence];
  if (chars.length === 1 && chars[0] >= " ") return { type: "char", ch: chars[0] };
  return { type: "ignore" };
}

/** Splits a raw stdin chunk that may hold several keys into actions. */
function parseChunk(text) {
  const actions = [];
  let rest = text;
  let guard = 0;
  while (rest.length > 0 && guard < 64) {
    guard += 1;
    if (rest.startsWith("\x1b]") || rest.startsWith("\x1bP") || rest.startsWith("\x1b_G")) {
      break; // OSC/DCS/kitty graphics — terminal machinery, not keys
    }
    if (rest.startsWith("\x1b")) {
      let match = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (!match) match = /^\x1bO[A-Za-z]/.exec(rest);
      if (match) {
        const action = parseRawSequence(match[0]);
        if (action) actions.push(action);
        rest = rest.slice(match[0].length);
        continue;
      }
      actions.push({ type: "escape" });
      rest = rest.slice(1);
      continue;
    }
    const char = String.fromCodePoint(rest.codePointAt(0));
    const action = parseRawSequence(char);
    if (action) actions.push(action);
    rest = rest.slice(char.length);
  }
  return actions;
}

/**
 * Consume keys while the picker is open, but let terminal machinery keep its
 * own responses (theme notifications, capability replies, focus events, ...).
 */
function shouldConsume(sequence) {
  if (typeof sequence !== "string" || sequence.length === 0) return false;
  if (sequence.startsWith("\x1b]")) return false; // OSC (theme, capabilities)
  if (sequence.startsWith("\x1bP")) return false; // DCS
  if (sequence.startsWith("\x1b_G")) return false; // kitty graphics
  if (sequence === "\x1b[I" || sequence === "\x1b[O") return false; // focus in/out
  if (/^\x1b\[[0-9;?]*[cR]$/.test(sequence)) return false; // DA / cursor reports
  return true;
}

function describeSequence(sequence) {
  try {
    return JSON.stringify(sequence).slice(1, -1).slice(0, 24);
  } catch {
    return String(sequence);
  }
}

