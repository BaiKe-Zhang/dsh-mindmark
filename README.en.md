# dsh-mindmark

**Show the model your mind: mark up its answer the way you would in Word.**

English | [中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. Select any passage of an answer and **highlight, underline, strike, comment on, rewrite, back with a source or move** it. On the next turn the model receives your markup as context: not just its own answer, but the answer as you want it understood. It confirms back when it has handled every mark. After a few annotations, one click asks the model to distill them into **long-term preferences** in your global `AGENTS.md`, which every new conversation then follows.

![Demo: all seven marks on one answer, the model revises and confirms each, then distills the marks into lasting preferences](docs/demo.gif)

In the demo the model drafts a short social-media post, then the answer gets, in order: a highlight on the analogy to keep, an underline on a mechanism that needs explaining, a strike on a filler clause, a comment asking for one more sentence, a rewrite turning a vague repo hint into the full address, the README attached as a source to list all seven marks, and a move that puts the new-features sentence first. The next turn applies every mark and confirms it; "Keep as habit" then distills seven lasting preferences.

## What it feels like

1. Select text in any answer. The Chat view's own selection bar appears in two rows:
   - one click and done: **Quote · Highlight · Underline · Strike · Remove marks**;
   - needs your input: **Comment · Rewrite · Source · Move**.
2. Comment and rewrite open a small input (confirm with the button or Ctrl+Enter).
3. **Source** attaches reference material to the passage so the model revises only that passage to match it: paste text, give a link, or pick a plain-text file (txt / md / csv / json / html…; for PDF or Word, copy the text). An optional instruction can go with it.
4. **Move** works like cut and paste: select a passage and press **Alt+C** (or click Move), then click in the same answer: a blinking orange caret appears and the passage goes right after it. Drag over some text instead and the passage replaces that text. Press **Alt+V** (or "Drop here" in the banner) to drop it; Esc cancels. The banner takes an optional reason. The source shows an orange dashed underline.
5. Send your next message. The model adjusts its answer to your marks, then calls the `annotations` tool to confirm they are handled.
6. The composer gains an **Annotation feed** switch with a pending-count badge:
   - **Brief**: the next turn sends only the annotated passages with a little context;
   - **Full**: the next turn sends the whole answer as a revision view with inline markers.
7. The marker icon in the session header opens the panel: every annotation with its state (pending / handled by the assistant / auto-settled), per-item delete, mark handled, send again, and **Keep as habit**, which asks the model to distill the marks into lasting preferences. Distilled preferences are listed there and can be removed.

## What each mark tells the model

| Mark | Meaning |
|---|---|
| Highlight | This is what I want: keep it and strengthen this direction |
| Underline | Not enough here: expand, clarify or justify |
| Strike | Drop this next time |
| Comment | Act on the note and respond to each one |
| Rewrite | Treat my wording as the correct version |
| Source | Revise only this passage, following the attached material; the material wins on conflict; cite the line used |
| Move | Move this passage right after the caret (or onto the selected text, replacing it), remove it from where it was, leave the rest alone |

## How the model sees and answers your marks

- **Pre-step injection.** At the start of every turn the Host renders the conversation's pending annotations into one user-role context message entered right after your prompt, through the official `agent/pre-step` hook. Like every other context plugin it lands in the session log, so you can inspect it in the Trajectory view.
- **Protocol section.** While annotations are pending, a short system-prompt section explains the marks and the confirmation rule.
- **Reference material.** Materials are stored separately under `$DSH_HOME/annotations/materials/`, never inside `state.json`, and are deleted with their mark. Up to 2,000 characters travel whole with the mark; longer ones send an excerpt and the length, and the model reads the rest with the `annotations` tool's `material` action (8,000 characters per call, continue with `offset`). Links are opened by the model's own web tools; if it cannot, it asks you to paste the text. One material holds up to 200,000 characters.
- **Confirmation signal.** The model calls the `annotations` tool (`action: resolve`, optional `ids`) when done. Confirmed marks stop being injected and show as "handled by the assistant"; unconfirmed ones come back next turn, up to `maxInjections` (default 3) before they settle automatically.
- **Long-term preferences.** "Keep as habit" prefills a distillation request. The model reviews the marks and calls `annotations` with `action: distill`, which writes one-sentence preferences into a managed block of `$DSH_HOME/AGENTS.md` (`<!-- dsh-mindmark:start -->` … `<!-- dsh-mindmark:end -->`; everything outside the block is preserved). The official workspace-instructions plugin feeds that file to every new session. `lessons` lists, `forget` removes; the panel can remove too.

## Install

```sh
dsh plugin --profile web add dsh-mindmark
```

Or in the Harness plugin page → **Add plugin** → `dsh-mindmark`; for local development use `link:<absolute path>`. A Client-side change needs a Harness restart.

Options in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `defaultMode` | `brief` | Injection view for new sessions (`brief` / `full`); the composer switch overrides it per session |
| `maxInjections` | `3` | How many turns an unconfirmed mark is re-sent before it settles |

## Layout

```
dsh-mindmark/
├── package.json        # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml    # one profile row (defaultMode / maxInjections)
├── index.js            # Host: HTTP route, annotations tool, pre-step injection, protocol section
├── src/store.js        # annotation persistence (state, injection counters, per-session mode, message capture, material files)
├── src/inject.js       # injection text: brief view / full revision view
├── src/lessons.js      # long-term preferences: the managed AGENTS.md block
├── client.js           # Client: selection bar, mode switch, panel, CSS highlight painting
├── locale/{en,zh}.json # plugin-page name and description
└── test/               # node:test suites (store, HTTP, injection, listener, lessons)
```

## Design notes

- **Selection UX reuses the official seam.** The plugin registers into `conversation.chat.text-interaction` (taking over the built-in Quote surface while keeping the Quote action), so the Chat view positions the bar and keeps it attached while scrolling. The Source form lives in the plugin's own overlay, because the bar closes whenever the window loses focus and a native file dialog takes it.
- **No dependency on host DOM structure.** Each mark stores the selected text, surrounding context and the scroll container's CSS path, and is re-anchored by scoring every occurrence of the quote; message-level offsets and the full message text are captured from the official `data-text-interaction-source` element for the full revision view.
- **Painting uses the CSS Custom Highlight API** with pending/handled colours per mark; no nodes are inserted into message DOM.
- **Move uses Alt.** Shift would clash with typing, Fn is invisible to web pages, and Harness binds no Alt+C / Alt+V. The shortcuts are ignored while focus is in a text field.
- **HTTP channel:** `/plugins/dsh-mindmark/annotations` (GET and POST: list / add / remove / clear / resolve / reopen / set-mode / forget-lesson).
- Annotations live in `$DSH_HOME/annotations/state.json`, grouped by session, independent of the session log.
- No `@deepseek-ai/*` imports, Node built-ins only, so the bundle loads straight from a linked directory.

## Limits

- Rewrite tells the model what you changed; the model's own history is left untouched by design.
- Source asks for a one-passage edit, but the model rewrites the whole answer each time; keeping the other passages word-for-word is up to the instruction and cannot be enforced.
- Move works within one answer only; moving across messages is not supported yet.
- In full mode overlapping marks fall back to the brief list.
- Marks are painted only for messages currently rendered; virtualised messages re-anchor when scrolled back.
- Multi-agent sessions get no special handling: marks are stored per session.
- Message anchoring relies on the Chat view's `data-chat-node-key` attribute; if upstream renames it, the plugin degrades to text anchoring (affects full mode only).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) (Chinese).

## License

MIT
