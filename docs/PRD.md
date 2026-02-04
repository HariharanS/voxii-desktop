# Voxii Desktop - Product Requirements Document

**Version:** 2.0  
**Date:** February 4, 2026  
**Status:** In Development  
**Platform:** Windows, macOS, Linux  

---

## Working Docs
# Voxii Desktop - Product Requirements Document

**Version:** 2.2.1  
**Date:** February 5, 2026  
**Status:** In Development  
**Platform:** Windows, macOS, Linux

---

## Working Docs

This PRD is spec-only. Execution tracking lives in the working docs:

- Progress: [working/PROGRESS.md](working/PROGRESS.md)
- Tasks: [working/TASKS.md](working/TASKS.md)
- Decisions: [working/DECISIONS.md](working/DECISIONS.md)
- Learnings: [working/LEARNINGS.md](working/LEARNINGS.md)
- Sessions: [working/sessions/](working/sessions/)
- Technical spec: [TECH_SPEC.md](TECH_SPEC.md)

## 1. Overview

### 1.1 Product Name
**Voxii Desktop** (Voice -> Intelligence -> Structured Documentation)

### 1.2 Tagline
"Your meetings, intelligently documented."

### 1.3 Problem Statement
Technical teams spend 10-15 hours weekly in meetings but struggle to:
- Take notes while actively participating in technical discussions
- Capture architecture decisions, code references, and complex flows
- Extract actionable items with clear ownership
- Share clean summaries across tools (Slack, Confluence, GitHub)
- Maintain privacy for sensitive corporate/engineering discussions

Existing solutions (Otter, Fireflies, Granola) are:
- Cloud-only, raising privacy/compliance concerns
- Subscription-heavy with vendor lock-in
- Generic, lacking technical team context
- Unable to integrate with engineering workflows

### 1.4 Solution
Voxii Desktop is an enterprise-ready, local-first meeting intelligence app that:

1. Records and transcribes meetings with pluggable backends (local Whisper or any OpenAI-compatible API)
2. Streams live transcripts during recording for real-time visibility
3. Combines transcripts with user notes in a Granola-style notepad interface
4. Generates structured summaries with decisions, action items, and technical context
5. Exports anywhere - local markdown, Google Drive, OneDrive, Dropbox
6. Works cross-platform - Windows, macOS, Linux with native performance

### 1.5 Target Users

| Segment | Description | Key Needs |
|---------|-------------|-----------|
| Primary | Software engineers, architects, tech leads | Code refs, decision logs, GitHub integration |
| Secondary | Product managers, engineering managers | Action items, stakeholder summaries, Confluence export |
| Tertiary | Students, researchers, consultants | Privacy, offline mode, flexible export |
| Enterprise | Teams with compliance requirements | On-prem transcription, audit trails, SSO (future) |

### 1.6 Competitive Positioning

| Feature | Granola | Otter | Fireflies | Voxii |
|---------|---------|-------|-----------|-------|
| Local transcription | No | No | No | Yes |
| Bring your own API | No | No | No | Yes |
| Live streaming transcript | Yes | Yes | Yes | Yes |
| Structured action items | Yes | Partial | Yes | Yes |
| Technical context (code, diagrams) | No | No | No | Planned |
| Cloud storage export | No | No | Partial | Yes |
| Cross-platform | macOS only | Web | Web | Yes |
| Open source | No | No | No | Yes |

---

## 2. Goals and Success Metrics

### 2.1 MVP Goals (Hackathon)

| Goal | Metric |
|------|--------|
| Working demo | End-to-end flow in <30 seconds |
| Live transcription | Text appears within 5s of speech |
| Clean output | Summary has clear sections and action items |
| Cross-platform | Builds run on Win/Mac/Linux |
| Video-ready | 60s demo without errors |

### 2.2 Post-MVP Goals

