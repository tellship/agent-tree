# Agent-tree pane: mockups of the final result

Everything below is drawn in monospace at exact widths. Pane body is 40 columns; the border adds 2, so the pane is 42 columns wide in the terminal. Glyphs used (● ✓ ✗ ⊘ ▸ ▾ ↳ ↑ ↓ … ├ └ │ ─ ›) are all single-width.

Slice key: 1 = static tree from spawn events, 2 = status / elapsed / current step, 3 = collapse / overflow / narrow, 4 = secrets masking, 5 = accessibility and themes.

## Honest limits of the engine (apply to every screen)

- The pane title "Agents" is NOT drawn while this is the only pane. Every frame below therefore has a plain top border with no title. Do not expect a heading.
- The one-third width cap cannot be enforced. At 120 columns a 42-column pane is 35 percent of the screen, which is already over one third (40). The width is fixed by the engine, not by us.
- The pane docks to the right only from 110 columns. Below 110 it renders inline above the prompt, not as a side pane.
- The pane auto-opens only from 144 columns. Below that the user must run `/agent-tree`. Screen 1 is 120 columns, so on a real terminal this size the pane is closed until `/agent-tree` is run.
- Click handling and a second per-agent pane are UNVERIFIED in this engine. Screen 6 depends on both.
- Anything marked "proposal, needs approval" is not covered by the acceptance criteria.

---

## Commands

- `/agent-tree`: opens the pane, at any width, also when below 144 columns.
- `/agent-tree clear`: removes finished nodes (done, failed, aborted); keeps running nodes and their ancestors. Prints 'Cleared N finished agent(s).' or 'No finished agents to clear.'
- `/agent-tree close`: closes the pane and keeps the tree. Prints 'Closed the agents pane.' or 'The agents pane is not open.' `/agent-tree` reopens it.

---

## Screen 1: whole terminal, 120 columns, empty state (slice 1)

Transcript on the left (78 columns), pane docked on the right (42 columns). Shows: docked-right position, Main row, empty-state copy, no title on the border. Requires `/agent-tree` at this width (see limits).

```
 Claude Code · ~/projects/web-app                                             ┌────────────────────────────────────────┐
                                                                              │● Main                           running│
> Fix the login redirect bug                                                  │                                        │
                                                                              │   No subagents yet. Delegated work     │
● I'll start by reading the auth code.                                        │   appears here.                        │
                                                                              │                                        │
  Read(src/auth/login.ts)                                                     │                                        │
  ⎿  Read 84 lines                                                            │                                        │
                                                                              │                                        │
● The redirect uses a stale next param. I'll patch it and                     │                                        │
  add a regression test.                                                      │                                        │
                                                                              │                                        │
                                                                              │                                        │
                                                                              │                                        │
                                                                              │                                        │
> ▌                                                                           │                                        │
  ? for shortcuts                                                             │                                        │
                                                                              └────────────────────────────────────────┘
```

---

## Screen 2: running session, depth 2, mixed states (slice 2 for A; final look for B)

Shows: tree connectors ├─ └─ │, status glyph plus word, label = name then description cut with …, failed with reason, depth 2 (planner has two children). Pane only, height trimmed. Main running, planner running (children: explorer done, reviewer running), tester failed, docs aborted.

### 2A: what the build draws now (hooks/tree.ts:194-245)

Main is `Main` plus elapsed time only once started, with no glyph and no status word. Each node row is `<indent><connector> <glyph> <status word>[ (reason)] [elapsed] <name>: <description>`, all left-aligned and cut with … at the pane width. A failed node's reason sits inside its status, not on its own row. The current-step row `↳ <tool or thinking>` is drawn directly under its own node, before that node's children, at the child indent.

```
┌────────────────────────────────────────┐
│Main 4m02s                              │
│├─ ● running 3m51s planner: Draft migra…│
││  ↳ thinking                           │
││  ├─ ✓ done 1m12s explorer: Find login…│
││  └─ ● running 2m10s reviewer: Check t…│
││     ↳ Read src/app.ts                 │
│├─ ✗ failed (3 tests failed) 48s tester…│
│├─ ⊘ aborted 12s docs: Update README an…│
│└─ ✓ done 12s ♛ advisor                 │
└────────────────────────────────────────┘
```

