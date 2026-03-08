<p align="center">
  <img src="https://img.shields.io/badge/ddududdudu-v0.2.0-f7a7bb?style=for-the-badge&labelColor=000000" alt="version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-f7a7bb?style=for-the-badge&labelColor=000000&logo=node.js&logoColor=f7a7bb" alt="node" />
  <img src="https://img.shields.io/badge/rust-stable-f7a7bb?style=for-the-badge&labelColor=000000&logo=rust&logoColor=f7a7bb" alt="rust" />
  <img src="https://img.shields.io/badge/license-MIT-f7a7bb?style=for-the-badge&labelColor=000000" alt="license" />
</p>

<p align="center">
  <img src="assets/ddudu-logo.svg" alt="ddudu logo" width="1200" />
</p>

<p align="center">
  <em>AI coding harness</em>
</p>

---

## Modes

| Mode     | Provider       | Model               | Role                                      |
| -------- | -------------- | ------------------- | ----------------------------------------- |
| `JENNIE` | Anthropic      | `claude-opus-4-6`   | orchestration, verification, delegation   |
| `LISA`   | OpenAI / Codex | `gpt-5.4`           | fast execution, low-overhead action       |
| `ROSÉ`   | Anthropic      | `claude-sonnet-4-6` | planning, architecture, careful reasoning |
| `JISOO`  | Gemini         | `gemini-2.5-pro`    | design, UI/UX, visual thinking            |

`Shift+Tab` cycles modes inside the TUI.

## Built-In Tools

| Tool           | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `read_file`    | read files into the working context                 |
| `write_file`   | create or overwrite files                           |
| `edit_file`    | patch existing files                                |
| `list_dir`     | inspect directory contents                          |
| `bash`         | run shell commands                                  |
| `grep`         | search file contents                                |
| `glob`         | match paths by pattern                              |
| `web_fetch`    | fetch and summarize remote pages                    |
| `task`         | delegate work to a sub-agent                        |
| `oracle`       | ask a stronger secondary model for a focused answer |
| `ask_question` | pause and request user input inside a run           |
| `memory`       | read or write persistent memory                     |

## Quick Start

### Prerequisites

- Node.js `>= 20`
- Rust stable toolchain

### From Source

```bash
npm install
npm run build
npm link
ddudu
```

If you do not want to link globally:

```bash
npm install
npm run build
node dist/index.js
```

## Authentication

ddudu can reuse existing provider auth instead of forcing new secrets everywhere.

Supported auth paths today:

- Claude: `claude auth login` or `ANTHROPIC_API_KEY`
- Codex/OpenAI: `codex login` or `OPENAI_API_KEY`
- Gemini: `GEMINI_API_KEY` or `~/.gemini/oauth_creds.json`

Check what ddudu sees:

```bash
ddudu auth
```

## CLI Commands

```bash
ddudu                 # launch TUI
ddudu auth            # show detected auth
ddudu init            # initialize .ddudu/ in current project
ddudu doctor          # basic environment check
ddudu config show     # print merged config
ddudu session list    # list saved sessions
ddudu session resume <id>  # reopen a saved local session in the native TUI
```

## TUI Shortcuts

| Key             | Action                                     |
| --------------- | ------------------------------------------ |
| `Shift+Tab`     | cycle mode                                 |
| `Ctrl+J`        | newline in composer                        |
| `Enter`         | submit                                     |
| `Esc`           | interrupt running request / clear composer |
| `Up` / `Down`   | scroll transcript when composer is empty   |
| `PgUp` / `PgDn` | jump scroll                                |
| `End`           | follow latest output                       |

## Slash Commands

Current native TUI commands:

- `/clear`
- `/compact`
- `/mode`
- `/model`
- `/memory`
- `/session`
- `/config`
- `/help`
- `/doctor`
- `/review`
- `/fire`
- `/init`
- `/skill`
- `/hook`
- `/mcp`
- `/team`
- `/quit`

## Project Layout

Project-level files live under `.ddudu/`.

Typical setup:

```text
.ddudu/
├── config.yaml
├── DDUDU.md
├── rules/
├── prompts/
└── sessions/
```

User-level state can also live under `~/.ddudu/`.

## License

MIT

---

<p align="center">
  Inspired by <a href="https://github.com/minpeter">minpeter</a>
</p>
