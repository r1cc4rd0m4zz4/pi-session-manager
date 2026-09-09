# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

---

## Reporting a Vulnerability

We take the security of `pi-session-manager` seriously. If you discover a security vulnerability, **please do not open a public issue.**

Instead, please report vulnerabilities privately using GitHub's **[Private Vulnerability Reporting](https://github.com/r1cc4rd0m4zz4/pi-session-manager/security/advisories/new)** feature.

### What to include

- A clear description of the vulnerability and potential impact.
- Steps to reproduce or proof-of-concept.
- Suggestions on how to mitigate or fix the issue (if known).

### Our Commitment

- We will acknowledge receipt of your report within 48 hours.
- We will provide status updates as we validate and remediate the issue.
- You will be credited appropriately once a fix is released (unless you prefer anonymity).

---

## Security Architecture & Design Principles

1. **Zero Secret Leakage:** `auth.json` (API keys, provider credentials) is hard-coded to be excluded from all backups and synchronization.
2. **Architecture Isolation:** `npm/` binaries are strictly excluded to avoid cross-platform native binary corruption.
3. **Deterministic Pre-Push Scanning:** Repository utilizes local and CI-based Gitleaks scanners and CodeQL SAST analyzers to prevent accidental secret or PII exposure.