Advisor row: the consult made by the main loop, drawn as the last child of Main. The label is `♛ advisor` with no description. The crown is plain colour; the glyph and word keep their status colour. Notes:

- Advisor consults appear after the step ends, never as running (engine limit), so the row is always drawn already done.
- ASCII mode shows `^` instead of `♛`.
- `/agent-tree clear` removes finished advisor nodes.

Proposal, needs approval: 2B (lean rows) still draws Main with a status word and differs from the build (owner default is Main with no status).

### 2B: lean rows only (owner's final look)

Status and label only. Current tool and elapsed time move to the click-to-open detail pane (screen 6), which is DEFERRED to a later slice. The failure reason stays on the tree because it explains a state; moving it to the detail pane is the owner's call.

```
┌────────────────────────────────────────┐
│● Main                           running│
│├─ ● planner Draft migration pl… running│
││  ├─ ✓ explorer Find login han…    done│
││  └─ ● reviewer Check the plan… running│
│├─ ✗ tester Run unit tests in a…  failed│
││    reason: 3 tests failed (exit 1)    │
│└─ ⊘ docs Update README and cha… aborted│
└────────────────────────────────────────┘
```

---

## Screen 3: masking (slice 4)

Shows: a running node whose tool input held a secret, rendered `[redacted]`; a secret file shown by file name only (never its path or contents). Drawn on slice-2 style rows because the step row is where tool input appears.

```
┌────────────────────────────────────────┐
│● Main                     6m10s running│
│├─ ● deployer Ship to sta… 1m05s running│
││  ↳ Bash deploy --token [redacted]     │
│└─ ● config Fix env loader   31s running│
│   ↳ Read .env                          │
└────────────────────────────────────────┘
```

What the tool actually received versus what the pane shows:

| Raw tool input | Pane shows |
|---|---|
| `Bash deploy --token sk-live-9f2a...` | `Bash deploy --token [redacted]` |
| `Read /Users/me/web-app/.env` | `Read .env` (file name only) |

The same masking applies in the deferred detail pane (screen 6), including the answer summary.

---

## Screen 4: collapse, selection and overflow (slice 3)

Rows in slice 3 gain a 2-column selection gutter and a 2-column fold slot: `[gutter][connector][fold][glyph] label … word`. The label budget shrinks by 4 columns to make room.

### 4a: selection, collapsed parent, expanded parent, key hint

NOT BUILT — no key input (owner choice; the engine gives a pane no key handler). Kept as a design for a later slice.

Shows: `›` selection marker plus reverse video (so selection is not colour-only), ▸ collapsed with (+4) hidden descendants, ▾ expanded, key hint line. Planner is collapsed and selected. Its roll-up glyph is ✗ failed because one of its four hidden descendants failed.

```
┌────────────────────────────────────────┐
│  ▾ ● Main                      running │
│› ├─ ▸ ✗ planner Draft migr… (+4) failed│
│  ├─ ▾ ● tester Run the test su… running│
│  │  ├─   ✓ lint-fix Fix lint e…    done│
│  │  └─   ✗ snapshot Update sna…  failed│
│  └─   ⊘ docs Update README and… aborted│
│                                        │
│  ↑↓ move  ←→ fold  esc back            │
└────────────────────────────────────────┘
```

Caption: planner shows ✗ failed because one hidden descendant failed, even though others below it are still running.

Roll-up rule (AC2.7): a collapsed parent shows the most urgent status found below it, in the order failed, then aborted, then running, then done, so a failure is never hidden by a running sibling.

### 4b: overflow, done summary, depth cap (BUILT, hooks/tree.ts:215-327)

Overflow applies only when the tree has MORE THAN 24 agents. This is a 26-agent tree: 12 agents sit in done subtrees (8 at the top level, 4 inside planner) and fold into two `✓ N done` rows; the other 14 are drawn. Elapsed times use the build's format (`3m 20s`, with a space).

