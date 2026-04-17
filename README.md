# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and Kiro).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and Kiro.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`
> - Kiro: install [Kiro](https://kiro.dev) and ensure `kiro-cli` is on your PATH (typically `~/.toolbox/bin/kiro-cli`)

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## Running Locally (Fork)

This fork adds the Kiro ACP provider on top of upstream `pingdotgg/t3code`. To run it locally:

### Prerequisites

- [Bun](https://bun.sh/) (v1.2+)
- At least one provider CLI installed and authenticated:
  - **Codex**: `npm i -g @openai/codex` then `codex login`
  - **Claude**: install Claude Code then `claude auth login`
  - **Kiro**: install [Kiro](https://kiro.dev) and ensure `kiro-cli` is on your PATH (typically `~/.toolbox/bin/kiro-cli`)

### Setup and Run

```bash
# Clone the fork
git clone https://github.com/hrishikeshmane/t3code.git
cd t3code

# Install dependencies
bun install

# Start the dev server (runs both server + web UI)
bun run dev
```

This starts:
- Server on `http://localhost:13777` (WebSocket + API)
- Web UI on `http://localhost:5737`

Open `http://localhost:5737` in your browser.

### Verification Commands

```bash
bun typecheck    # type-check all 9 packages
bun fmt          # format with oxfmt
bun lint         # lint with oxlint
bun run test     # run tests with vitest (never use `bun test` directly)
```

### Syncing with Upstream

This fork tracks `pingdotgg/t3code`. See [PATCH.md](./PATCH.md) for detailed instructions on pulling in upstream changes and resolving conflicts.

```bash
# Add upstream remote (one-time)
git remote add upstream https://github.com/pingdotgg/t3code.git

# Pull in latest changes
git fetch upstream
git merge upstream/main
bun install && bun typecheck && bun run dev
```

---

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
