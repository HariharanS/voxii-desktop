use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::Instant,
};
use tauri::{Emitter, Manager, State};

// ============================================================================
// Types
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResponse {
    transcript: String,
    stdout: String,
    stderr: String,
    command: String,
    provider: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum TranscriptionProvider {
    #[default]
    Local,
    #[serde(rename = "openai-compatible")]
    OpenAICompatible,
    Auto,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct StreamingConfig {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_chunk_duration")]
    chunk_duration_ms: u32,
    #[serde(default = "default_overlap")]
    overlap_ms: u32,
}

fn default_true() -> bool { true }
fn default_chunk_duration() -> u32 { 5000 }
fn default_overlap() -> u32 { 500 }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct LocalTranscriptionConfig {
    #[serde(default)]
    whisper_path: String,
    #[serde(default)]
    model_path: String,
    #[serde(default)]
    model_name: String,
    #[serde(default = "default_beam_size")]
    beam_size: u32,
    #[serde(default = "default_best_of")]
    best_of: u32,
}

fn default_beam_size() -> u32 { 5 }
fn default_best_of() -> u32 { 5 }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct OpenAICompatibleConfig {
    #[serde(default = "default_openai_endpoint")]
    endpoint: String,
    #[serde(default)]
    api_key: String,
    #[serde(default = "default_whisper_model")]
    model: String,
}

fn default_openai_endpoint() -> String {
    "https://api.openai.com/v1/audio/transcriptions".to_string()
}
fn default_whisper_model() -> String { "whisper-1".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct TranscriptionConfig {
    #[serde(default)]
    provider: TranscriptionProvider,
    #[serde(default)]
    language: String,
    #[serde(default)]
    streaming: StreamingConfig,
    #[serde(default)]
    local: LocalTranscriptionConfig,
    #[serde(default, rename = "openaiCompatible")]
    openai_compatible: OpenAICompatibleConfig,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AIConfig {
    #[serde(default = "default_model")]
    default_model: String,
}

fn default_model() -> String { "gpt-4.1".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ExportConfig {
    #[serde(default = "default_format")]
    default_format: String,
    #[serde(default)]
    local_path: String,
}

fn default_format() -> String { "markdown".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct UIConfig {
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default)]
    show_diagnostics: bool,
    #[serde(default)]
    include_system_audio: bool,
}

fn default_theme() -> String { "system".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    transcription: TranscriptionConfig,
    #[serde(default)]
    ai: AIConfig,
    #[serde(default)]
    export: ExportConfig,
    #[serde(default)]
    ui: UIConfig,
    // Legacy fields for backward compatibility
    #[serde(default, skip_serializing)]
    whisper_path: String,
    #[serde(default, skip_serializing)]
    model_path: String,
    #[serde(default, skip_serializing)]
    language: String,
    #[serde(default, skip_serializing)]
    #[allow(dead_code)]
    include_system_audio: bool,
    #[serde(default, skip_serializing)]
    default_model: String,
}

fn default_version() -> u32 { 2 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 2,
            transcription: TranscriptionConfig::default(),
            ai: AIConfig::default(),
            export: ExportConfig::default(),
            ui: UIConfig::default(),
            whisper_path: String::new(),
            model_path: String::new(),
            language: String::new(),
            include_system_audio: true,
            default_model: String::new(),
        }
    }
}

impl AppConfig {
    /// Migrate from v1 config format to v2
    fn migrate_from_v1(&mut self) {
        if self.version < 2 {
            // Migrate legacy fields
            if !self.whisper_path.is_empty() {
                self.transcription.local.whisper_path = self.whisper_path.clone();
            }
            if !self.model_path.is_empty() {
                self.transcription.local.model_path = self.model_path.clone();
            }
            if !self.language.is_empty() {
                self.transcription.language = self.language.clone();
            }
            self.ui.include_system_audio = self.include_system_audio;
            if !self.default_model.is_empty() {
                self.ai.default_model = self.default_model.clone();
            }
            self.version = 2;
        }
    }

    /// Get effective whisper path (with legacy fallback)
    fn effective_whisper_path(&self) -> &str {
        if !self.transcription.local.whisper_path.is_empty() {
            &self.transcription.local.whisper_path
        } else {
            &self.whisper_path
        }
    }

    /// Get effective model path (with legacy fallback)
    fn effective_model_path(&self) -> &str {
        if !self.transcription.local.model_path.is_empty() {
            &self.transcription.local.model_path
        } else {
            &self.model_path
        }
    }

    /// Get effective language
    fn effective_language(&self) -> &str {
        if !self.transcription.language.is_empty() {
            &self.transcription.language
        } else if !self.language.is_empty() {
            &self.language
        } else {
            "en"
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActionItem {
    id: String,
    task: String,
    assignee: Option<String>,
    due_date: Option<String>,
    priority: String,
    status: String,
    context: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MeetingRecord {
    id: String,
    title: String,
    notes: String,
    transcript: String,
    summary: String,
    #[serde(default)]
    action_items: Vec<ActionItem>,
    created_at: String,
    updated_at: String,
}

// Streaming session state
struct StreamingSession {
    chunks: Vec<(u32, String)>, // (index, transcript)
    provider: TranscriptionProvider,
}

struct AppState {
    streaming_sessions: Mutex<HashMap<String, StreamingSession>>,
}

// ============================================================================
// Transcription Commands
// ============================================================================

#[tauri::command]
async fn transcribe_audio(
    app: tauri::AppHandle,
    audio_base64: String,
    language: Option<String>,
    provider_override: Option<String>,
) -> Result<TranscribeResponse, String> {
    let config = load_config(app.clone()).await?;
    
    // Determine which provider to use
    let provider = match provider_override.as_deref() {
        Some("local") => TranscriptionProvider::Local,
        Some("openai-compatible") => TranscriptionProvider::OpenAICompatible,
        Some("auto") | None => config.transcription.provider,
        Some(other) => return Err(format!("Unknown provider: {}", other)),
    };

    match provider {
        TranscriptionProvider::Local | TranscriptionProvider::Auto => {
            transcribe_local(config, audio_base64, language).await
        }
        TranscriptionProvider::OpenAICompatible => {
            transcribe_openai_compatible(config, audio_base64, language).await
        }
    }
}

async fn transcribe_local(
    config: AppConfig,
    audio_base64: String,
    language: Option<String>,
) -> Result<TranscribeResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let whisper_path = resolve_whisper_path(config.effective_whisper_path())?;
        let model_path = resolve_model_path_with_selection(
            config.effective_model_path(),
            &config.transcription.local.model_name,
        )?;

        let audio_bytes = base64::engine::general_purpose::STANDARD
            .decode(audio_base64)
            .map_err(|err| format!("Failed to decode audio: {err}"))?;

        let temp_dir = std::env::temp_dir().join("voxii");
        fs::create_dir_all(&temp_dir)
            .map_err(|err| format!("Failed to create temp dir: {err}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        let wav_path = temp_dir.join(format!("{id}.wav"));
        let out_base = temp_dir.join(format!("{id}_out"));

        fs::write(&wav_path, audio_bytes)
            .map_err(|err| format!("Failed to write audio file: {err}"))?;

        let mut cmd = Command::new(&whisper_path);
        cmd.arg("-m")
            .arg(&model_path)
            .arg("-f")
            .arg(&wav_path)
            .arg("-otxt")
            .arg("-of")
            .arg(&out_base)
            .arg("--best-of")
            .arg(config.transcription.local.best_of.to_string())
            .arg("--beam-size")
            .arg(config.transcription.local.beam_size.to_string());

        let language = language.unwrap_or_else(|| config.effective_language().to_string());
        if !language.trim().is_empty() {
            cmd.arg("-l").arg(language.trim());
        }

        let command_string = format!(
            "\"{}\" -m \"{}\" -f \"{}\" -otxt -of \"{}\"",
            whisper_path.display(),
            model_path.display(),
            wav_path.display(),
            out_base.display()
        );

        let output = cmd
            .output()
            .map_err(|err| format!("Failed to run whisper: {err}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            return Err(format!(
                "Whisper failed (code {}).\nCommand: {}\nstdout: {}\nstderr: {}",
                output.status.code().unwrap_or(-1),
                command_string,
                stdout,
                stderr
            ));
        }

        let transcript_path = out_base.with_extension("txt");
        let transcript = fs::read_to_string(&transcript_path)
            .map_err(|err| format!("Failed to read transcript: {err}"))?;

        Ok(TranscribeResponse {
            transcript,
            stdout,
            stderr,
            command: command_string,
            provider: "local".to_string(),
        })
    })
    .await
    .map_err(|err| format!("Failed to run transcription task: {err}"))?
}

async fn transcribe_openai_compatible(
    config: AppConfig,
    audio_base64: String,
    language: Option<String>,
) -> Result<TranscribeResponse, String> {
    let openai_config = &config.transcription.openai_compatible;
    
    if openai_config.api_key.is_empty() {
        return Err("OpenAI-compatible API key not configured".to_string());
    }
    if openai_config.endpoint.is_empty() {
        return Err("OpenAI-compatible endpoint not configured".to_string());
    }

    // Decode audio
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|err| format!("Failed to decode audio: {err}"))?;

    // Build multipart form
    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|err| format!("Failed to create multipart: {err}"))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", openai_config.model.clone());

    let language = language.unwrap_or_else(|| config.effective_language().to_string());
    if !language.trim().is_empty() {
        form = form.text("language", language);
    }

    // Make request
    let client = reqwest::Client::new();
    let response = client
        .post(&openai_config.endpoint)
        .header("Authorization", format!("Bearer {}", openai_config.api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("Failed to call transcription API: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Transcription API failed ({}): {}",
            status, body
        ));
    }

    // Parse response - OpenAI returns { "text": "..." }
    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|err| format!("Failed to parse API response: {err}"))?;

    let transcript = result
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(TranscribeResponse {
        transcript,
        stdout: String::new(),
        stderr: String::new(),
        command: format!("POST {}", openai_config.endpoint),
        provider: "openai-compatible".to_string(),
    })
}

// ============================================================================
// Streaming Transcription Commands
// ============================================================================

#[tauri::command]
async fn start_streaming_session(
    state: State<'_, AppState>,
    provider: Option<String>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let provider_enum = match provider.as_deref() {
        Some("local") => TranscriptionProvider::Local,
        Some("openai-compatible") => TranscriptionProvider::OpenAICompatible,
        _ => TranscriptionProvider::Local, // Default to local for streaming
    };

    let session = StreamingSession {
        chunks: Vec::new(),
        provider: provider_enum,
    };

    state
        .streaming_sessions
        .lock()
        .map_err(|_| "Failed to acquire lock")?
        .insert(session_id.clone(), session);

    Ok(session_id)
}

#[tauri::command]
async fn transcribe_chunk(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    audio_base64: String,
    chunk_index: u32,
) -> Result<(), String> {
    let config = load_config(app.clone()).await?;
    
    // Get provider from session
    let provider = {
        let sessions = state.streaming_sessions.lock().map_err(|_| "Lock failed")?;
        sessions
            .get(&session_id)
            .map(|s| s.provider)
            .ok_or("Session not found")?
    };

    // Transcribe the chunk
    let result = match provider {
        TranscriptionProvider::Local | TranscriptionProvider::Auto => {
            transcribe_local(config, audio_base64, None).await
        }
        TranscriptionProvider::OpenAICompatible => {
            transcribe_openai_compatible(config, audio_base64, None).await
        }
    };

    match result {
        Ok(response) => {
            // Store chunk result
            {
                let mut sessions = state.streaming_sessions.lock().map_err(|_| "Lock failed")?;
                if let Some(session) = sessions.get_mut(&session_id) {
                    session.chunks.push((chunk_index, response.transcript.clone()));
                }
            }

            // Emit event to frontend
            let _ = app.emit(
                "transcription-chunk",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkIndex": chunk_index,
                    "text": response.transcript,
                    "provider": response.provider,
                }),
            );
        }
        Err(err) => {
            let _ = app.emit(
                "transcription-error",
                serde_json::json!({
                    "sessionId": session_id,
                    "chunkIndex": chunk_index,
                    "error": err,
                }),
            );
            return Err(err);
        }
    }

    Ok(())
}