```
┌────────────────────────────────────────┐
│Main 9m 41s                             │
│├─ ✓ 8 done                             │
│├─ ● running 8m 12s planner: Draft migr…│
││ ├─ ✓ 4 done                           │
││ ├─ ● running 6m 30s reader: Scan src/…│
││ │ └─ ● running 5m 02s scanner: Walk t…│
││ │   └─ ● running 4m 11s parse: Tokeni…│
││ │ …1└─ ● running 3m 20s grep: Find us…│
││ │ …1   ↳ Read src/lib/a.ts            │
││ └─ ● running 1m 05s writer: Summarise │
│├─ ✓ done 7m 40s build: Compile pkgs    │
││ └─ ✗ failed (exit 1) 12s pack: Bundle…│
│├─ ● running 3m 02s tester: Run tests   │
││ └─ ● running 1m 44s e2e: Browser run  │
│├─ ✗ failed (no tag) 12s release: Cut v…│
│├─ ⊘ aborted 9s docs: Update README     │
│├─ ● running 41s deploy: Ship to prod   │
│└─ ● running 8s lint: Fix lint errors   │
│                                        │
│showing 14 of 26                        │
└────────────────────────────────────────┘
```

Rules as built:

- Stems are 2 columns per level: `├─` or `└─` for the row, `│ ` as the continuation under a row that has later siblings, two spaces under the last sibling. There is no selection gutter, no fold slot, no ▸/▾ and no key hints.
- Rows are `<stems><connector> <glyph> <status word>[ (reason)] [elapsed] <name>: <description>`, left-aligned and cut with … at the 40-column width. Main is `Main <elapsed>` with no glyph.
- An entirely-done subtree folds into one summary row `✓ N done`, placed FIRST among its siblings (connector `├─`, or `└─` if no other siblings are shown). Here the top level has `✓ 8 done` and planner has `✓ 4 done`.
- A failed or aborted node stays visible together with its done ancestors: build is done but stays drawn because bundle failed below it.
- Footer is a blank row, then `showing N of M`: M is the total agents (26) and N is M minus the agents inside folded subtrees (26 − 12 = 14).
- Depth cap is 4. Indentation stops growing at depth 4; a deeper row shows `…N` (N = levels past 4) in place of its last stems, with no space after the marker (`…1└─`). The grep row is depth 5, so it shows `…1`. Its `↳` step row carries the same marker.
- There are no `↑ n more` / `↓ n more` indicators: the engine owns scrolling.
- A summarised `✓ N done` subtree cannot be expanded (no keys). `/agent-tree clear` removes finished nodes.

---

## Screen 5: narrow and glyph-only (slice 3)

Shows what is built (hooks/tree.ts:243-256): a narrow pane (under 30 columns) and a glyph-only pane (under 16 columns). Status is still readable without colour because the glyph shape differs. These are drawn at 26 and 14 columns of body; remember the engine decides the pane width (the cap cannot be enforced).

Narrow, 26-column body. Each node row keeps its glyph and elapsed time. The head (`<stems><connector> <glyph> <status word>[ (reason)] [elapsed]`) drops the failure `(reason)` first, then the status word, ONLY when the head alone does not fit. The label (`name: description`) is cut from the right first, so the description goes before the name, with …. There is no right-aligned status word. Main is `Main <elapsed>` with no glyph and no status. The reason lives inside the status (`✗ failed (3 tests failed) 48s` in a wider pane) and never on its own row. The `↳` step row is cut on its own with …. Here the tester's reason is dropped because the full head (32 columns) does not fit.

```
┌──────────────────────────┐
│Main 4m 02s               │
│├─ ● running 51s planner:…│
││  ↳ thinking             │
││ ├─ ✓ done 1m 12s explor…│
││ └─ ● running 2m 10s rev…│
││    ↳ Read src/db/schema…│
│├─ ✗ failed 48s tester: R…│
│└─ ⊘ aborted 12s docs: Up…│
└──────────────────────────┘
```

Glyph-only, 14-column body. Rows are the stems and connector plus the glyph only; the leftmost stems give way first if a row does not fit. No elapsed time and no `↳` step rows. Main and the empty-state hint are NOT truncated (Main is 11 columns here, so it happens to fit). A blank row and `widen terminal` follow, cut with … if the pane is narrower than the hint.

```
┌──────────────┐
│Main 4m 02s   │
│├─ ●          │
││ ├─ ✓        │
││ └─ ●        │
│├─ ✗          │
│└─ ⊘          │
│              │
│widen terminal│
└──────────────┘
```

---

## Screen 6: detail pane (LATER, not built)