| Goal | Metric | Target |
|------|--------|--------|
| Daily active usage | Sessions per user per week | >= 5 |
| Export adoption | Percent of meetings exported | 60% |
| Accuracy | Action item correction rate | < 5% |
| Enterprise adoption | Teams using custom API endpoints | 10+ |
| Platform coverage | Active users by OS | 40% Win, 40% Mac, 20% Linux |

---

## 3. User Stories

### 3.1 Core Stories (MVP)

| ID | As a... | I want to... | So that... | Priority |
|----|---------|--------------|------------|----------|
| US-1 | Meeting participant | Record audio from my microphone | I capture discussions without manual notes | P0 |
| US-2 | Meeting participant | See live transcript while recording | I can verify capture in real time | P0 |
| US-3 | Meeting participant | Add my own notes alongside transcript | The summary includes my context | P0 |
| US-4 | Meeting participant | Get a structured summary | I have clear Decisions, Actions, Questions | P0 |
| US-5 | Meeting participant | Extract action items as a checklist | I can track follow-ups | P0 |
| US-6 | Meeting participant | Export as markdown | I can share via any tool | P0 |
| US-7 | Enterprise user | Use my own transcription API | I control data and costs | P0 |
| US-8 | Enterprise user | Export to cloud storage | Meeting notes are in our team drive | P1 |

### 3.2 Enhanced Stories (Post-MVP)

| ID | As a... | I want to... | So that... | Priority |
|----|---------|--------------|------------|----------|
| US-9 | User | Capture system audio (Zoom/Teams) | I transcribe meeting calls | P1 |
| US-10 | Tech lead | See architecture diagrams in notes | Complex flows are documented visually | P2 |
| US-11 | User | Search across all meetings | I find past discussions quickly | P2 |
| US-12 | User | Chat with my meeting history | I can ask questions about past decisions | P2 |
| US-13 | Enterprise user | Connect to Confluence/Notion | Notes sync to team wiki | P2 |
| US-14 | Enterprise user | Use SSO authentication | Our IT can manage access | P3 |

---

## 4. Functional Requirements

### 4.1 Transcription Engine

#### 4.1.1 Provider Abstraction

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| TR-1.1 | Support pluggable transcription providers | P0 |
| TR-1.2 | Implement local provider (whisper.cpp) | P0 |
| TR-1.3 | Implement OpenAI-compatible provider (any endpoint) | P0 |
| TR-1.4 | Auto-detect and select best available provider | P1 |
| TR-1.5 | Support provider fallback chain | P2 |
| TR-1.6 | Allow selecting local Whisper model from a folder | P1 |

#### 4.1.2 Streaming Transcription

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| TR-2.1 | Chunk audio into 5-10 second segments | P0 |
| TR-2.2 | Process chunks progressively during recording | P0 |
| TR-2.3 | Emit partial transcripts via events | P0 |
| TR-2.4 | Merge chunks into coherent full transcript | P0 |
| TR-2.5 | Support VAD to skip silent segments | P1 |
| TR-2.6 | Display real-time transcript in UI | P0 |

#### 4.1.3 Audio Capture

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| TR-3.1 | Capture microphone audio | P0 |
| TR-3.2 | Mix microphone and system audio | P1 |
| TR-3.3 | Show audio level indicator | P1 |
| TR-3.4 | Display recording timer | P1 |
| TR-3.5 | Save raw audio locally (optional) | P2 |

### 4.2 AI Processing (Copilot SDK)

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| AI-1.1 | Clean transcript (remove fillers, fix grammar) | P0 |
| AI-1.2 | Generate structured summary | P0 |
| AI-1.3 | Extract action items as structured JSON | P0 |
| AI-1.4 | Enhance selected text | P1 |
| AI-1.5 | Stream AI responses | P1 |
| AI-1.6 | Support model selection | P1 |
| AI-1.7 | Generate Mermaid diagrams for flows | P2 |

Action items use a structured JSON format (see [TECH_SPEC.md](TECH_SPEC.md)).

