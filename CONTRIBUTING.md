# Contributing to Akasha-OS

Thank you for your interest in contributing to the world's first democratised distributed AI operating system! 🚀

## Code of Conduct

This project adheres to a simple principle: **build together, with respect.** We welcome contributors from all backgrounds, skill levels, and time zones. Harassment, gatekeeping, and big-tech-pilled behaviour will not be tolerated.

## How to Contribute

### 1. Write a Plugin (easiest!)

The fastest way to contribute is to write an **Expert Plugin**. Implement the `AkashaExpertPlugin` interface, pick a domain, and submit it:

```typescript
import type { AkashaExpertPlugin } from 'akasha-os';

const myPlugin: AkashaExpertPlugin = {
  metadata: { /* ... */ },
  execute: async (inputTensor: Float32Array): Promise<Float32Array> => {
    // Your model inference here
  },
};
```

See [`examples/`](examples/) for ready-to-copy templates.

### 2. Improve the Core

| Layer | Language | Directory | Good first issues |
|-------|----------|-----------|-------------------|
| Master Orchestrator | TypeScript | `akasha-master/` | Improve routing, add cluster strategies |
| Native Kernel | Rust | `akasha-kernel-native/` | Optimise GPU shaders, platform support |
| Browser Client | TypeScript | `akasha-client-web/` | Dashboard UI, WebGPU perf tuning |

### 3. Report Bugs / Propose Features

Use the [issue templates](.github/ISSUE_TEMPLATE/):
- [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Plugin Proposal](.github/ISSUE_TEMPLATE/plugin_proposal.md)
- [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)

## Development Setup

```bash
git clone https://github.com/ootaniryou-sudo/Akasha-OS.git
cd Akasha-OS

# Master (TypeScript)
cd akasha-master && npm install && npm run build

# Kernel (Rust)
cd ../akasha-kernel-native && cargo check

# Client (Browser)
cd ../akasha-client-web && npm install && npm run build
```

## Pull Request Process

1. Fork the repo and create your branch from `main`.
2. If you've added code, add tests where possible.
3. Ensure `npm run build` (akasha-master) or `cargo check` (kernel) passes.
4. Update the README if you've changed APIs.
5. Submit a PR with a clear description.

## Community Channels

- **GitHub Discussions**: For Q&A, ideas, and show-and-tell.
- **Issues**: For bugs and feature tracking.
- **Plugin Marketplace** (coming soon): Discover community-built experts.

---

> *「知識は、たとえそれが砂粒のように小さくとも、繋がれば砂漠となり、やがて全世界を覆う。」*
> —— スメール・アーカーシャシステム運用理念（『原神』世界設定より）