LATER, not built. Click-to-open detail pane, deferred past slice 5. Both click handling and a second per-agent pane are UNVERIFIED in this engine, so this may need a keyboard-only route (select a row, press Enter) or may not be possible at all. Shows: full description, status, model, current tool, elapsed, answer summary with masking. The reviewer row is selected; the detail pane sits to the right of the tree. The "Agents" title is not drawn on the tree (engine limit); the detail pane title is the agent name, proposal needing approval. Model value and the `esc close` hint are proposals, needs approval.

```
┌────────────────────────────────────────┐ ┌────────────────────────────────────────┐
│  ▾ ● Main                      running │ │ reviewer                               │
│  ├─ ▾ ● planner Draft migratio… running│ │                                        │
│  │  ├─   ✓ explorer Find login…    done│ │ Status     running                     │
│› │  └─   ● reviewer Check plan… running│ │ Model      sonnet                      │
│  ├─   ✗ tester Run full unit s…  failed│ │ Tool       Read src/db/schema.sql      │
│  └─   ⊘ docs Update README and… aborted│ │ Elapsed    2m10s                       │
│                                        │ │                                        │
│                                        │ │ Description                            │
│                                        │ │ Check the migration plan against the   │
│                                        │ │ current schema and list breaking       │
│                                        │ │ changes.                               │
│                                        │ │                                        │
│                                        │ │ Answer summary                         │
│                                        │ │ 2 breaking changes found. Test DB      │
│                                        │ │ uses DATABASE_URL=[redacted]           │
│                                        │ │                                        │
│                                        │ │ esc close                              │
└────────────────────────────────────────┘ └────────────────────────────────────────┘
```

---

## Screen 7: accessibility variants (slice 5)

### 7a: NO_COLOR=1

NOT BUILT — no key input (owner choice; the engine gives a pane no key handler). Kept as a design for a later slice.

Colour, bold, dim and reverse video are all off. Everything is still carried by glyph and word; selection is carried by the `›` marker and the fold glyphs. This is the same frame as the unbuilt 4a design, which is the point: nothing in that design relies on colour. Shows: glyph plus word, `›` selection.

```
┌────────────────────────────────────────┐
│  ▾ ● Main                      running │
│› ├─ ▸ ● planner Draft mig… (+4) running│
│  ├─ ▾ ● tester Run the test su… running│
│  │  ├─   ✓ lint-fix Fix lint e…    done│
│  │  └─   ✗ snapshot Update sna…  failed│
│  └─   ⊘ docs Update README and… aborted│
│                                        │
│  ↑↓ move  ←→ fold  esc back            │
└────────────────────────────────────────┘
```

Dim rows (reason, hint, `↳` step) lose their dimming under NO_COLOR, so they are told apart by position and the glyph only.

### 7b: ASCII fallback

For a terminal whose locale is set and is not UTF-8 (for example `LANG=C`). Only the plugin's own text is mapped; the pane border is drawn by the engine, not by the plugin, so it stays exactly as in the other screens and the plugin cannot change it.

| Plugin text | ASCII |
|---|---|
| ● | `*` |
| ✓ (row glyph and the `N done` summary) | `v` |
| ✗ | `x` |
| ⊘ | `-` |
| ├─ | `\|--` |
| └─ | `` `-- `` (backtick and two hyphens) |
| │ | `\|` |
| ↳ | `->` (proposal, needs approval) |
| … | `...` (three characters; proposal, needs approval) |

Stems are 3 columns per level instead of 2, because `|--` is 3 characters. The label budget is therefore one column smaller per level, and the depth cap marker `…N` becomes `...N` (4 characters or more, in place of the last stems). Rows keep the same shape: `<stems><connector> <glyph> <status word>[ (reason)] [elapsed] <name>: <description>`, cut with `...` at the width. The failure reason stays inside the status.

Locale rule: ASCII mode turns on only when the first of `LC_ALL`, `LC_CTYPE`, `LANG` that is set (non-empty) does not contain `utf-8` or `utf8` (case-insensitive). If all three are unset, the plugin draws Unicode.

Frame note: on a truly non-Unicode terminal the engine's own border may not render. The plugin cannot change that.

Shows a 25-agent overflow tree (4 drawn, 21 folded: 20 into one top-level `v 20 done` row and 1 into `v 1 done` under planner, hence the footer). Widths were counted by hand: every line below is exactly 42 columns (40 body plus 2 border).

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│|-- v 20 done                           │
│|-- * running 3m 51s planner: Draft m...│
│|   -> thinking                         │
│|  |-- v 1 done                         │
│|  `-- * running 2m 10s reviewer: Che...│
│|      -> Read src/app.ts               │
│|-- x failed (exit 1) 48s tester: Run...│
│`-- - aborted 12s docs: Update README...│
│                                        │
│showing 4 of 25                         │
└────────────────────────────────────────┘
```

