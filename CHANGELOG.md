# Changelog

All notable changes to this project will be documented in this file.

## [0.0.9] - 21-06-2026

### Fixed
- **Smarter Transcript Reading:** The agent status reader now uses a 256 KB window (up from 32 KB) and correctly skips the inevitable truncated first line when reading large files. This means the app reliably reads up to 150 recent transcript entries instead of the ~17 it was silently capturing before.
- **Settings Tab No Longer Freezes the Light:** Opening the ⚙ Settings panel now works as a true overlay — it doesn't stop any polling timers or change the active light mode. Closing it and switching back to any mode works instantly.
- **Settings Mode Never Saved to Disk:** Previously, if you opened Settings and quit the app, it would restart in a permanently frozen state. The app now correctly ignores `settings` when saving your last active mode.
- **Connection Security Hardened:** All outbound network requests are now validated against a strict allowlist. Only your configured Home Assistant server and GitHub's API are permitted — preventing any other origin from being reached through the app's network proxy.
- **Memory Leak from Polling Fixed:** The Home Assistant client was being recreated on every single poll cycle (up to 3 times per second). It now uses a smart singleton that is only rebuilt when your connection settings actually change.
- **Status Log File Removed:** The app was writing an unbounded `agent_status_log.txt` file into the project directory on every state change. State tracking is now done in-memory only.
- **Poll Intervals Now Have a Single Source of Truth:** The agent and IDE poll interval settings were stored in three separate places that could drift out of sync. They now read directly from the config object everywhere.

## [0.0.8] - 20-06-2026

### Fixed
- **CLI Sync Fix:** Fixed an issue where the app would stay "Offline" or "Idle" when running the Antigravity CLI. The app now dynamically scans both the legacy and new `antigravity-cli` directories to instantly lock onto your active agent session.
- **Hardware Color Flash:** Fixed a bug where toggling the Power button to ON while the agent was idle/off would cause the light strip to briefly flash its previous hardware color (usually the color from Screen Mode) before turning off. The app now immediately pushes the clean internal state to the hardware, bypassing its memory.

## [0.0.7] - 18-06-2026

### Fixed
- **Rock-Solid Connections:** Completely eliminated the possibility of strict browser CORS policies blocking your connection to Home Assistant. The app now routes all network calls through a secure native backend proxy, ensuring your commands always go through flawlessly.

## [0.0.6] - 17-06-2026

### Added
- **Update Checker:** You can now see your current app version and instantly check for new updates directly from the Settings tab! The app is smart enough to ensure you only get notified when a genuinely newer version is available.

### Changed
- **Cleaner Settings Storage:** The app now saves its settings into its own dedicated `~/.yeelight-lightstrip-pro-controller` folder.
- **Auto-Migration:** Don't worry about losing your setup! The next time you open the app, it will automatically find your old settings and seamlessly move them to the new folder without you having to do a thing.
## [0.0.5] - 17-06-2026

### Security
- **Major Engine Upgrade:** Upgraded the core Electron engine from v22 all the way to v41.7.1! This massive leap addresses 18 separate high-to-moderate security vulnerabilities reported by GitHub Dependabot (including fixes for Heap Buffer Overflows, ASAR Integrity Bypasses, and IPC spoofing).
- **Hardened Dependencies:** Safely patched and modernized all underlying transitive packages to ensure zero vulnerabilities remain.

## [0.0.4] - 17-06-2026

### Added
- **Connection Error Warnings:** Added a sleek new warning banner that gracefully slides down from the top of the app to let you know if the connection to Home Assistant is lost (like during a Wi-Fi drop or server restart). It automatically disappears the moment the connection is back!

### Fixed
- **Reliable Home Assistant Connections:** Fixed a strict browser security issue that was secretly blocking the app from talking to Home Assistant out of the box. The app now uses a smarter, dedicated internal connection method, guaranteeing it works flawlessly on any setup without compromising your security.

## [0.0.3] - 11-06-2026