### 4.3 Sharing and Export

#### 4.3.1 Export Formats

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| EX-1.1 | Export as Markdown file | P0 |
| EX-1.2 | Copy to clipboard (Markdown) | P0 |
| EX-1.3 | Export as JSON (structured data) | P1 |
| EX-1.4 | Export as Slack blocks | P2 |
| EX-1.5 | Export action items as GitHub Issues | P2 |

#### 4.3.2 Cloud Storage Providers

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| EX-2.1 | Implement storage provider abstraction | P1 |
| EX-2.2 | Google Drive integration (OAuth2) | P1 |
| EX-2.3 | OneDrive integration (OAuth2) | P1 |
| EX-2.4 | Dropbox integration (OAuth2) | P2 |
| EX-2.5 | Secure token storage (OS keychain) | P1 |

### 4.4 User Interface

#### 4.4.1 Layout and Navigation

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| UI-1.1 | Meeting list sidebar | P0 |
| UI-1.2 | Meeting detail view | P0 |
| UI-1.3 | Recording overlay mode (compact) | P0 |
| UI-1.4 | Settings panel | P0 |
| UI-1.5 | Global keyboard shortcut | P1 |

#### 4.4.2 Recording Experience (Granola-style)

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| UI-2.1 | Floating notepad during recording | P0 |
| UI-2.2 | Live transcript preview (dancing bars) | P0 |
| UI-2.3 | Recording timer display | P1 |
| UI-2.4 | Audio level visualization | P1 |
| UI-2.5 | Quick stop button (prominent) | P0 |
| UI-2.6 | Model selector in recording controls | P1 |

#### 4.4.3 Post-Meeting View

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| UI-3.1 | Notes/Summary panel (left) | P0 |
| UI-3.2 | Transcript panel (right/collapsible) | P0 |
| UI-3.3 | Action items checklist | P0 |
| UI-3.4 | Enhance notes button | P0 |
| UI-3.5 | Share dropdown menu | P0 |
| UI-3.6 | Diff view (raw vs cleaned transcript) | P2 |

#### 4.4.4 Visual Design

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| UI-4.1 | Light/dark theme support | P1 |
| UI-4.2 | Consistent typography (Fraunces + Manrope) | P1 |
| UI-4.3 | Smooth panel transitions | P1 |
| UI-4.4 | Loading/processing indicators | P1 |
| UI-4.5 | App icon and branding | P1 |

### 4.5 Data and Storage

| Req ID | Requirement | Priority |
|--------|-------------|----------|
| ST-1.1 | Persist meetings as JSON | P0 |
| ST-1.2 | Store config in app data folder | P0 |
| ST-1.3 | Secure credential storage (keychain) | P1 |
| ST-1.4 | Meeting search and filter | P2 |
| ST-1.5 | Data export and backup | P2 |

---

## 5. Non-Functional Requirements

| Req ID | Requirement | Target |
|--------|-------------|--------|
| NFR-1 | Streaming transcript latency | <5s from speech |
| NFR-2 | Full transcript latency (batch) | <10s per minute of audio |
| NFR-3 | Summary generation latency | <5s for 10min meeting |
| NFR-4 | Local mode = zero network | Audio never leaves device |
| NFR-5 | Memory usage | <500MB during recording |
| NFR-6 | Cross-platform | Win 10+, macOS 12+, Ubuntu 22+ |
| NFR-7 | Accessibility | Keyboard navigable, screen reader compatible |

---

## 6. UI/UX Specifications

### 6.1 Screen States

#### State A: Recording Mode (Compact Overlay)
```
┌────────────────────────────────────────┐
│ ● REC  00:05:23         [■ Stop]      │
├────────────────────────────────────────┤
│ my notes here...                       │
│ - discuss API changes                  │
│ - review timeline                      │
├────────────────────────────────────────┤
│ ▃▅▂▇▄▁▃▅ Live transcript...           │
│ "...and we should probably look       │
│ at the authentication flow..."         │
└────────────────────────────────────────┘
```