---

## Colour legend (slice 5)

Colours are theme keys, so they follow the host's theme.

| Element | Theme key |
|---|---|
| running (glyph, status word) | `suggestion` |
| done | `success` |
| failed (glyph, status word, and its (reason)) | `error` |
| aborted | `inactive` (grey, so it is never mistaken for failed) |
| secondary text: tree connectors/stems, `↳`/`->` step rows, footer `showing N of M`, `widen terminal` hint, empty-state copy, the `N done` summary row | `dimColor` (no colour) |
| advisor crown `♛` (ASCII `^`) | plain colour, marks an advisor consult; the status glyph keeps its colour |
| plain (default colour): Main row, elapsed time, label `name: description` | none |

Notes:

- The glyph and the word stay on every row, so colour never carries status alone.
- The host theme (light, dark, or a colour-blind/daltonized host theme) applies on its own because theme keys follow it. The plugin has NO colour-blind detection (the host exposes no such setting).
- NO_COLOR handling is not claimed (unverified).
- The exact colours each key draws are unverified until the owner sees them live, and the owner may adjust the keys.
- Selection colouring is not built (no key input).

---

## Screen 8: row selection and detail (option A)

NOT BUILT. Owner-approved option A: a row is selected by mouse click (S1) or by Tab and Enter on the focused pane (S2); the details of the selected agent are drawn in the SAME pane, in an area BELOW the tree. Widths were counted by hand (40-column body, 26-column body in 8e), not checked by a script; the right border should line up in every block.

Row shape (everything not listed here is unchanged from screen 4b): each node row, and its `↳` step row, gains a 2-column selection gutter on the left. The gutter is `› ` on the selected node row and two spaces on every other row. The label budget shrinks by 2 columns. Main keeps its current text and is not selectable. Gutter and Main-not-selectable: proposal, needs approval.

Selected look is not colour-only: `›` marker in the gutter plus reverse video and bold on the node row (reverse video cannot be drawn in text; the first three blocks mark the selected row with the `›` only). ASCII mode uses `>`.

Detail area, top to bottom: a blank row, a dim rule, the agent name (bold; `♛ advisor` for an advisor), then `Kind`, `Status`, `Elapsed`, `Step` (omitted when none), `Parent`, `Id`, a blank row, `Description` (omitted when none) wrapped to 40 columns and never cut with …, a blank row, the key hint. Secrets are already masked at entry. The advisor's input and an agent's answer text are never stored and never shown. The blank/rule separator, the field names, the order, the `Kind` value `subagent`, the `Parent` shown as the name only, and the omit-when-empty rule: proposal, needs approval. The `Id` values drawn are made-up examples.

Engine facts and unverified items for this screen:

- Verified in index.d.ts: Button `plain` draws the label alone (:1112); children may be strings and coloured Text (:1077-1079); no `selected` prop, so the look is ours; a focused pane lets Tab walk its Buttons and Enter press (:10330, :1064); the person gives a pane the keyboard with `ctrl+x` then `tab`, or by a click, and Escape hands it back (:10258, :10315, :1419, :7424).
- UNVERIFIED: whether arrow keys scroll the pane or move the focus ring (:10331, :13908), so arrow selection is not promised and the hint does not mention arrows; whether a click on a Button in an unfocused pane raises a press; whether a fixed area under the tree stays visible when the tree is taller than the pane's rows (the pane body is one tree with an engine-owned scroll window).
- Fallback if the detail area scrolls out of view with a tall tree: the detail stays last in the same body and the person scrolls the pane to it (the selected row already shows marker, status word and time, so nothing is lost); if live checks show it is unreachable, print the detail as a transcript line block from the selection instead (proposal, needs approval).

### 8a: no selection, hint area below the tree

