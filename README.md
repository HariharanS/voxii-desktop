# Voxii Desktop

Voxii is a Tauri + React desktop app for capturing meeting audio, transcribing it locally with whisper.cpp, and generating concise meeting notes using the GitHub Copilot SDK. It keeps meeting history on-device and provides a fast workflow for live note taking, transcripts, and summaries.

## Features

- Record mic audio with optional system-audio capture.
- Offline transcription powered by whisper.cpp models.
- Scratch pad for agenda or prep notes.
- Streaming summary generation with the Copilot SDK.
- Enhance selected text in notes, transcript, or summary.
- Global hotkey (Ctrl + Shift + Space) to start/stop recording.
- Local meeting history stored in the app data directory.

## Requirements

- Node.js 18+ and npm
- Rust toolchain + Tauri prerequisites (see Tauri docs)
- `whisper.cpp` binary (or folder containing it)
- Whisper model file (e.g. `ggml-small.en.bin`)
- GitHub Copilot SDK authentication (see Copilot SDK docs)

## Configuration

On first launch, Voxii creates a config file in the Tauri app data directory:

- Windows: `%APPDATA%/voxii/config.json`
- macOS: `~/Library/Application Support/voxii/config.json`
- Linux: `~/.local/share/voxii/config.json`

Example config:

```json
{
  "whisperPath": "C:/tools/whisper.cpp/whisper-cli.exe",
  "modelPath": "C:/tools/whisper.cpp/models/ggml-small.en.bin",
  "language": "en",
  "includeSystemAudio": true,
  "defaultModel": "gpt-4.1"
}
```

## Development

```bash
npm install
npm run dev
```

To run the Tauri desktop shell:

```bash
npm run tauri dev
```

## Build

```bash
npm run build
```

## Usage Notes

- Click **Start listening** (or use the hotkey) to begin recording.
- Transcripts are appended to the current meeting.
- Use **Generate summary** to stream a Markdown summary into the Summary panel.
- Use **Enhance selection** to refine selected text with your chosen model.