#[tauri::command]
async fn end_streaming_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let session = state
        .streaming_sessions
        .lock()
        .map_err(|_| "Failed to acquire lock")?
        .remove(&session_id)
        .ok_or("Session not found")?;

    // Sort chunks by index and merge
    let mut chunks = session.chunks;
    chunks.sort_by_key(|(idx, _)| *idx);

    let merged = chunks
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join(" ");

    Ok(merged)
}

#[allow(dead_code)]
fn get_transcription_config(config: &AppConfig) -> serde_json::Value {
    serde_json::json!({
        "provider": config.transcription.provider,
        "streaming": {
            "enabled": config.transcription.streaming.enabled,
            "chunkDurationMs": config.transcription.streaming.chunk_duration_ms,
            "overlapMs": config.transcription.streaming.overlap_ms,
        },
        "localConfigured": !config.effective_whisper_path().is_empty() 
            && !config.effective_model_path().is_empty(),
        "openaiConfigured": !config.transcription.openai_compatible.api_key.is_empty(),
    })
}

#[tauri::command]
fn diagnose_whisper(whisper_path: String) -> Result<String, String> {
    let resolved = resolve_whisper_path(&whisper_path)?;

    let output = Command::new(&resolved)
        .arg("-h")
        .output()
        .map_err(|err| format!("Failed to run whisper diagnostics: {err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    Ok(format!(
        "Resolved binary: {}\nExit code: {}\nstdout:\n{}\nstderr:\n{}",
        resolved.display(),
        output.status.code().unwrap_or(-1),
        stdout,
        stderr
    ))
}