Folded rows: a `✓ N done` row is NOT selectable (it stands for many agents and has no single detail); it keeps its two blank gutter columns. Proposal, needs approval. The hint line is dim. Hint text and the second hint line: proposal, needs approval.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│  │ ├─ ✓ done 1m 12s explorer: Find log…│
│  │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│  ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│  └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│Click an agent to see its details.      │
│Keys: ctrl+x tab, then Tab, Enter.      │
└────────────────────────────────────────┘
```

### 8b: a running subagent selected (reviewer), full detail block

The elapsed time in the detail ticks while the agent runs and freezes when it ends, like the row. The row keeps its time and step.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│  │ ├─ ✓ done 1m 12s explorer: Find log…│
│› │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│  ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│  └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│reviewer                                │
│Kind     subagent                       │
│Status   ● running                      │
│Elapsed  2m 10s                         │
│Step     Read src/app.ts                │
│Parent   planner                        │
│Id       agent_7f3a9c21                 │
│                                        │
│Description                             │
│Check the migration plan against the    │
│current schema and list breaking        │
│changes.                                │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 8c: a failed agent selected (reason shown)

The reason stays in the status line and wraps onto the next line if it does not fit; it is never cut with …. The time is frozen. No `Step` line because the agent has none.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│  │ ├─ ✓ done 1m 12s explorer: Find log…│
│  │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│› ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│  └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│lint                                    │
│Kind     subagent                       │
│Status   ✗ failed (exit 1)              │
│Elapsed  48s                            │
│Parent   Main                           │
│Id       agent_b410e5d2                 │
│                                        │
│Description                             │
│Fix style errors across the project and │
│report what changed.                    │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 8d: an advisor row selected (crown, no description)

The advisor row is selectable. It has no description and no step, so those lines are omitted. The note about input and answer is a proposal, needs approval; the Id is the server tool use id.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│  │ ├─ ✓ done 1m 12s explorer: Find log…│
│  │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│  ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│› └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│♛ advisor                               │
│Kind     ♛ advisor                      │
│Status   ✓ done                         │
│Elapsed  12s                            │
│Parent   Main                           │
│Id       srvtoolu_01Ab9xKq              │
│                                        │
│Advisor input and answer are not shown. │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 8e: narrow, 26-column body, with a selection

Under 30 columns the detail drops `Kind`, `Parent` and `Id`, and writes each remaining field as `Field value` with one space (no label column). It keeps name, status with reason, elapsed, step (when any) and description, wrapped to 26 columns. Under 16 columns (glyph-only rows) the detail area and the hint are hidden, and the `widen terminal` hint stays as today; the selection is remembered and returns when the pane is wide enough. All of this: proposal, needs approval. The label is cut hard at this width (`api: D…`); that is why the detail area exists.

```
┌──────────────────────────┐
│Main 4m 02s               │
│  ├─ ● running 51s api: D…│
│  │  ↳ thinking           │
│› ├─ ✗ failed 48s lint: F…│
│  └─ ✓ done 12s ♛ advisor │
│                          │
│──────────────────────────│
│lint                      │
│Status ✗ failed (exit 1)  │
│Elapsed 48s               │
│                          │
│Fix style errors across   │
│the project and report    │
│what changed.             │
│                          │
│Tab next  Enter  esc back │
└──────────────────────────┘
```

### 8f: ASCII version of 8b

Same content as 8b with the ASCII alphabet: `>` for `›`, `*` `v` `x` for glyphs, `|--` and a backtick with two hyphens for connectors, `->` for `↳`, `...` for `…`, `^` for the crown, and a row of hyphens for the rule. Stems are 3 columns per level. The border is the engine's and stays as it is.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  |-- * running 3m 51s planner: Draft...│
│  |   -> thinking                       │
│  |  |-- v done 1m 12s explorer: Find...│
│> |  `-- * running 2m 10s reviewer: C...│
│  |      -> Read src/app.ts             │
│  |-- x failed (exit 1) 48s lint: Fix...│
│  `-- v done 12s ^ advisor              │
│                                        │
│----------------------------------------│
│reviewer                                │
│Kind     subagent                       │
│Status   * running                      │
│Elapsed  2m 10s                         │
│Step     Read src/app.ts                │
│Parent   planner                        │
│Id       agent_7f3a9c21                 │
│                                        │
│Description                             │
│Check the migration plan against the    │
│current schema and list breaking        │
│changes.                                │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

---

## Screen 9: Summary button (task prompt as short lines)

NOT BUILT. Owner-approved: option B (a button in the detail area) and the storage of the task text. Everything below not stated in the owner's brief is a proposal, needs approval. Widths were counted by hand (40-column body, 26-column body in 9d), not checked by a script; the right border should line up in every block.

What the feature is: a plain Button `[ Summary ]` in the detail block of the selected agent, below the Description and above the key hint. Pressing it opens a line-by-line reflow of the task text the model gave the subagent (`agent.spawn` input `prompt`). It is a REFLOW, not a model-written summary: each sentence, bullet or numbered item becomes its own short line, long lines are wrapped to the detail width and never cut with …, a blank-line paragraph break stays as one blank row. No model call.

Stored per node at spawn: the prompt, masked with the same secret patterns as descriptions, capped at 2,000 characters. Absent for forked skills, remote agents and some workflow agents (placeholder prompt): those show `No task text.` and no button. The advisor has no prompt: no button. Rows are unchanged.

Open state (all proposal, needs approval): closed by default; the label reads `[ Hide summary ]` while open; a different selection closes it; `/clear` and `/agent-tree clear` close it (when the selected node is removed); `/agent-tree close` + reopen keeps it. The summary block opens directly under the button, with a `Task` heading in the style of `Description`, a blank row, then the hint stays last. The `Task` heading and the position: proposal, needs approval.

Engine facts and unverified items:

- Verified live (brief): a click on a Button selects rows.
- UNVERIFIED: Tab then Enter on the focused Button as the keyboard path; whether the pane stays tall enough to show the opened summary (the pane body is one tree with an engine-owned scroll window, the fixed-area question of Screen 8 applies and is worse here, since the open block adds up to about 20 rows); fallback as in Screen 8: the detail stays last in the same body and the person scrolls the pane to it.
- Hint line: the existing hint is unchanged (`Tab next row  Enter show  esc back`); it says nothing about the Summary button. Whether Enter on the button should be named in the hint: proposal, needs approval.

### 9a: reviewer selected, summary closed

The only change from 8b is the button row and one blank row before the hint. The label `[ Summary ]` is plain text; the brackets are ASCII in every alphabet.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│  │ ├─ ✓ done 1m 12s explorer: Find log…│
│› │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│  ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│  └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│reviewer                                │
│Kind     subagent                       │
│Status   ● running                      │
│Elapsed  2m 10s                         │
│Step     Read src/app.ts                │
│Parent   planner                        │
│Id       agent_7f3a9c21                 │
│                                        │
│Description                             │
│Check the migration plan against the    │
│current schema and list breaking        │
│changes.                                │
│                                        │
│[ Summary ]                             │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 9b: the same, summary open

Made-up prompt this was reflowed from (the text the model gave the agent):

```
Review docs/migrate.md and list every risk before we ship.
- Each column rename needs a backfill.
- Each step needs a rollback.
- Table locks must stay under 5 s.

