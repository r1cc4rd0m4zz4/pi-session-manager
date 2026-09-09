# pi-session-manager

Zero-bloat session & configuration sync manager for [Pi Coding Agent](https://pi.dev) across macOS and Linux machines.

Works seamlessly with **OneDrive**, local mounts, or any private Git repository.

---

## Why pi-session-manager?

When switching between macOS and Linux machines (e.g. MacBook on the go and Linux desktop at home), Pi sessions and configurations don't naturally sync:

1. **Cross-OS Path Disconnect:** macOS uses `/Users/...` while Linux uses `/home/...`. Pi binds sessions to absolute paths, so sessions copied between OSes are invisible or fail to locate files.
2. **Secret Leakage Risk:** Naive folder syncs accidentally upload `auth.json` (API keys) to cloud drives.
3. **Binary Incompatibilities:** Syncing `~/.pi/agent/npm/` corrupts native compiled addons (macOS Darwin-arm64 vs Linux x86_64/aarch64).
4. **Symlink Chains:** Custom skills and extensions often symlink to dotfiles (`~/.agents/skills/`) which break when copied as raw symlinks.

`pi-session-manager` solves all of these with **zero third-party npm dependencies**:

- **Automatic Re-homing:** Rewrites working directories and header paths on pull, so you can resume work on another machine instantly.
- **Strict Security Guardrails:** Never touches `auth.json` (secrets remain local) and ignores `npm/` binaries.
- **Physical Target Preservation (Strategy 4):** Resolves symlinks to physical targets in your home folder, backs them up, and recreates the exact symlink tree on the target PC.
- **Dual Interface:** Interactive `fzf` CLI outside Pi (`pi-sm`) + lightweight native TUI commands inside Pi.
- **Silent Git Sync:** If your storage folder is a Git repo, it automatically pulls and commits/pushes changes silently in the background.

---

## Installation

### Method 1: 1-Click Installer (Recommended)

Clone the repository on your machine and run the built-in installer:

```bash
git clone https://github.com/r1cc4rd0m4zz4/pi-session-manager.git ~/gitapp/pi-session-manager
~/gitapp/pi-session-manager/bin/pi-sm install
```

This automatically:

- Symlinks `pi-sm` to `~/.local/bin/pi-sm`.
- Installs the Pi extension to `~/.pi/agent/extensions/pi-session-manager.ts`.
- Registers shell TAB autocompletion for **Zsh** and **Bash**.

### Method 2: Via Pi Package Manager (In-Pi Extension)

```bash
pi install git:github.com/r1cc4rd0m4zz4/pi-session-manager
```

---

## Commands

Command names and behaviors are **1:1 identical** inside and outside Pi:

| Action | Outside Pi (Terminal CLI) | Inside Pi (TUI Command) |
| :--- | :--- | :--- |
| **Save session to cloud** | `pi-sm session-push [tag]` | `/session-push [tag]` |
| **Resume cloud session** | `pi-sm session-pull` | `/session-pull` |
| **Explore / Delete sessions** | `pi-sm session-list` | `/session-list` |
| **Delete session directly** | `pi-sm session-delete` | `/session-delete` |
| **Backup settings & skills** | `pi-sm config-push` | `/config-push` |
| **Restore settings & skills** | `pi-sm config-pull` | `/config-pull` |

---

## Workflow Examples

### 1. Moving between macOS and Linux

**On your macOS machine:**

```bash
# Inside Pi (or outside via `pi-sm session-push feature-x`)
/session-push feature-x
```

**On your Linux machine:**

```bash
# In the project directory on Linux:
pi-sm session-pull
# -> Select 'feature-x' with fzf preview -> automatically re-homes paths -> launches pi!
```

### 2. Setting Up a Brand New Machine

```bash
# 1. Install CLI, extension, and tab completion:
./bin/pi-sm install

# 2. Pull all your settings, skills, and prompts from cloud:
pi-sm config-pull
```

---

## Storage & Cloud Detection

By default, `pi-session-manager` automatically discovers your cloud storage in this order:

1. `$PI_STORAGE_DIR` (if set)
2. `~/OneDrive/PiSync`
3. `~/Library/CloudStorage/OneDrive*/PiSync` (macOS CloudStorage)
4. Fallback: `~/.pi-sync`

### Storage Layout

```
<CloudStorage>/PiSync/
├── sessions/
│   ├── <project>--<tag>.jsonl
│   └── <project>--<tag>.meta.json
└── config/
    ├── settings.json
    ├── prompts/
    ├── home_targets/          # Physical files resolved from ~/.agents/...
    └── manifest.json          # Symlink & file layout map
```

---

## Configuration & Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PI_STORAGE_DIR` | Base cloud sync directory | `~/OneDrive/PiSync` or `~/.pi-sync` |
| `PI_SAVE_SESSION` | Custom directory for pushed sessions | `$PI_STORAGE_DIR/sessions` |
| `PI_LOAD_SESSION` | Custom directory for pulled sessions | `$PI_STORAGE_DIR/sessions` |
| `PI_CODING_AGENT_DIR` | Pi agent home directory | `~/.pi/agent` |

---

## Requirements

- **macOS** or **Linux**
- `bash` (4.0+)
- `python3` (preinstalled on macOS/Linux, standard library only)
- `fzf` (optional, recommended for rich interactive CLI selection)

---

## License

[MIT](LICENSE)