#[tauri::command]
fn generate_summary(
    transcript: String,
    notes: String,
    model: Option<String>,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_summary.json"));

    let payload = serde_json::json!({
        "transcript": transcript,
        "notes": notes,
        "sections": ["Agenda", "Summary", "Decisions", "Risks", "Actions"],
        "model": model.unwrap_or_else(|| "gpt-4.1".to_string())
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write summary payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-summary.mjs");

    if !script_path.exists() {
        return Err(format!("Copilot summary script not found: {}", script_path.display()));
    }

    let output = Command::new("node")
        .arg(script_path)
        .arg(&input_path)
        .output()
        .map_err(|err| format!("Failed to run Copilot SDK: {err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "Copilot SDK failed (code {}).\nstdout: {}\nstderr: {}",
            output.status.code().unwrap_or(-1),
            stdout,
            stderr
        ));
    }

    let mut final_summary: Option<String> = None;
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if value.get("type").and_then(|v| v.as_str()) == Some("final") {
                if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                    final_summary = Some(content.to_string());
                }
            }
        }
    }

    Ok(final_summary.unwrap_or_else(|| stdout.trim().to_string()))
}

#[tauri::command]
fn start_summary_stream(
    app: tauri::AppHandle,
    meeting_id: String,
    transcript: String,
    notes: String,
    model: String,
) -> Result<(), String> {
    let start = Instant::now();
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_summary.json"));

    let payload = serde_json::json!({
        "transcript": transcript,
        "notes": notes,
        "sections": ["Agenda", "Summary", "Decisions", "Risks", "Actions"],
        "model": model
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write summary payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-summary.mjs");

    if !script_path.exists() {
        return Err(format!("Copilot summary script not found: {}", script_path.display()));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(
            "summary-log",
            format!("Rust: starting summary process ({}ms)", start.elapsed().as_millis()),
        );
        let mut child = match Command::new("node")
            .env("STREAMING", "1")
            .arg(script_path)
            .arg(&input_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let _ = app.emit(
                    "summary-error",
                    format!("Failed to start Copilot SDK: {err}"),
                );
                return;
            }
        };

        if let Some(stderr) = child.stderr.take() {
            let app_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    let _ = app_handle.emit("summary-log", line);
                }
            });
        }

        let mut final_summary: Option<String> = None;
        let mut first_delta_emitted = false;

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim_end().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed) {
                    if !first_delta_emitted {
                        first_delta_emitted = true;
                        let _ = app.emit(
                            "summary-log",
                            format!(
                                "Rust: first stdout event at {}ms",
                                start.elapsed().as_millis()
                            ),
                        );
                    }
                    if value.get("type").and_then(|v| v.as_str()) == Some("final") {
                        if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                            final_summary = Some(content.to_string());
                        }
                    }

                    let payload = serde_json::json!({
                        "meetingId": meeting_id,
                        "event": value
                    });
                    let _ = app.emit("summary-delta", payload);
                } else {
                    let _ = app.emit("summary-log", trimmed);
                }
            }
        }

        let output = child.wait_with_output();
        if let Ok(output) = output {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let _ = app.emit(
                    "summary-error",
                    format!("Copilot SDK failed: {stderr}"),
                );
            }
        }

        let _ = app.emit(
            "summary-done",
            serde_json::json!({
                "meetingId": meeting_id,
                "summary": final_summary
            }),
        );
        let _ = app.emit(
            "summary-log",
            format!("Rust: summary done at {}ms", start.elapsed().as_millis()),
        );
    });

    Ok(())
}