### Added
- **Menubar Mode Switching:** Added a dynamic context menu to the macOS Tray icon. You can now seamlessly switch between Dynamic Screen Mode, AI Agent Mode, and IDE Agent Mode directly from the menubar without opening the main application window.
- **Bi-directional State Sync:** Built a robust IPC synchronization layer between the backend Tray menu and the frontend UI. Clicking a mode in the menubar instantly updates the UI tabs and config, and clicking a tab in the UI instantly updates the radio checkmarks in the menubar.

### Fixed & Improved
- **App Stability:** Fixed several underlying issues that could cause the app to quietly crash or freeze in the background. The app is now rock-solid and optimized to run for weeks without memory leaks or heavy CPU usage.
- **Enhanced Security:** Eliminated a potential security vulnerability in the log display, and updated the network policy so the app securely adapts to your specific Home Assistant address right out of the box.
- **Layout Polish:** Fixed an issue where long AI agent logs would push the legend and interval sliders off the bottom of the screen. They now stay firmly anchored where they belong.
- **Smarter Auto-Off:** The 10-minute screen inactivity auto-off timer is now perfectly isolated. Color changes triggered by Agent or IDE modes will no longer accidentally reset your screen timeout.
- **Accurate "Waiting" State:** Fixed a bug where long operations (like writing a large file or doing deep research) would incorrectly show the agent as "Waiting". The waiting indicator now correctly appears *only* when an action genuinely requires your approval.
- **Reliable Settings:** Fixed an issue where changing the agent poll interval sliders or switching the active tab wouldn't always save correctly. The app now reliably remembers your slider settings and your last active mode across restarts.
- **Network Resilience:** Added automatic 5-second timeouts to all Home Assistant communications. If your Home Assistant server or Wi-Fi temporarily drops, the app will handle it gracefully instead of freezing.

## [0.0.2] - 11-06-2026

### Changed
- **Repository URL:** Updated the package metadata and Git remote configuration to reflect the official repository rename to `YeeLight-Lightstrip-Pro-Controller`.

### Fixed
- **CI/CD Release Pipeline:** Overhauled the GitHub Actions release workflow to use `softprops/action-gh-release`. This bypasses `electron-builder`'s internal publisher, guaranteeing that the standalone `.zip` app artifact is flawlessly uploaded every time alongside the correct release notes.
- **Release Status:** Configured `electron-builder` to immediately publish releases to the public, bypassing the native Draft mode behavior.
- **CodeQL Quality Alert:** Removed legacy dead code (`APPROVAL_REQUIRED_TOOLS`) from `main.js` to resolve an unused local variable alert thrown by the CodeQL scanner.
- **Waiting Status Heuristic Bug:** Fixed a bug where the UI would falsely display "Waiting / Busy" during long, intensive code generation blocks. The heuristic timeout in the code has been properly synced to the intended 30 seconds.


## [0.0.1] - 11-06-2026

### Added
- **Initial Open-Source Release:** Launch of "YeeLight Lightstrip Pro Controller".
- **Dynamic Screen Mode (Ambilight):** Custom Ambilight implementation using a highly responsive weighted RGB average to match the screen's ambient glow.
- **AI Agent Mode:** Syncs physical light strip to the real-time processing state of the Antigravity AI engine (Idle, Thinking, Running, Waiting, etc.).
- **IDE Agent Mode:** Dedicated synchronization profile for the Antigravity IDE agent.
- **Energy Saving Auto-Off:** Intelligent 10-minute timeout heuristic that turns the light off when the screen is static, and instantly wakes it up upon detecting movement or color changes.
- **macOS Menu Bar Native Integration:** High-DPI (Retina) dynamic tray icon that perfectly reflects the real-time color and power state of the light strip.
- **Smart State Detection:** Advanced log-parsing logic featuring a 30-second heuristic timeout to reliably differentiate between long code generations ("Thinking") and hard user-approval blocks ("Pending / Blocked").
- **Home Assistant Integration:** Granular control over HA configuration, including URL, Long-Lived Token authentication, and specific entity targeting.
- **Performance Tuning UI:** Real-time settings panel for adjusting Screen Update Intervals, Saturation Boost, and Color Change debouncing thresholds.
- **GitHub Actions Automation:** Integrated CI/CD pipelines for automated macOS `.zip` package builds, CodeQL security scanning, and automated GitHub Releases.
