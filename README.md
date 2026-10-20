# agent-tree

[![ci](https://github.com/tellship/agent-tree/actions/workflows/ci.yml/badge.svg)](https://github.com/tellship/agent-tree/actions/workflows/ci.yml)

A Claude Code mod: a pane docked beside the transcript that shows every agent
and its delegation as a live tree.

## Install

Requires Claude Code 2.1.296 or newer (check with `claude --version`). The
mod uses the early-access function hooks API; it was built and tested on
2.1.296, and older versions are untested.

Inside Claude Code:

```
/plugin marketplace add tellship/agent-tree
/plugin install agent-tree@agent-tree
```

### From a local clone (for development)

1. Clone the repo:

   ```sh
   git clone https://github.com/tellship/agent-tree.git ~/.claude/mods/agent-tree
   ```

2. Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`
   (colon-separated if you already load other mods):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/mods/agent-tree"
     }
   }
   ```

3. Restart Claude Code.

## Usage

The pane opens on its own in terminals 144 columns or wider. Otherwise, open
it yourself:

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `/agent-tree`        | Open the agents pane                           |
| `/agent-tree clear`  | Remove finished agents from the tree           |
| `/agent-tree close`  | Close the pane (the tree is kept)              |

Click a row, or use the arrow keys after `ctrl+x tab` focuses the pane, to
see that agent's details below the tree.

## Run the tests

The tests use only Node's built-in test runner, with no dependencies to
install. They need Node 23.6+ (to run TypeScript directly):

```sh
node --test tests/tree.spec.ts
```

## License

[MIT](LICENSE)