#[tauri::command]
async fn list_models() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join("copilot-models.mjs");

        if !script_path.exists() {
            return Err(format!("Models script not found: {}", script_path.display()));
        }

        let output = Command::new("node")
            .arg(script_path)
            .output()
            .map_err(|err| format!("Failed to run models script: {err}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Model list failed: {stderr}\n{stdout}"));
        }

        let models = serde_json::from_str::<Vec<serde_json::Value>>(stdout.trim())
            .map_err(|err| format!("Failed to parse models list: {err}"))?;
        Ok(models)
    })
    .await
    .map_err(|err| format!("Failed to run model list task: {err}"))?
}

#[tauri::command]
async fn list_local_models(model_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = model_dir.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let path = Path::new(trimmed);
        if path.is_file() {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            return Ok(if name.is_empty() { Vec::new() } else { vec![name] });
        }

        if !path.is_dir() {
            return Ok(Vec::new());
        }

        let mut names = Vec::new();
        for entry in fs::read_dir(path)
            .map_err(|err| format!("Failed to read model dir: {err}"))? {
            let entry = entry.map_err(|err| format!("Failed to read model dir: {err}"))?;
            let entry_path = entry.path();
            if entry_path.extension().and_then(|ext| ext.to_str()) == Some("bin") {
                if let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) {
                    names.push(name.to_string());
                }
            }
        }

        names.sort();
        Ok(names)
    })
    .await
    .map_err(|err| format!("Failed to list local models task: {err}"))?
}

