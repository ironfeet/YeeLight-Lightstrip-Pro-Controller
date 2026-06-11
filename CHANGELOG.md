# Changelog

All notable changes to this project will be documented in this file.

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
