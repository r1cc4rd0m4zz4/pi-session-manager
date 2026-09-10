# Contributing to pi-session-manager

Thank you for your interest in improving `pi-session-manager`! We welcome bug reports, feature suggestions, and code contributions.

---

## Core Architecture Principles

Before opening a pull request, please ensure your contribution adheres to the core design principles of this project:

1. **Zero Third-Party npm Dependencies:**
   - The project relies entirely on native system utilities (`bash`, `python3`, `tar`, `gzip`) and standard Node.js APIs (`node:fs`, `node:child_process`, `node:path`, `node:buffer`).
   - Do **not** add third-party npm packages or dependencies to `package.json`.

2. **100% Parity between CLI and TUI:**
   - Features implemented in the interactive Pi TUI extension (`extensions/pi-session-manager.ts`) must have identical behavior and command semantics in the standalone CLI (`bin/pi-sm`), and vice-versa.

3. **Strict Privacy & Secret Protection:**
   - `auth.json` (API keys) and local binaries (`npm/`) must **never** be touched, synced, or backed up.
   - Never hardcode personal paths, local usernames, or credentials into repository code or documentation.

4. **Clean Filesystem Hygiene:**
   - Use standard library temp directories (`tempfile.TemporaryDirectory` in Python, `fs.mkdtempSync` with `try...finally` in Node.js) instead of raw shell commands like `rm -rf`.

---

## Development & Local Testing

1. **Install locally:**

   ```bash
   ./bin/pi-sm install
   ```

2. **Verify shell syntax:**

   ```bash
   bash -n bin/pi-sm
   ```

3. **Run Pre-Push Security Checks:**

   ```bash
   ./.githooks/pre-push
   ```

---

## Submitting Pull Requests

1. Fork the repository and create your branch from `main`.
2. Ensure your code follows Conventional Commits format (`feat: ...`, `fix: ...`, `docs: ...`).
3. Make sure all pre-push security hooks pass cleanly.
4. Open a Pull Request referencing any related issues.