#[tauri::command]
fn enhance_text(text: String, model: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_enhance.json"));

    let payload = serde_json::json!({
        "text": text,
        "model": model
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write enhance payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-enhance.mjs");

    if !script_path.exists() {
        return Err(format!("Enhance script not found: {}", script_path.display()));
    }

    let output = Command::new("node")
        .arg(script_path)
        .arg(&input_path)
        .output()
        .map_err(|err| format!("Failed to run Copilot SDK: {err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "Copilot SDK failed (code {}).\nstdout: {}\nstderr: {}",
            output.status.code().unwrap_or(-1),
            stdout,
            stderr
        ));
    }

    Ok(stdout.trim().to_string())
}

#[tauri::command]
fn start_enhance_stream(
    app: tauri::AppHandle,
    meeting_id: String,
    selection_id: String,
    text: String,
    model: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_enhance.json"));

    let payload = serde_json::json!({
        "text": text,
        "model": model
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write enhance payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-enhance.mjs");

    if !script_path.exists() {
        return Err(format!("Enhance script not found: {}", script_path.display()));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = match Command::new("node")
            .env("STREAMING", "1")
            .arg(script_path)
            .arg(&input_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let _ = app.emit(
                    "enhance-error",
                    format!("Failed to start Copilot SDK: {err}"),
                );
                return;
            }
        };

        if let Some(stderr) = child.stderr.take() {
            let app_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    let _ = app_handle.emit("summary-log", line);
                }
            });
        }

        let mut final_text: Option<String> = None;

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim_end().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed) {
                    if value.get("type").and_then(|v| v.as_str()) == Some("final") {
                        if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                            final_text = Some(content.to_string());
                        }
                    }

                    let payload = serde_json::json!({
                        "meetingId": meeting_id,
                        "selectionId": selection_id,
                        "event": value
                    });
                    let _ = app.emit("enhance-delta", payload);
                } else {
                    let _ = app.emit("summary-log", trimmed);
                }
            }
        }

        let output = child.wait_with_output();
        if let Ok(output) = output {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let _ = app.emit(
                    "enhance-error",
                    format!("Copilot SDK failed: {stderr}"),
                );
            }
        }

        let _ = app.emit(
            "enhance-done",
            serde_json::json!({
                "meetingId": meeting_id,
                "selectionId": selection_id,
                "text": final_text
            }),
        );
    });

    Ok(())
}

