# Antigravity Quota Monitor

Live **5-hour** and **weekly** model quota tracker for **Google Antigravity** — right in the side pane, with native **macOS Menu Bar circular gauge** and **system notifications**.

Zero extra LLM tokens · 100% local · No npm dependencies · Auto-syncs Light & Dark themes.

---

## Features

- **Compact 5-hour & Weekly Circular Rings**: Instant at-a-glance cards for **Gemini** and **Claude / GPT** pools with live ticking reset countdowns (`1h 30m`, `6d 20h`) — no need to dig through `Settings → Model`.
- **Collapsible Model Breakdown**: Per-family breakdown (with `Low` / `Medium` / `High` / `XHigh` effort tiers) tucked cleanly under a collapsed accordion.
- **Native macOS Menu Bar Circle** (`NSStatusBar`): Always-visible color-coded circular progress ring + percentage in the macOS top bar, with a crisp dropdown showing 5h & weekly limits, credits, and reset timers. Automatically compiled locally from `menubar.swift` on first launch (works on both Apple Silicon and Intel Macs — no prebuilt binaries!).
- **macOS System Notifications**: Alerts when any 5-hour or weekly pool drops below configurable thresholds (`50%`, `25%`, `10%`, `0%`) or resets back to `100%`, plus a built-in test button.
- **Native Theme Sync**: Inherits Antigravity's exact light and dark theme variables via `/preload.js`.

---

## Installation

### Option 1 — Antigravity CLI (Recommended)
```bash
agy plugin install https://github.com/iazazello/antigravity-quota-monitor
```

### Option 2 — Quick Install Script (macOS / Linux)
```bash
git clone https://github.com/iazazello/antigravity-quota-monitor.git
cd antigravity-quota-monitor
./install.sh
```

### Option 3 — Manual Copy
Clone or download this repository into:
- **Global (all projects):** `~/.gemini/config/plugins/quota-monitor`
- **Workspace-only:** `<your-project>/.agents/plugins/quota-monitor`

Antigravity automatically discovers and starts the plugin — no restart required.

---

## Usage

1. **Side Pane:** Click **`+`** in the top-right header of any Antigravity conversation → select **Quota Monitor**.
2. **macOS Menu Bar:** Enabled by default on macOS (requires Xcode Command Line Tools `swiftc`, which is preinstalled on most dev Macs; if missing, run `xcode-select --install`). Toggle it anytime from the panel's Settings section or click **«Скрыть из Menu Bar»** in the dropdown.
3. **Manage Plugin:** Open **Skills & Customizations → Plugins → Quota Monitor** in Antigravity's left sidebar to enable, disable, or uninstall.

---

## Platform Support

| Surface | macOS (Apple Silicon & Intel) | Linux | Windows |
| --- | :---: | :---: | :---: |
| Antigravity Side Pane (5h + weekly rings) | Yes | Yes | Yes |
| Native Menu Bar Circular Gauge | Yes (auto-compiled) | — | — |
| System Notifications | Yes (`osascript`) | — | — |

---

## Privacy & Security

- **100% Local:** Queries only Antigravity's local Language Server (`RetrieveUserQuotaSummary` and `GetUserStatus`) over loopback using the ephemeral `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` provided by Antigravity.
- **No PII or Token Leakage:** Account email, name, avatar URL, and CSRF tokens are never written to `snapshot.json`, never returned to the web UI, and never sent externally.
- **Zero External Telemetry & Zero LLM Cost:** Runs as a lightweight local Node.js sidecar.

---

## Кратко на русском

**Antigravity Quota Monitor** — плагин для Google Antigravity, который показывает **5-часовые** и **недельные** лимиты моделей прямо в боковой панели, в верхней строке **Menu Bar macOS** (кружок с процентом) и через **системные уведомления macOS**.

- Установка: `agy plugin install https://github.com/iazazello/antigravity-quota-monitor` или клонирование + `./install.sh`.
- Открытие панели: кнопка **`+`** в правом верхнем углу чата Antigravity → **Quota Monitor**.
- На macOS кружок в Menu Bar автоматически собирается локально из `menubar.swift` при первом запуске (работает на Apple Silicon и Intel).

---

## License

[MIT](./LICENSE) © 2026 iazazello
