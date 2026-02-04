# Voxii Desktop - Tasks

**Last Updated:** February 5, 2026

This is the single source of truth for execution work. Keep [../PRD.md](../PRD.md) spec-only.

---

## Rules (keep it lightweight)

- IDs are stable: `VD-###` (do not renumber).
- Dependencies are for real blockers only.
- When a task becomes Done, fill Session Done with a link to a session file.
- If a task changes product direction, log it in [DECISIONS.md](DECISIONS.md).

---

## Status

- Planned | In Progress | Blocked | Done | Cut

---

## Task Table

| ID | Title | Status | Priority | Area | Depends On | Session Done | Notes |
|----|-------|--------|----------|------|------------|--------------|-------|
| VD-001 | Seed backlog from PRD | Done | P0 | Docs | - | sessions/S01_2026-02-05.md | Imported requirements into this table |
| VD-002 | Transcription provider abstraction | Done | P0 | Providers (Transcription) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD TR-1.1) |
| VD-003 | Local transcription provider (whisper.cpp) | Done | P0 | Providers (Transcription) | VD-002 | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD TR-1.2) |
| VD-004 | OpenAI-compatible transcription provider | Done | P0 | Providers (Transcription) | VD-002 | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD TR-1.3) |
| VD-005 | Auto-detect best available transcription provider | Planned | P1 | Providers (Transcription) | VD-002 | - | PRD TR-1.4 |
| VD-006 | Provider fallback chain | Planned | P2 | Providers (Transcription) | VD-002 | - | PRD TR-1.5 |
| VD-007 | Chunk audio into 5-10s segments | Done | P0 | Providers (Transcription) | - | sessions/S02_2026-02-05.md | UI chunker + interval wired (PRD TR-2.1) |
| VD-008 | Process chunks progressively during recording | Done | P0 | Providers (Transcription) | VD-007 | sessions/S02_2026-02-05.md | UI now sends chunks to backend (PRD TR-2.2) |
| VD-009 | Emit partial transcript events | Done | P0 | Desktop Shell (Tauri) | VD-008 | sessions/S02_2026-02-05.md | Backend emits; UI listens (PRD TR-2.3) |
| VD-010 | Merge transcript chunks into full transcript | Done | P0 | Providers (Transcription) | VD-008 | sessions/S02_2026-02-05.md | Use merged streaming result on stop (PRD TR-2.4) |
| VD-011 | Voice activity detection to skip silence | Planned | P1 | Providers (Transcription) | VD-007 | - | PRD TR-2.5 |
| VD-012 | Display real-time transcript in UI | Done | P0 | UI (React) | VD-009 | sessions/S02_2026-02-05.md | Live transcript updates from stream (PRD TR-2.6) |
| VD-013 | Capture microphone audio | Done | P0 | Desktop Shell (Tauri) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD TR-3.1) |
| VD-014 | Mix microphone + system audio | Done | P1 | Desktop Shell (Tauri) | VD-013 | sessions/S02_2026-02-05.md | Log fallback if system audio not available (PRD TR-3.2) |
| VD-015 | Show audio level indicator | Planned | P1 | UI (React) | VD-013 | - | PRD TR-3.3 |
| VD-016 | Display recording timer | Done | P1 | UI (React) | VD-013 | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD TR-3.4) |
| VD-017 | Save raw audio locally (optional) | Planned | P2 | Storage/Export | VD-013 | - | PRD TR-3.5 |
| VD-018 | Clean transcript (remove fillers, fix grammar) | Done | P0 | Providers (Summary) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD AI-1.1) |
| VD-019 | Generate structured summary | Done | P0 | Providers (Summary) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD AI-1.2) |
| VD-020 | Extract action items as structured JSON | Done | P0 | Providers (Summary) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD AI-1.3) |
| VD-021 | Enhance selected text | Done | P1 | Providers (Summary) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD AI-1.4) |
| VD-022 | Stream AI responses | Done | P1 | Providers (Summary) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD AI-1.5) |
| VD-023 | Support AI model selection | Done | P1 | Providers (Summary) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD AI-1.6) |
| VD-024 | Generate Mermaid diagrams for flows | Planned | P2 | Providers (Summary) | - | - | PRD AI-1.7 |
| VD-025 | Export as Markdown file | Done | P0 | Storage/Export | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD EX-1.1) |
| VD-026 | Copy to clipboard (Markdown) | Done | P0 | Storage/Export | VD-025 | sessions/S02_2026-02-05.md | Copy markdown to clipboard (PRD EX-1.2) |
| VD-027 | Export as JSON (structured data) | Planned | P1 | Storage/Export | - | - | PRD EX-1.3 |
| VD-028 | Export as Slack blocks | Planned | P2 | Storage/Export | - | - | PRD EX-1.4 |
| VD-029 | Export action items as GitHub Issues | Planned | P2 | Storage/Export | - | - | PRD EX-1.5 |
| VD-030 | Storage provider abstraction | Planned | P1 | Storage/Export | - | - | PRD EX-2.1 |
| VD-031 | Google Drive integration (OAuth2) | Planned | P1 | Storage/Export | VD-030 | - | PRD EX-2.2 |
| VD-032 | OneDrive integration (OAuth2) | Planned | P1 | Storage/Export | VD-030 | - | PRD EX-2.3 |
| VD-033 | Dropbox integration (OAuth2) | Planned | P2 | Storage/Export | VD-030 | - | PRD EX-2.4 |
| VD-034 | Secure token storage (OS keychain) | Planned | P1 | Storage/Export | - | - | PRD EX-2.5 |
| VD-035 | Meeting list sidebar | Done | P0 | UI (React) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-1.1) |
| VD-036 | Meeting detail view | Done | P0 | UI (React) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-1.2) |
| VD-037 | Recording overlay mode (compact) | Planned | P0 | UI (React) | - | - | PRD UI-1.3 |
| VD-038 | Settings panel | Done | P0 | UI (React) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-1.4) |
| VD-039 | Global keyboard shortcut | Done | P1 | Desktop Shell (Tauri) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-1.5) |
| VD-040 | Floating notepad during recording | Planned | P0 | UI (React) | - | - | PRD UI-2.1 |
| VD-041 | Live transcript preview (dancing bars) | Done | P0 | UI (React) | VD-012 | sessions/S02_2026-02-05.md | Live transcript panel wired (PRD UI-2.2) |
| VD-042 | Recording timer display | Done | P1 | UI (React) | VD-016 | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-2.3) |
| VD-043 | Audio level visualization | Planned | P1 | UI (React) | VD-015 | - | PRD UI-2.4 |
| VD-044 | Quick stop button (prominent) | Done | P0 | UI (React) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-2.5) |
| VD-045 | Notes/Summary panel (left) | Done | P0 | UI (React) | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-3.1) |
| VD-046 | Transcript panel (right/collapsible) | Done | P0 | UI (React) | - | sessions/S02_2026-02-05.md | Collapsible transcript panel (PRD UI-3.2) |
| VD-047 | Action items checklist | Done | P0 | UI (React) | VD-020 | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-3.3) |
| VD-048 | Enhance notes button | Done | P0 | UI (React) | VD-021 | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD UI-3.4) |
| VD-049 | Share dropdown menu | Planned | P0 | UI (React) | - | - | PRD UI-3.5 |
| VD-050 | Diff view (raw vs cleaned transcript) | Planned | P2 | UI (React) | VD-018 | - | PRD UI-3.6 |
| VD-051 | Light/dark theme support | Planned | P1 | UI (React) | - | - | PRD UI-4.1 |
| VD-052 | Consistent typography (Fraunces + Manrope) | Planned | P1 | UI (React) | - | - | PRD UI-4.2 |
| VD-053 | Smooth panel transitions | Planned | P1 | UI (React) | - | - | PRD UI-4.3 |
| VD-054 | Loading/processing indicators | Planned | P1 | UI (React) | - | - | PRD UI-4.4 |
| VD-055 | App icon and branding | Planned | P1 | UI (React) | - | - | PRD UI-4.5 |
| VD-056 | Persist meetings as JSON | Done | P0 | Storage/Export | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD ST-1.1) |
| VD-057 | Store config in app data folder | Done | P0 | Storage/Export | - | sessions/S01_2026-02-05.md | Implemented in current codebase (PRD ST-1.2) |
| VD-058 | Secure credential storage (keychain) | Planned | P1 | Storage/Export | VD-057 | - | PRD ST-1.3 |
| VD-059 | Meeting search/filter | Planned | P2 | UI (React) | VD-056 | - | PRD ST-1.4 |
| VD-060 | Data export/backup | Planned | P2 | Storage/Export | VD-056 | - | PRD ST-1.5 |
| VD-061 | Validate streaming latency <5s from speech | Planned | P1 | Diagnostics | - | - | PRD NFR-1 |
| VD-062 | Validate batch latency <10s per minute | Planned | P1 | Diagnostics | - | - | PRD NFR-2 |
| VD-063 | Validate summary latency <5s for 10min meeting | Planned | P1 | Diagnostics | - | - | PRD NFR-3 |
| VD-064 | Confirm local mode = zero network | Planned | P1 | Diagnostics | - | - | PRD NFR-4 |
| VD-065 | Validate memory usage <500MB during recording | Planned | P2 | Diagnostics | - | - | PRD NFR-5 |
| VD-066 | Cross-platform verification (Win/Mac/Linux) | Planned | P1 | Diagnostics | - | - | PRD NFR-6 |
| VD-067 | Accessibility verification (keyboard + screen reader) | Planned | P2 | Diagnostics | - | - | PRD NFR-7 |
| VD-068 | Fix local whisper config persistence (v2 fields) | Done | P0 | Desktop Shell (Tauri) | VD-057 | sessions/S02_2026-02-05.md | Align settings + diagnostics with v2 config |
| VD-069 | Add system-audio toggle in recording controls | Done | P1 | UI (React) | VD-014 | sessions/S02_2026-02-05.md | Toggle system capture near Start/Stop |
| VD-070 | Add local model folder + selector | Done | P1 | UI (React) | VD-057 | sessions/S02_2026-02-05.md | Model dropdown sourced from local folder |
| VD-071 | Add live transcript toggle in record bar | Done | P1 | UI (React) | VD-012 | sessions/S02_2026-02-05.md | Toggle streaming on/off in config |
| VD-072 | Skip batch transcription when live transcript exists | Done | P1 | Providers (Transcription) | VD-012 | sessions/S02_2026-02-05.md | Use live transcript as final output |
| VD-073 | Flush final streaming chunk on stop | Done | P1 | Providers (Transcription) | VD-008 | sessions/S02_2026-02-05.md | Prevent tail loss + retry chunk decode |

---

## Areas (suggested)

- UI (React)
- Desktop Shell (Tauri)
- Providers (Transcription)
- Providers (Summary)
- Storage/Export
- Diagnostics
- Docs