#[tauri::command]
fn clean_transcript(text: String, model: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_clean_transcript.json"));

    let payload = serde_json::json!({
        "text": text,
        "model": model
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write transcript payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-clean-transcript.mjs");

    if !script_path.exists() {
        return Err(format!(
            "Clean transcript script not found: {}",
            script_path.display()
        ));
    }

    let output = Command::new("node")
        .arg(script_path)
        .arg(&input_path)
        .output()
        .map_err(|err| format!("Failed to run Copilot SDK: {err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "Copilot SDK failed (code {}).\nstdout: {}\nstderr: {}",
            output.status.code().unwrap_or(-1),
            stdout,
            stderr
        ));
    }

    Ok(stdout.trim().to_string())
}

#[tauri::command]
fn start_clean_transcript_stream(
    app: tauri::AppHandle,
    meeting_id: String,
    text: String,
    model: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_clean_transcript.json"));

    let payload = serde_json::json!({
        "text": text,
        "model": model
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write transcript payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-clean-transcript.mjs");

    if !script_path.exists() {
        return Err(format!(
            "Clean transcript script not found: {}",
            script_path.display()
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = match Command::new("node")
            .env("STREAMING", "1")
            .arg(script_path)
            .arg(&input_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let _ = app.emit(
                    "clean-transcript-error",
                    format!("Failed to start Copilot SDK: {err}"),
                );
                return;
            }
        };

        if let Some(stderr) = child.stderr.take() {
            let app_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    let _ = app_handle.emit("summary-log", line);
                }
            });
        }

        let mut final_text: Option<String> = None;

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let trimmed = line.trim_end().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed) {
                    if value.get("type").and_then(|v| v.as_str()) == Some("final") {
                        if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                            final_text = Some(content.to_string());
                        }
                    }

                    let payload = serde_json::json!({
                        "meetingId": meeting_id,
                        "event": value
                    });
                    let _ = app.emit("clean-transcript-delta", payload);
                } else {
                    let _ = app.emit("summary-log", trimmed);
                }
            }
        }

        let output = child.wait_with_output();
        if let Ok(output) = output {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let _ = app.emit(
                    "clean-transcript-error",
                    format!("Copilot SDK failed: {stderr}"),
                );
            }
        }

        let _ = app.emit(
            "clean-transcript-done",
            serde_json::json!({
                "meetingId": meeting_id,
                "text": final_text
            }),
        );
    });

    Ok(())
}

#[tauri::command]
async fn load_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_path(&app)?;
        if !path.exists() {
            let default_config = AppConfig::default();
            save_config(&path, &default_config)?;
            return Ok(default_config);
        }

        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read config: {err}"))?;
        let mut config = serde_json::from_str::<AppConfig>(&raw)
            .map_err(|err| format!("Failed to parse config: {err}"))?;
        
        // Migrate from v1 if needed
        if config.version < 2 {
            config.migrate_from_v1();
            // Save migrated config
            let _ = save_config(&path, &config);
        }
        
        Ok(config)
    })
    .await
    .map_err(|err| format!("Failed to load config task: {err}"))?
}

#[tauri::command]
async fn save_config_command(
    app: tauri::AppHandle,
    config: AppConfig,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = config_path(&app)?;
        save_config(&path, &config)
    })
    .await
    .map_err(|err| format!("Failed to save config task: {err}"))?
}

#[tauri::command]
async fn load_meetings(app: tauri::AppHandle) -> Result<Vec<MeetingRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = meetings_path(&app)?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read meetings: {err}"))?;
        let meetings = serde_json::from_str::<Vec<MeetingRecord>>(&raw)
            .map_err(|err| format!("Failed to parse meetings: {err}"))?;
        Ok(meetings)
    })
    .await
    .map_err(|err| format!("Failed to load meetings task: {err}"))?
}

#[tauri::command]
async fn save_meetings(
    app: tauri::AppHandle,
    meetings: Vec<MeetingRecord>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = meetings_path(&app)?;
        let payload = serde_json::to_string_pretty(&meetings)
            .map_err(|err| format!("Failed to serialize meetings: {err}"))?;
        fs::write(path, payload)
            .map_err(|err| format!("Failed to save meetings: {err}"))?;
        Ok(())
    })
    .await
    .map_err(|err| format!("Failed to save meetings task: {err}"))?
}

