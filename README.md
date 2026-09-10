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
- **Self-Contained Session Containers:** Bundles the session transcript and auxiliary extension data into a single `.pi-session.tar.gz` container with instant metadata caching.
- **Zero Zombie Chunks:** Pre-cleans destination session targets on re-home to ensure no orphaned artifacts remain.
- **Strict Security Guardrails:** Never touches `auth.json` (secrets remain local) and ignores `npm/` binaries.
- **Physical Target Preservation:** Resolves symlinks to physical targets in your home folder, backs them up, and recreates the exact symlink tree on the target PC.
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

```text
<CloudStorage>/PiSync/
├── sessions/
│   ├── <project>--<tag>.pi-session.tar.gz  # Compressed self-contained session container
│   └── <project>--<tag>.meta.json          # Enriched metadata & instant dialogue preview
└── config/
    ├── settings.json
    ├── sol-pi.json                         # Global SoL-Pi config (synced safely)
    ├── prompts/
    ├── home_targets/                       # Physical files resolved from ~/.agents/...
    └── manifest.json                       # Symlink & file layout map
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

## External Integrations & Compatibility

### ⚡ SoL-Pi Integration ([NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi))

`pi-session-manager` includes native, out-of-the-box compatibility with NVIDIA's **SoL-Pi** research harness:

- **ObservationPack Asset Preservation:** When SoL-Pi's `observationPack` archives large tool outputs (>10KB) under `<sessionDir>/sol-pi/<sessionId>/`, `pi-session-manager` packages the auxiliary storage directly into the `.pi-session.tar.gz` container.
- **Cross-Platform `obs_recall`:** Moving sessions between macOS and Linux automatically re-homes `<sessionDir>/sol-pi/<sessionId>/`, ensuring the `obs_recall` tool never fails with missing file errors (`ENOENT`).
- **Global Configuration Sync:** `sol-pi.json` in `~/.pi/agent/` is automatically backed up and restored via `config-push` and `config-pull`, preserving feature flags across machines.
- **Zero Orphaned Chunks:** Target directories are cleanly replaced during re-home, eliminating obsolete or stale observation chunks.
- **Visual Indicator:** Sessions containing SoL-Pi data are flagged with a `⚡` badge in `session-list` and interactive CLI previews.

### 🧩 Architecture for Future Integrations

`pi-session-manager` provides a general-purpose, extensible container model for Pi ecosystem tools:

- **Auxiliary Session Directories:** Any extension maintaining session-scoped local storage under `~/.pi/agent/sessions/<project>/<extension-id>/<sessionId>/` can be packaged inside `.pi-session.tar.gz` without breaking portability.
- **Safe Root Config Whitelist:** Configuration files are synced via an explicit whitelist (`settings.json`, `sol-pi.json`, `models.json`, `keybindings.json`, `AGENTS.md`, `APPEND_SYSTEM.md`, `SYSTEM.md`), completely preventing credential leakage (`auth.json` is strictly air-gapped).
- **Zero Third-Party Dependencies:** All compression and re-homing operations rely exclusively on native system utilities (`tar`, `gzip`) and standard libraries (`node:child_process`, Python's `tarfile`), keeping your harness lean and maintenance-free.

---

## Requirements

- **macOS** or **Linux**
- `bash` (4.0+)
- `python3` (preinstalled on macOS/Linux, standard library only)
- `fzf` (optional, recommended for rich interactive CLI selection)

---

## Security & Privacy Notice

- **Secrets Stay Local:** `pi-session-manager` explicitly excludes `auth.json` (API keys) and `npm/` native binaries. No credentials are ever uploaded or synced.
- **Private Cloud Storage:** While API keys are protected, session transcripts and prompt history will be synchronized to your designated cloud folder. Ensure your OneDrive, sync directory, or private Git repository has appropriate access permissions.
- **Provided "AS IS":** This software is provided under the terms of the [MIT License](LICENSE) without warranty of any kind.

---

## License

[MIT](LICENSE)
