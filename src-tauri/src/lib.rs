use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResponse {
    transcript: String,
    stdout: String,
    stderr: String,
    command: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    whisper_path: String,
    model_path: String,
    language: String,
    include_system_audio: bool,
    default_model: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MeetingRecord {
    id: String,
    title: String,
    notes: String,
    transcript: String,
    summary: String,
    created_at: String,
    updated_at: String,
}

#[tauri::command]
async fn transcribe_audio(
    app: tauri::AppHandle,
    audio_base64: String,
    language: Option<String>,
) -> Result<TranscribeResponse, String> {
    let config = load_config(app.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let whisper_path = resolve_whisper_path(&config.whisper_path)?;
        let model_path = resolve_model_path(&config.model_path)?;

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
            .arg("5")
            .arg("--beam-size")
            .arg("5");

        let language = language.unwrap_or_else(|| config.language);
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
        })
    })
    .await
    .map_err(|err| format!("Failed to run transcription task: {err}"))?
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
            let default_config = AppConfig {
                whisper_path: String::new(),
                model_path: String::new(),
                language: "en".to_string(),
                include_system_audio: true,
                default_model: "gpt-4.1".to_string(),
            };
            save_config(&path, &default_config)?;
            return Ok(default_config);
        }

        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read config: {err}"))?;
        let config = serde_json::from_str::<AppConfig>(&raw)
            .map_err(|err| format!("Failed to parse config: {err}"))?;
        Ok(config)
    })
    .await
    .map_err(|err| format!("Failed to load config task: {err}"))?
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
    let path = Path::new(input);
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if path.is_dir() {
        let candidates = [
            "whisper-cli.exe",
            "main.exe",
            "whisper.exe",
        ];
        for name in candidates {
            let candidate = path.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "Whisper binary not found. Provide whisper-cli.exe (or main.exe) path or the folder containing it. Got: {}",
        input
    ))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            transcribe_audio,
            diagnose_whisper,
            generate_summary,
            start_summary_stream,
            list_models,
            enhance_text,
            start_enhance_stream,
            clean_transcript,
            start_clean_transcript_stream,
            load_config,
            load_meetings,
            save_meetings
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