fn resolve_whisper_path(input: &str) -> Result<PathBuf, String> {
    if input.is_empty() {
        return Err("Whisper path not configured".to_string());
    }
    
    let path = Path::new(input);
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if path.is_dir() {
        // Cross-platform binary candidates
        #[cfg(target_os = "windows")]
        let candidates = [
            "whisper-cli.exe",
            "main.exe",
            "whisper.exe",
        ];
        #[cfg(target_os = "macos")]
        let candidates = [
            "whisper-cli",
            "whisper",
            "main",
        ];
        #[cfg(target_os = "linux")]
        let candidates = [
            "whisper-cli",
            "whisper",
            "main",
        ];
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        let candidates = [
            "whisper-cli",
            "whisper",
            "main",
        ];
        
        for name in candidates {
            let candidate = path.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "Whisper binary not found. Provide the whisper binary path or folder containing it. Got: {}",
        input
    ))
}

fn resolve_model_path_with_selection(
    base_path: &str,
    selection: &str,
) -> Result<PathBuf, String> {
    let base_trimmed = base_path.trim();
    if base_trimmed.is_empty() {
        return Err("Model path not configured".to_string());
    }

    let selection_trimmed = selection.trim();
    if !selection_trimmed.is_empty() {
        let selection_path = Path::new(selection_trimmed);
        if selection_path.is_file() {
            return Ok(selection_path.to_path_buf());
        }
    }

    let base = Path::new(base_trimmed);
    if !selection_trimmed.is_empty() && base.is_dir() {
        let candidate = base.join(selection_trimmed);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!(
            "Selected model not found: {}",
            candidate.display()
        ));
    }

    resolve_model_path(base_trimmed)
}

fn resolve_model_path(input: &str) -> Result<PathBuf, String> {
    let path = Path::new(input);
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    // When given a directory, prefer a sensible default model if present.
    // This keeps startup simple (point to the models folder) while allowing
    // better tradeoffs than always picking the largest file.
    let preferred_names = [
        "ggml-medium.en-q8_0.bin",
        "ggml-medium.en.bin",
        "ggml-medium.en-q5_0.bin",
        "ggml-medium-q8_0.bin",
        "ggml-medium.bin",
        "ggml-small.en-q8_0.bin",
        "ggml-small.en.bin",
        "ggml-base.en.bin",
    ];

    let search_dirs = if path.is_dir() {
        vec![path.to_path_buf(), path.join("models")]
    } else {
        vec![]
    };

    let mut candidates: Vec<(PathBuf, u64, String)> = Vec::new();
    for dir in search_dirs {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.extension().map(|e| e == "bin").unwrap_or(false) {
                    continue;
                }
                let size = match p.metadata() {
                    Ok(meta) => meta.len(),
                    Err(_) => continue,
                };
                let file_name = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                candidates.push((p, size, file_name));
            }
        }
    }

    for preferred in preferred_names {
        let preferred = preferred.to_ascii_lowercase();
        if let Some((p, _, _)) = candidates.iter().find(|(_, _, name)| *name == preferred) {
            return Ok(p.to_path_buf());
        }
    }

    // Fallback: pick the largest .bin in the folder.
    if let Some((p, _, _)) = candidates.into_iter().max_by_key(|(_, size, _)| *size) {
        return Ok(p);
    }

    Err(format!(
        "Model not found. Provide a .bin file or a folder containing ggml-*.bin models. Got: {}",
        input
    ))
}

// ============================================================================
// Action Items Extraction
// ============================================================================

