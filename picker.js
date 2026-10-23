import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
import { createSignal, For, Show } from "solid-js";
import { CliRenderEvents, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
function pickModels(context, { title, entries, initial }) {
  const store = { result: null };
  const [selected, setSelected] = createSignal(new Set(initial ?? []));
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [diag, setDiag] = createSignal("booting\u2026");
  const view = { scroll: void 0 };
  const filtered = () => {
    const q = query().trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (entry) => entry.id.toLowerCase().includes(q) || String(entry.label ?? "").toLowerCase().includes(q)
    );
  };
  const note = (text) => setDiag(text);
  const scrollToTop = () => {
    try {
      view.scroll?.scrollTo(0);
    } catch {
    }
  };
  let pendingScroll;
  const ensureVisible = (index) => {
    const scroll = view.scroll;
    if (!scroll) return;
    const run = () => {
      try {
        const target = scroll.getChildren?.()[index];
        if (!target) {
          const top = scroll.scrollTop ?? 0;
          const view2 = scroll.height ?? 0;
          if (view2 > 0 && index < top) scroll.scrollTo(index);
          else if (view2 > 0 && index >= top + view2) scroll.scrollTo(index - view2 + 1);
          return;
        }
        const y = target.y - scroll.y;
        if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1);
        else if (y < 0) scroll.scrollBy(y);
      } catch {
      }
    };
    const renderer2 = context.renderer;
    if (!renderer2?.once) return run();
    if (pendingScroll) {
      try {
        renderer2.off(CliRenderEvents.FRAME, pendingScroll);
      } catch {
      }
    }
    pendingScroll = () => {
      pendingScroll = void 0;
      run();
    };
    try {
      renderer2.once(CliRenderEvents.FRAME, pendingScroll);
      renderer2.requestRender?.();
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
    const next = ((cursor() + delta) % count + count) % count;
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
      case "up":
        moveCursor(-1);
        break;
      case "down":
        moveCursor(1);
        break;
      case "pageup":
        jumpTo(cursor() - 10);
        break;
      case "pagedown":
        jumpTo(cursor() + 10);
        break;
      case "home":
        jumpTo(0);
        scrollToTop();
        break;
      case "end":
        jumpTo(filtered().length - 1);
        break;
      case "space":
        toggleAt(cursor());
        break;
      case "return":
        save();
        break;
      case "escape":
        cancel();
        break;
      case "ctrl-c":
        cancel();
        break;
      case "backspace":
        backspace();
        break;
      case "char":
        typeChar(action.ch);
        break;
      default:
        break;
    }
  };
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
      } catch {
      }
    };
    keyInput.prependListener("keypress", onKey);
    disposers.push(() => {
      try {
        keyInput.off("keypress", onKey);
      } catch {
      }
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
      } catch {
      }
    });
  }
  const stdin = renderer?.stdin ?? (typeof process !== "undefined" ? process.stdin : void 0);
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
      } catch {
      }
    });
  }
  const detach = () => {
    while (disposers.length) {
      try {
        disposers.pop()();
      } catch {
      }
    }
  };
  note(
    `ready kb=${keyInput && typeof keyInput.prependListener === "function" ? "y" : "n"} raw=${typeof renderer?.prependInputHandler === "function" ? "y" : "n"}`
  );
  return new Promise((resolve) => {
    try {
      context.ui.dialog.show(
        () => PickerView({
          context,
          title,
          entries,
          selected,
          query,
          cursor,
          diag,
          filtered,
          view,
          toggleAt
        }),
        () => {
          detach();
          resolve(store.result);
        }
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
  return /* @__PURE__ */ jsxs("box", { paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, gap: 1, flexDirection: "column", children: [
    /* @__PURE__ */ jsxs("box", { flexDirection: "row", justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx("text", { attributes: TextAttributes.BOLD, fg: theme().text.base, children: props.title }),
      /* @__PURE__ */ jsx("text", { fg: theme().text.muted, children: `${props.selected().size} selected` })
    ] }),
    /* @__PURE__ */ jsxs("box", { flexDirection: "row", paddingLeft: 1, children: [
      /* @__PURE__ */ jsx("text", { wrapMode: "none", fg: theme().text.action.primary.selected, attributes: TextAttributes.BOLD, children: `\u276F ${props.query()}` }),
      /* @__PURE__ */ jsx("text", { wrapMode: "none", fg: theme().text.action.primary.selected, children: "\u258C" })
    ] }),
    /* @__PURE__ */ jsx(
      "scrollbox",
      {
        ref: (element) => {
          props.view.scroll = element;
        },
        flexDirection: "column",
        maxHeight: Math.max(6, Math.floor(dimensions().height * 0.65)),
        children: /* @__PURE__ */ jsx(
          Show,
          {
            when: props.filtered().length > 0,
            fallback: /* @__PURE__ */ jsx("text", { fg: theme().text.muted, children: "No model matches the filter (esc to cancel)" }),
            children: /* @__PURE__ */ jsx(For, { each: props.filtered(), children: (entry, index) => {
              const active = () => index() === props.cursor();
              return /* @__PURE__ */ jsxs(
                "box",
                {
                  flexDirection: "row",
                  paddingLeft: 1,
                  paddingRight: 1,
                  backgroundColor: active() ? theme().background.action.primary.focused : void 0,
                  onMouseUp: () => {
                    props.toggleAt(index());
                  },
                  children: [
                    /* @__PURE__ */ jsx(
                      "text",
                      {
                        wrapMode: "none",
                        fg: active() ? theme().text.action.primary.focused : theme().text.base,
                        attributes: active() ? TextAttributes.BOLD : void 0,
                        children: `${active() ? "\u25B8" : " "}${props.selected().has(entry.id) ? "\u2611" : "\u2610"} ${entry.id}`
                      }
                    ),
                    /* @__PURE__ */ jsx("text", { wrapMode: "none", fg: active() ? theme().text.action.primary.focused : theme().text.muted, children: entry.label ? `  ${entry.label}` : "" })
                  ]
                }
              );
            } })
          }
        )
      }
    ),
    /* @__PURE__ */ jsxs("box", { flexDirection: "row", justifyContent: "space-between", children: [
      /* @__PURE__ */ jsx("text", { fg: theme().text.muted, children: `\u23CE save \xB7 \u2423 toggle \xB7 \u2191\u2193 move \xB7 esc cancel \xB7 key: ${props.diag()}` }),
      /* @__PURE__ */ jsx("text", { fg: theme().text.muted, children: `${props.filtered().length}/${props.entries.length} models \xB7 kb6` })
    ] })
  ] });
}
function printableChar(event) {
  const name = typeof event.name === "string" ? event.name : "";
  const sequence = typeof event.sequence === "string" ? event.sequence : "";
  const candidate = [...sequence].length === 1 ? sequence : [...name].length === 1 ? name : void 0;
  if (!candidate || candidate < " ") return void 0;
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
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
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
function parseRawSequence(sequence) {
  if (typeof sequence !== "string" || sequence.length === 0) return null;
  if (sequence === "\r" || sequence === "\n") return { type: "return" };
  if (sequence === "\x7F" || sequence === "\b") return { type: "backspace" };
  if (sequence === "") return { type: "ctrl-c" };
  if (sequence === "\x1B") return { type: "escape" };
  if (sequence === " ") return { type: "space" };
  if (sequence === "	") return { type: "ignore" };
  if (sequence.length > 1 && sequence.charCodeAt(0) === 27) {
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
    match = /^\x1b\[([0-9;]*)([A-Za-z~])$/.exec(sequence);
    if (match) return csiAction(match[2], match[1]);
    match = /^\x1bO([A-Za-z])$/.exec(sequence);
    if (match) return csiAction(match[1], "");
    return { type: "ignore" };
  }
  const chars = [...sequence];
  if (chars.length === 1 && chars[0] >= " ") return { type: "char", ch: chars[0] };
  return { type: "ignore" };
}
function parseChunk(text) {
  const actions = [];
  let rest = text;
  let guard = 0;
  while (rest.length > 0 && guard < 64) {
    guard += 1;
    if (rest.startsWith("\x1B]") || rest.startsWith("\x1BP") || rest.startsWith("\x1B_G")) {
      break;
    }
    if (rest.startsWith("\x1B")) {
      let match = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (!match) match = /^\x1bO[A-Za-z]/.exec(rest);
      if (match) {
        const action2 = parseRawSequence(match[0]);
        if (action2) actions.push(action2);
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
function shouldConsume(sequence) {
  if (typeof sequence !== "string" || sequence.length === 0) return false;
  if (sequence.startsWith("\x1B]")) return false;
  if (sequence.startsWith("\x1BP")) return false;
  if (sequence.startsWith("\x1B_G")) return false;
  if (sequence === "\x1B[I" || sequence === "\x1B[O") return false;
  if (/^\x1b\[[0-9;?]*[cR]$/.test(sequence)) return false;
  return true;
}
function describeSequence(sequence) {
  try {
    return JSON.stringify(sequence).slice(1, -1).slice(0, 24);
  } catch {
    return String(sequence);
  }
}
export {
  pickModels
};
