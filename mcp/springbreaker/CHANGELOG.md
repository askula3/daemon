# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/), and
releases use semantic versioning.

## [Unreleased]

### Changed

- Hardened project-path, configuration, subprocess, HTTP, XML, plan, Git, and
  rollback trust boundaries.
- Replaced placeholder IQ calls with CycloneDX third-party scan contracts.
- Added explicit plan approval, structured MCP outputs, annotations, progress,
  cancellation propagation, packaging gates, and security documentation.

### Security

- Updated `fast-xml-parser` to a patched release.
- Prevented service credentials from being inherited by Maven child processes.