#### State B: Post-Meeting View
```
┌──────┬────────────────────────────────────────────────────┐
│      │  Project Sync - Feb 4, 2026                        │
│ My   │  ┌─────────────────────────────────────────────────┤
│ Notes│  │ SUMMARY                                         │
│      │  │ Team discussed API migration timeline...        │
│ ────│  │                                                 │
│ Feb 4│  │ DECISIONS                                       │
│ Feb 3│  │ • Move to v2 API by March 1                     │
│ Feb 1│  │ • Keep backward compat for 90 days             │
│      │  │                                                 │
│      │  │ ACTION ITEMS                                    │
│      │  │ ☐ John: Update API docs by Feb 10              │
│      │  │ ☐ Sarah: Create migration guide                │
│      │  │                                                 │
│      │  │ [Share ▾] [Export MD] [Enhance Notes]          │
│      │  └─────────────────────────────────────────────────┤
└──────┴────────────────────────────────────────────────────┘
```

### 6.2 Component Hierarchy

```
App
├── Sidebar
│   ├── Logo
│   ├── MeetingList
│   │   └── MeetingItem (xN)
│   └── NewMeetingButton
├── MainContent
│   ├── MeetingHeader
│   │   ├── TitleInput
│   │   ├── DateBadge
│   │   └── StatusIndicator
│   ├── RecordBar (when recording)
│   │   ├── Timer
│   │   ├── AudioLevel
│   │   └── StopButton
│   ├── ContentPanels
│   │   ├── Scratchpad
│   │   ├── TranscriptPanel
│   │   ├── SummaryPanel
│   │   └── ActionsPanel
│   └── ActionBar
│       ├── ShareDropdown
│       └── ExportButton
├── RecordOverlay (compact mode)
├── SettingsDialog
└── DiagnosticsDrawer
```

---

## 7. Technical Reference

Detailed architecture, config schema, APIs, and prompt specs live in [TECH_SPEC.md](TECH_SPEC.md).

---

## 8. Security and Privacy

| Concern | Mitigation |
|---------|-----------|
| Audio data exposure | Local-first by default; cloud API is opt-in |
| API key storage | OS keychain (not plaintext config) |
| OAuth tokens | Stored in keychain with expiry |
| Meeting content | Never sent to telemetry; stays on device |
| Network requests | Explicit user consent before any cloud call |

---

## 9. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Whisper too slow on CPU | High | Medium | Default to base.en model; add GPU support later |
| Streaming chunks desync | Medium | Medium | Add sequence numbers, retry logic, overlap merge |
| OAuth flow complexity | Medium | High | Start with local-only export; add cloud later |
| Cross-platform audio issues | High | Medium | Test on all 3 OS early; document setup |
| Copilot rate limits | Medium | Low | Cache responses; debounce enhance requests |

---

## 10. Open Questions

1. Streaming with local Whisper: whisper.cpp does not natively support streaming. Options:
  - Process overlapping chunks and merge (current plan)
  - Use whisper.cpp server mode (if available)
  - Accept higher latency for local mode

2. OAuth2 token refresh: How to handle expired tokens gracefully?
  - Silent refresh with refresh_token
  - Prompt user to re-authenticate

3. Large meetings (>1 hour): Current chunk approach may accumulate errors.
  - Consider larger chunk sizes for long recordings
  - Add periodic sync points for correction

4. Multi-language support: Whisper supports many languages.
  - Add language selector in settings
  - Auto-detect based on first chunk

---

## 11. Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-05 | 2.2.0 | PRD cleaned to spec-only; technical details moved to TECH_SPEC |
| 2026-02-05 | 2.2.1 | Added local model selection and recording controls toggle requirements |
| 2026-02-04 | 2.0.0 | Complete rewrite for enterprise-ready architecture |
