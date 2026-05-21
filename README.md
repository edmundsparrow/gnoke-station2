# Gnoke Station v2 ⬡

A sovereign, browser-based Operating System architecture built on a "Sphere" microkernel. Gnoke Station transforms the web browser from a document viewer into a persistent, local-first workspace manager.

## 🏗 Architecture (The Sphere)
- **/firmware**: Frozen firmware. The microkernel and capability authority.
  - `gnoke-worker.js`: The system bus (SharedWorker) managing process registry and topology.
  - `gnoke-kernel.js`: The capability authority enforcing exclusive resource ownership.
  - `gnoke-client.js`: The lightweight stub connecting tabs to the bus.
- **/system**: Privilege-aware drivers and abstraction layers (`gnoke-hal.js`, `gnoke-syscall.js`).
- **/apps**: Volatile, lightweight tools (Notes, Pache, etc.) that execute within the shell.

## ⚡ Key Features
- **Sovereign OS Pattern**: The browser is the kernel; tabs are processes.
- **Capability Authority**: Kernel-enforced "First-port-wins" access to Serial, USB, and Filesystem.
- **Spirit (Resurrection)**: Automatic state persistence and UI restoration across tab suspensions.
- **Vanilla Stack**: Zero dependencies. Built strictly with pure HTML, CSS, and JavaScript.

## 🚀 Quick Start
1. Host the directory on a local or secure server (requires HTTPS for SharedWorkers/Web APIs).
2. Open `index.html` to launch the App Player.
3. Open `debug.html` to manage the system (PID 1).

---
*Built for digital autonomy and e-waste reduction.*
**Edmund Sparrow © 2026**
