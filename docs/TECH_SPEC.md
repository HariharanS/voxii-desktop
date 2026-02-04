# Voxii Desktop - Technical Specification

**Version:** 1.0  
**Date:** February 5, 2026  
**Status:** Draft

---

## 1. Architecture Overview

Voxii Desktop is a Tauri + React application with a Rust backend for audio capture, transcription, storage, and export. AI processing (summary, cleanup, actions, enhance) is executed via Copilot SDK scripts.

---

## 2. System Diagram (Logical)

```
+-----------------------------------------------------------------------+
|                           Voxii Desktop                               |
|                                                                       |
|  +------------------------+        +------------------------------+   |
|  |     React Frontend     |        |     Tauri Backend (Rust)     |   |
|  |  - Sidebar             |        |  - Audio capture             |   |
|  |  - Meeting view        | <----> |  - Transcription providers   |   |
|  |  - Settings            |  IPC   |  - Storage + export          |   |
|  +------------------------+        +------------------------------+   |
|                                                                       |
|  +---------------------------------------------------------------+    |
|  |                    Copilot SDK (Node scripts)                 |    |
|  |  - Summary  - Cleanup  - Actions  - Enhance                   |    |
|  +---------------------------------------------------------------+    |
|                                                                       |
+-----------------------------------------------------------------------+

External Dependencies:
+--------------+   +-------------+   +--------------------+
| whisper.cpp  |   | Copilot API |   | Cloud storage APIs  |
+--------------+   +-------------+   +--------------------+
```

---

## 3. Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | React 19 + TypeScript | Modern hooks, fast iteration |
| Desktop Runtime | Tauri 2.x | Lightweight, cross-platform, Rust security |
| Local STT | whisper.cpp | Fast native inference, no Python |
| Cloud STT | OpenAI-compatible API | Flexibility for any provider |
| AI Processing | GitHub Copilot SDK | Hackathon requirement, streaming |
| Audio | Web Audio API + MediaRecorder | Browser-native, cross-platform |
| Storage | JSON files + OS Keychain | Simple, secure secrets |
| Build | Vite 7 + Cargo | Fast dev, native compilation |

---

## 4. Data Flow: Live Transcription

```
+------------+   +-------------+   +-----------+   +-----------+
| Microphone |-> | AudioContext|-> | Chunker   |-> | Provider  |
|            |   | (16kHz WAV) |   | (5s chunks)|  | (Local/API)|
+------------+   +-------------+   +-----------+   +-----+-----+
                                                    |
                                                    v
+------------+   +-------------+   +-----------+   +-----------+
| UI Update  |<- | Tauri Event |<- | Merger    |<- | Partial   |
| (textarea) |   | (emit)      |   | (dedup)   |   | Transcript|
+------------+   +-------------+   +-----------+   +-----------+
```

---

## 5. Configuration Schema (Full)

```json
{
  "$schema": "https://voxii.app/config-schema.json",
  "version": 2,
  "transcription": {
    "provider": "local",
    "streaming": {
      "enabled": true,
      "chunkDurationMs": 5000,
      "overlapMs": 500
    },
    "local": {
      "whisperPath": "auto",
      "modelPath": "auto",
      "model": "medium.en",
      "beamSize": 5,
      "bestOf": 5
    },
    "openaiCompatible": {
      "endpoint": "https://api.openai.com/v1/audio/transcriptions",
      "apiKey": "${OPENAI_API_KEY}",
      "model": "whisper-1",
      "language": "en"
    }
  },
  "ai": {
    "defaultModel": "gpt-4.1",
    "summaryModel": "gpt-4.1",
    "cleanupModel": "gpt-4.1-mini"
  },
  "export": {
    "defaultFormat": "markdown",
    "defaultDestination": "local",
    "localPath": "~/Documents/Voxii",
    "includeTranscript": true,
    "includeActionItems": true
  },
  "ui": {
    "theme": "system",
    "compactMode": false,
    "showDiagnostics": false
  }
}
```

---

## 6. API Specifications

### 6.1 Tauri Commands

#### Transcription

```typescript
// Start streaming transcription session
#[tauri::command]
async fn start_streaming_session(
    app: AppHandle,
    config: TranscriptionConfig
) -> Result<String, String>  // Returns session_id

// Process audio chunk
#[tauri::command]
async fn transcribe_chunk(
    app: AppHandle,
    session_id: String,
    audio_base64: String,  // 16kHz mono WAV chunk
    chunk_index: u32
) -> Result<(), String>

// End streaming session
#[tauri::command]
async fn end_streaming_session(
    session_id: String
) -> Result<String, String>  // Returns merged transcript

// Events emitted:
// - "transcription-chunk" { sessionId, chunkIndex, text, isFinal }
// - "transcription-error" { sessionId, error }
```

#### Export

```typescript
#[tauri::command]
async fn export_meeting(
    meeting_id: String,
    format: ExportFormat,    // Markdown | JSON | Slack
    destination: Destination // Local | GDrive | OneDrive | Dropbox
) -> Result<String, String>  // Returns URL or path

#[tauri::command]
async fn connect_storage_provider(
    provider: StorageProvider
) -> Result<(), String>  // Initiates OAuth flow
```

### 6.2 Copilot SDK Scripts

#### copilot-actions.mjs

```javascript
// Input: transcript + notes
// Output: structured JSON

const prompt = `
Extract action items from this meeting transcript and notes.

Return ONLY valid JSON in this exact format:
{
  "items": [
    {
      "task": "Clear description of what needs to be done",
      "assignee": "Name if mentioned, otherwise null",
      "dueDate": "ISO date if mentioned, otherwise null",
      "priority": "high | medium | low",
      "context": "Brief quote or reference from transcript"
    }
  ]
}

Rules:
- Only include clear, actionable tasks
- Infer priority from language (urgent, ASAP = high; should, could = medium)
- Do not invent assignees or dates not mentioned
- Include 1-2 sentence context for each item

TRANSCRIPT:
${transcript}

USER NOTES:
${notes}
`;
```

---

## 7. Supported OpenAI-Compatible Endpoints

| Provider | Endpoint | Notes |
|----------|----------|-------|
| OpenAI | api.openai.com/v1/audio/transcriptions | Original API |
| Azure OpenAI | {resource}.openai.azure.com/... | Enterprise |
| Groq | api.groq.com/openai/v1/audio/transcriptions | Fast inference |
| Local (Ollama) | localhost:11434/v1/audio/transcriptions | Self-hosted |
| Faster Whisper Server | localhost:8000/v1/audio/transcriptions | Local with GPU |

---

## 8. Export Format Template (Markdown)

```markdown
# {title}
**Date:** {date}  
**Duration:** {duration}

## Summary
{summary}

## Decisions
{decisions}

## Action Items
{actions_checklist}

## Open Questions
{questions}

---
*Generated by Voxii*
```

---

## 9. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+Space | Toggle recording |
| Ctrl+S | Save meeting |
| Ctrl+E | Export markdown |
| Ctrl+Enter | Generate summary |
| Escape | Close overlay/dialog |