#[tauri::command]
fn extract_action_items(
    app: tauri::AppHandle,
    meeting_id: String,
    transcript: String,
    notes: String,
    model: String,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("voxii");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{id}_actions.json"));

    let payload = serde_json::json!({
        "transcript": transcript,
        "notes": notes,
        "model": model
    });

    fs::write(&input_path, payload.to_string())
        .map_err(|err| format!("Failed to write actions payload: {err}"))?;

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("copilot-actions.mjs");

    if !script_path.exists() {
        return Err(format!(
            "Actions script not found: {}",
            script_path.display()
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let output = match Command::new("node")
            .arg(&script_path)
            .arg(&input_path)
            .output()
        {
            Ok(output) => output,
            Err(err) => {
                let _ = app.emit(
                    "actions-error",
                    serde_json::json!({
                        "meetingId": meeting_id,
                        "error": format!("Failed to run actions script: {err}")
                    }),
                );
                return;
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = app.emit(
                "actions-error",
                serde_json::json!({
                    "meetingId": meeting_id,
                    "error": format!("Actions extraction failed: {stderr}")
                }),
            );
            return;
        }

        // Parse the JSON output
        match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
            Ok(result) => {
                let _ = app.emit(
                    "actions-done",
                    serde_json::json!({
                        "meetingId": meeting_id,
                        "actions": result
                    }),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "actions-error",
                    serde_json::json!({
                        "meetingId": meeting_id,
                        "error": format!("Failed to parse actions: {err}")
                    }),
                );
            }
        }
    });

    Ok(())
}

// ============================================================================
// Export
// ============================================================================

#[tauri::command]
async fn export_meeting_markdown(
    app: tauri::AppHandle,
    meeting: MeetingRecord,
    include_transcript: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut md = String::new();
        
        // Header
        md.push_str(&format!("# {}\n\n", meeting.title));
        md.push_str(&format!("**Date:** {}  \n", meeting.created_at));
        md.push_str(&format!("**Last Updated:** {}\n\n", meeting.updated_at));
        
        // Summary
        if !meeting.summary.is_empty() {
            md.push_str("---\n\n");
            md.push_str(&meeting.summary);
            md.push_str("\n\n");
        }
        
        // Action Items
        if !meeting.action_items.is_empty() {
            md.push_str("## Action Items\n\n");
            for item in &meeting.action_items {
                let checkbox = if item.status == "completed" { "[x]" } else { "[ ]" };
                let assignee = item.assignee.as_deref().unwrap_or("Unassigned");
                let due = item.due_date.as_deref().map(|d| format!(" (due: {})", d)).unwrap_or_default();
                md.push_str(&format!("- {} **{}**: {}{}\n", checkbox, assignee, item.task, due));
            }
            md.push_str("\n");
        }
        
        // Notes
        if !meeting.notes.is_empty() {
            md.push_str("## Notes\n\n");
            md.push_str(&meeting.notes);
            md.push_str("\n\n");
        }
        
        // Transcript (optional)
        if include_transcript && !meeting.transcript.is_empty() {
            md.push_str("## Transcript\n\n");
            md.push_str("<details>\n<summary>Click to expand transcript</summary>\n\n");
            md.push_str(&meeting.transcript);
            md.push_str("\n\n</details>\n\n");
        }
        
        // Footer
        md.push_str("---\n*Generated by Voxii*\n");
        
        // Save to file
        let config = load_config_sync(&app)?;
        let export_path = if config.export.local_path.is_empty() {
            dirs::document_dir()
                .unwrap_or_else(|| std::env::temp_dir())
                .join("Voxii")
        } else {
            PathBuf::from(&config.export.local_path)
        };
        
        fs::create_dir_all(&export_path)
            .map_err(|err| format!("Failed to create export directory: {err}"))?;
        
        // Sanitize filename
        let safe_title: String = meeting.title
            .chars()
            .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
            .collect();
        let filename = format!("{} - {}.md", 
            meeting.created_at.split('T').next().unwrap_or("unknown"),
            safe_title.trim()
        );
        let file_path = export_path.join(&filename);
        
        fs::write(&file_path, &md)
            .map_err(|err| format!("Failed to write export file: {err}"))?;
        
        Ok(file_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| format!("Failed to export: {err}"))?
}

fn load_config_sync(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read config: {err}"))?;
    let config = serde_json::from_str::<AppConfig>(&raw)
        .map_err(|err| format!("Failed to parse config: {err}"))?;
    Ok(config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            streaming_sessions: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            transcribe_audio,
            diagnose_whisper,
            generate_summary,
            start_summary_stream,
            list_models,
            list_local_models,
            enhance_text,
            start_enhance_stream,
            clean_transcript,
            start_clean_transcript_stream,
            load_config,
            save_config_command,
            load_meetings,
            save_meetings,
            start_streaming_session,
            transcribe_chunk,
            end_streaming_session,
            extract_action_items,
            export_meeting_markdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?
        .join("voxii");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create app data dir: {err}"))?;
    Ok(dir.join("config.json"))
}

fn meetings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?
        .join("voxii");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create app data dir: {err}"))?;
    Ok(dir.join("meetings.json"))
}

fn save_config(path: &Path, config: &AppConfig) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(config)
        .map_err(|err| format!("Failed to serialize config: {err}"))?;
    fs::write(path, payload).map_err(|err| format!("Failed to save config: {err}"))?;
    Ok(())
}
