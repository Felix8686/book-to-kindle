# Changelog

All notable changes to this project will be documented in this file.

The project follows Semantic Versioning while it is practical to do so.

## [Unreleased]

### Planned
- Gmail OAuth delivery adapter
- Telegram webhook entry point
- Hermes Skill/MCP bridge
- production source adapters
- candidate confirmation endpoint
- optional Shelfmark/CWA/Calibre enhancement node

## [0.1.0] - 2026-08-29

### Added
- initial Cloudflare Worker project
- HTTP task creation/status API
- bearer-token API authentication
- D1 task persistence
- Cloudflare Queue asynchronous execution
- R2 staging binding
- task state machine
- deterministic candidate ranking and ambiguity guard
- source/delivery adapter contracts
- local execution via Wrangler
- Cloudflare deployment configuration
- architecture and deployment documentation

### Design decisions
- Cloudflare Free is the primary always-on target.
- Local and cloud execution share the same core codebase.
- Docker/Calibre are excluded from the Cloudflare core path.
- Heavy conversion is reserved for an optional local enhancement node.
- Search results are never blindly accepted solely because they are first in the list.