Report breaking changes first. Do not edit any files.
```

Result: the first sentence wraps (37 + 20 columns), each bullet is one line, the blank line stays as one blank row, and the two sentences of the last paragraph become two lines. The label now reads `[ Hide summary ]`.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│  │ ├─ ✓ done 1m 12s explorer: Find log…│
│› │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│  ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│  └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│reviewer                                │
│Kind     subagent                       │
│Status   ● running                      │
│Elapsed  2m 10s                         │
│Step     Read src/app.ts                │
│Parent   planner                        │
│Id       agent_7f3a9c21                 │
│                                        │
│Description                             │
│Check the migration plan against the    │
│current schema and list breaking        │
│changes.                                │
│                                        │
│[ Hide summary ]                        │
│                                        │
│Task                                    │
│Review docs/migrate.md and list every   │
│risk before we ship.                    │
│- Each column rename needs a backfill.  │
│- Each step needs a rollback.           │
│- Table locks must stay under 5 s.      │
│                                        │
│Report breaking changes first.          │
│Do not edit any files.                  │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 9c: an agent with no task text

Explorer selected; its task text is absent (for example a forked skill). No button is drawn; the one line `No task text.` takes its place. The wording `No task text.` is the owner's; the position is a proposal, needs approval.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  ├─ ● running 3m 51s planner: Draft mi…│
│  │  ↳ thinking                         │
│› │ ├─ ✓ done 1m 12s explorer: Find log…│
│  │ └─ ● running 2m 10s reviewer: Check…│
│  │    ↳ Read src/app.ts                │
│  ├─ ✗ failed (exit 1) 48s lint: Fix st…│
│  └─ ✓ done 12s ♛ advisor               │
│                                        │
│────────────────────────────────────────│
│explorer                                │
│Kind     subagent                       │
│Status   ✓ done                         │
│Elapsed  1m 12s                         │
│Parent   planner                        │
│Id       agent_2c8d41e0                 │
│                                        │
│Description                             │
│Find log files that mention the         │
│timeout error.                          │
│                                        │
│No task text.                           │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 9d: narrow, 26-column body, summary open

Same agent and prompt as 9b. Under 30 columns the detail drops `Kind`, `Parent` and `Id` as in 8e; the button, the `Task` heading and the summary stay, wrapped to 26 columns. A wrapped bullet continues under the text, indented by the marker width (2 spaces). The row cut `rev…` is the existing label rule. Under 16 columns the whole detail, the button and the summary are hidden, and the open state is kept.

```
┌──────────────────────────┐
│Main 4m 02s               │
│› └─ ● running 2m 10s rev…│
│     ↳ Read src/app.ts    │
│                          │
│──────────────────────────│
│reviewer                  │
│Status ● running          │
│Elapsed 2m 10s            │
│Step Read src/app.ts      │
│                          │
│Check the migration plan  │
│against the current schema│
│and list breaking changes.│
│                          │
│[ Hide summary ]          │
│                          │
│Task                      │
│Review docs/migrate.md and│
│list every risk before we │
│ship.                     │
│- Each column rename needs│
│  a backfill.             │
│- Each step needs a       │
│  rollback.               │
│- Table locks must stay   │
│  under 5 s.              │
│                          │
│Report breaking changes   │
│first.                    │
│Do not edit any files.    │
│                          │
│Tab next  Enter  esc back │
└──────────────────────────┘
```

### 9e: ASCII version of 9b

The alphabet changes only the tree, the gutter and the rule, as in 8f. The button label and the summary text are already ASCII. Bullets that arrive as `•`, `*` or `–` are drawn as `- ` in every alphabet (proposal, needs approval), so the summary never adds a non-ASCII character of its own. A cut summary ends with `...` instead of `…`.

```
┌────────────────────────────────────────┐
│Main 4m 02s                             │
│  |-- * running 3m 51s planner: Draft...│
│  |   -> thinking                       │
│  |  |-- v done 1m 12s explorer: Find...│
│> |  `-- * running 2m 10s reviewer: C...│
│  |      -> Read src/app.ts             │
│  |-- x failed (exit 1) 48s lint: Fix...│
│  `-- v done 12s ^ advisor              │
│                                        │
│----------------------------------------│
│reviewer                                │
│Kind     subagent                       │
│Status   * running                      │
│Elapsed  2m 10s                         │
│Step     Read src/app.ts                │
│Parent   planner                        │
│Id       agent_7f3a9c21                 │
│                                        │
│Description                             │
│Check the migration plan against the    │
│current schema and list breaking        │
│changes.                                │
│                                        │
│[ Hide summary ]                        │
│                                        │
│Task                                    │
│Review docs/migrate.md and list every   │
│risk before we ship.                    │
│- Each column rename needs a backfill.  │
│- Each step needs a rollback.           │
│- Table locks must stay under 5 s.      │
│                                        │
│Report breaking changes first.          │
│Do not edit any files.                  │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

### 9f: a cut prompt (text over 2,000 characters), end of the summary only

After masking, the stored text is cut at 2,000 characters; the last summary line ends with `…` (ASCII `...`) and one dim line says so. Only the tail of the detail block is drawn. The note wording `Cut at 2,000 characters.` and its position: proposal, needs approval.

```
┌────────────────────────────────────────┐
│- Compare every route in src/api with…  │
│                                        │
│Cut at 2,000 characters.                │
│                                        │
│Tab next row  Enter show  esc back      │
└────────────────────────────────────────┘
```

Note: the `…` here is the cap marker, joined to the last words that fit; no other line of the summary is ever cut with `…`.
