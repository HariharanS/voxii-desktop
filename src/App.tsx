import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

type RecorderHandle = {
  stop: () => Promise<Blob>;
};

type TranscribeResponse = {
  transcript: string;
  stdout: string;
  stderr: string;
  command: string;
};

type AppConfig = {
  whisperPath: string;
  modelPath: string;
  language: string;
  includeSystemAudio: boolean;
  defaultModel: string;
};

type MeetingRecord = {
  id: string;
  title: string;
  notes: string;
  transcript: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

type SelectionState = {
  field: "notes" | "summary" | "transcript" | null;
  start: number;
  end: number;
};

async function startRecorder(includeSystemAudio: boolean): Promise<RecorderHandle> {
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

  let systemStream: MediaStream | null = null;
  if (includeSystemAudio) {
    systemStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    for (const track of systemStream.getVideoTracks()) {
      track.stop();
    }
  }

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  const micSource = audioContext.createMediaStreamSource(micStream);
  const micGain = audioContext.createGain();
  micGain.gain.value = 1.0;
  micSource.connect(micGain).connect(destination);

  if (systemStream) {
    const systemSource = audioContext.createMediaStreamSource(systemStream);
    const systemGain = audioContext.createGain();
    systemGain.gain.value = 1.0;
    systemSource.connect(systemGain).connect(destination);
  }

  const mediaRecorder = new MediaRecorder(destination.stream, {
    mimeType: "audio/webm",
  });

  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  mediaRecorder.start();

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          micStream.getTracks().forEach((track) => track.stop());
          systemStream?.getTracks().forEach((track) => track.stop());
          audioContext.close();
          resolve(blob);
        };
        mediaRecorder.stop();
      }),
  };
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);

  const targetSampleRate = 16000;
  const frameCount = Math.round(
    (decodedBuffer.duration * targetSampleRate) | 0
  );
  const offline = new OfflineAudioContext(1, frameCount, targetSampleRate);
  const source = offline.createBufferSource();
  source.buffer = decodedBuffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  await audioContext.close();

  const wavBuffer = audioBufferToWav(rendered);
  return uint8ToBase64(new Uint8Array(wavBuffer));
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  let offset = 0;
  const writeString = (value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset, value.charCodeAt(i));
      offset += 1;
    }
  };

  writeString("RIFF");
  view.setUint32(offset, 36 + dataSize, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, numChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, dataSize, true);
  offset += 4;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return arrayBuffer;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gpt-4.1");
  const [status, setStatus] = useState("Idle");
  const [isRecording, setIsRecording] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [selection, setSelection] = useState<SelectionState>({
    field: null,
    start: 0,
    end: 0,
  });

  const recorderRef = useRef<RecorderHandle | null>(null);
  const activeMeetingRef = useRef<string | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const summaryRef = useRef<HTMLTextAreaElement | null>(null);

  const activeMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === activeMeetingId) || null,
    [meetings, activeMeetingId]
  );

  useEffect(() => {
    activeMeetingRef.current = activeMeetingId;
  }, [activeMeetingId]);

  useEffect(() => {
    void invoke<AppConfig>("load_config")
      .then((data) => {
        setConfig(data);
        setSelectedModel(data.defaultModel || "gpt-4.1");
      })
      .catch((error) => {
        appendLog(String(error));
      });

    void invoke<MeetingRecord[]>("load_meetings")
      .then((data) => {
        if (data.length === 0) {
          const fresh = createMeeting();
          setMeetings([fresh]);
          setActiveMeetingId(fresh.id);
          return;
        }
        setMeetings(data);
        setActiveMeetingId(data[0]?.id ?? null);
      })
      .catch((error) => appendLog(String(error)));
  }, []);

  useEffect(() => {
    if (!meetings.length) return;
    const timeout = window.setTimeout(() => {
      void invoke("save_meetings", { meetings }).catch((error) =>
        appendLog(String(error))
      );
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [meetings]);

  useEffect(() => {
    void invoke("list_models")
      .then((data) => {
        const parsed = Array.isArray(data) ? data : [];
        const names = parsed
          .map((item) =>
            String(
              item.id ??
                item.name ??
                item.model ??
                item.slug ??
                ""
            )
          )
          .filter(Boolean);
        if (names.length) {
          setModels(names);
          if (!names.includes(selectedModel)) {
            setSelectedModel(names[0]);
          }
        } else {
          setModels(getFallbackModels());
        }
      })
      .catch(() => setModels(getFallbackModels()));
  }, [selectedModel]);

  useEffect(() => {
    let isMounted = true;
    void register("Ctrl+Shift+Space", () => {
      if (!isMounted) return;
      if (isRecording) {
        void handleStop();
      } else {
        void handleStart();
      }
    });

    return () => {
      isMounted = false;
      void unregister("Ctrl+Shift+Space");
    };
  }, [isRecording]);

  useEffect(() => {
    const unlistenDelta = listen("summary-delta", (event) => {
      const payload = event.payload as {
        meetingId: string;
        event: { type: string; content?: string };
      };
      if (!payload) return;
      if (payload.meetingId !== activeMeetingRef.current) return;
      if (payload.event.type === "delta") {
        updateActiveMeeting((meeting) => ({
          ...meeting,
          summary: meeting.summary + (payload.event.content ?? ""),
          updatedAt: new Date().toISOString(),
        }));
      }
      if (payload.event.type === "final") {
        updateActiveMeeting((meeting) => ({
          ...meeting,
          summary: payload.event.content ?? meeting.summary,
          updatedAt: new Date().toISOString(),
        }));
      }
    });

    const unlistenDone = listen("summary-done", (event) => {
      const payload = event.payload as { meetingId: string; summary?: string | null };
      if (payload?.meetingId === activeMeetingRef.current) {
        if (payload.summary) {
          updateActiveMeeting((meeting) => ({
            ...meeting,
            summary: payload.summary ?? meeting.summary,
            updatedAt: new Date().toISOString(),
          }));
        }
        setIsSummarizing(false);
        setStatus("Idle");
        appendLog("Summary complete.");
      }
    });

    const unlistenError = listen("summary-error", (event) => {
      const message = String(event.payload ?? "Summary generation failed");
      setIsSummarizing(false);
      setStatus(message);
      appendLog(message);
    });

    const unlistenLog = listen("summary-log", (event) => {
      const message = String(event.payload ?? "");
      if (message.trim()) {
        appendLog(`Copilot: ${message}`);
      }
    });

    return () => {
      void unlistenDelta.then((fn) => fn());
      void unlistenDone.then((fn) => fn());
      void unlistenError.then((fn) => fn());
      void unlistenLog.then((fn) => fn());
    };
  }, []);

  function appendLog(message: string) {
    setLogs((prev) => [
      `${new Date().toLocaleTimeString()}  ${message}`,
      ...prev,
    ]);
  }

  function createMeeting(): MeetingRecord {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      title: "Untitled meeting",
      notes: "",
      transcript: "",
      summary: "",
      createdAt: now,
      updatedAt: now,
    };
  }

  function updateActiveMeeting(updater: (meeting: MeetingRecord) => MeetingRecord) {
    setMeetings((prev) =>
      prev.map((meeting) =>
        meeting.id === activeMeetingId ? updater(meeting) : meeting
      )
    );
  }

  function addMeeting() {
    const meeting = createMeeting();
    setMeetings((prev) => [meeting, ...prev]);
    setActiveMeetingId(meeting.id);
  }

  function handleSelect(field: SelectionState["field"], event: SyntheticEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    setSelection({
      field,
      start: target.selectionStart ?? 0,
      end: target.selectionEnd ?? 0,
    });
  }

  async function handleEnhanceSelection() {
    if (!selection.field) return;
    if (!activeMeeting) return;
    const start = selection.start;
    const end = selection.end;
    if (start === end) return;

    const source = activeMeeting[selection.field];
    const snippet = source.slice(start, end).trim();
    if (!snippet) return;

    setStatus("Enhancing selection...");
    appendLog("Enhancing selected text...");

    try {
      const enhanced = await invoke<string>("enhance_text", {
        text: snippet,
        model: selectedModel,
      });
      const updated = source.slice(0, start) + enhanced + source.slice(end);
      updateActiveMeeting((meeting) => ({
        ...meeting,
        [selection.field as "notes" | "summary" | "transcript"]: updated,
        updatedAt: new Date().toISOString(),
      }));
      setStatus("Idle");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Enhancement failed";
      setStatus(message);
      appendLog(message);
    }
  }

  async function handleStart() {
    if (isRecording) return;
    if (!config || !config.whisperPath || !config.modelPath) {
      setStatus("Missing config values (whisper/model)");
      appendLog("Missing config values. Update config.json in app data.");
      return;
    }
    setStatus("Requesting audio sources...");
    try {
      recorderRef.current = await startRecorder(config.includeSystemAudio);
      setIsRecording(true);
      setStatus("Recording...");
      appendLog("Recording started.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Failed to start recording";
      setStatus(message);
      appendLog(message);
      setIsRecording(false);
    }
  }

  async function handleStop() {
    if (!recorderRef.current) return;
    setStatus("Finalizing audio...");
    setIsRecording(false);

    try {
      const blob = await recorderRef.current.stop();
      recorderRef.current = null;
      setStatus("Preparing transcription...");
      appendLog(`Recording stopped. Audio size: ${blob.size} bytes.`);

      const audioBase64 = await blobToWavBase64(blob);
      setStatus("Transcribing with whisper.cpp...");
      appendLog("Sending audio to whisper.cpp...");

      const result = await invoke<TranscribeResponse>("transcribe_audio", {
        audioBase64,
        language: config?.language ?? "en",
      });

      appendLog(`Command: ${result.command}`);
      if (result.stdout.trim()) appendLog(`stdout: ${result.stdout.trim()}`);
      if (result.stderr.trim()) appendLog(`stderr: ${result.stderr.trim()}`);

      updateActiveMeeting((meeting) => ({
        ...meeting,
        transcript: meeting.transcript
          ? `${meeting.transcript}\n${result.transcript}`
          : result.transcript,
        updatedAt: new Date().toISOString(),
      }));
      setStatus("Idle");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Transcription failed";
      setStatus(message);
      appendLog(message);
    }
  }

  async function handleGenerateSummary() {
    if (!activeMeeting) return;
    if (!activeMeeting.transcript.trim() && !activeMeeting.notes.trim()) {
      appendLog("Summary blocked: transcript and notes are empty.");
      return;
    }
    setStatus("Enhancing notes...");
    setIsSummarizing(true);
    appendLog("Streaming summary from Copilot SDK...");
    updateActiveMeeting((meeting) => ({
      ...meeting,
      summary: "",
      updatedAt: new Date().toISOString(),
    }));
    try {
      await invoke("start_summary_stream", {
        meetingId: activeMeeting.id,
        transcript: activeMeeting.transcript,
        notes: activeMeeting.notes,
        model: selectedModel,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Summary generation failed";
      setStatus(message);
      appendLog(message);
    }
  }

  async function handleDiagnostics() {
    if (!config?.whisperPath.trim()) {
      appendLog("Diagnostics failed: whisper binary path is empty.");
      return;
    }

    setStatus("Running diagnostics...");
    try {
      const result = await invoke<string>("diagnose_whisper", {
        whisperPath: config.whisperPath,
      });
      appendLog("Diagnostics result:\n" + result);
      setStatus("Idle");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Diagnostics failed";
      setStatus(message);
      appendLog(message);
    }
  }

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <h1>Voxii</h1>
            <p>Local meeting notes</p>
          </div>
          <button className="ghost" onClick={addMeeting}>
            New meeting
          </button>
        </div>
        <div className="meeting-list">
          {meetings.map((meeting) => (
            <button
              key={meeting.id}
              className={`meeting-item ${
                meeting.id === activeMeetingId ? "active" : ""
              }`}
              onClick={() => setActiveMeetingId(meeting.id)}
            >
              <div className="meeting-title">{meeting.title}</div>
              <div className="meeting-meta">
                {new Date(meeting.updatedAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="content">
        <header className="content-header">
          <div>
            <input
              className="title-input"
              value={activeMeeting?.title ?? ""}
              onChange={(event) =>
                updateActiveMeeting((meeting) => ({
                  ...meeting,
                  title: event.target.value,
                  updatedAt: new Date().toISOString(),
                }))
              }
              placeholder="Meeting title"
            />
            <p className="app__subtitle">
              Global hotkey: Ctrl + Shift + Space
            </p>
          </div>
          <div className={`status ${isRecording ? "status--live" : ""}`}>
            <span className="status__dot" />
            <span>{status}</span>
          </div>
        </header>

        <section className="record-bar">
          <button
            className={`primary ${isRecording ? "danger" : ""}`}
            onClick={isRecording ? handleStop : handleStart}
          >
            {isRecording ? "Stop listening" : "Start listening"}
          </button>
          <div className="record-hint">
            {config?.includeSystemAudio
              ? "System + mic capture enabled (configured)."
              : "Mic-only capture (configured)."}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Scratch pad</h2>
            <div className="panel-actions">
              <button
                className="ghost"
                onClick={handleEnhanceSelection}
                disabled={selection.field !== "notes"}
              >
                Enhance selection
              </button>
            </div>
          </div>
          <textarea
            ref={notesRef}
            value={activeMeeting?.notes ?? ""}
            onChange={(event) =>
              updateActiveMeeting((meeting) => ({
                ...meeting,
                notes: event.target.value,
                updatedAt: new Date().toISOString(),
              }))
            }
            onSelect={(event) => handleSelect("notes", event)}
            placeholder="Jot thoughts, agenda, or prep notes..."
          />
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Transcript</h2>
            <div className="panel-actions">
              <button
                className="ghost"
                onClick={handleEnhanceSelection}
                disabled={selection.field !== "transcript"}
              >
                Enhance selection
              </button>
            </div>
          </div>
          <textarea
            ref={transcriptRef}
            value={activeMeeting?.transcript ?? ""}
            onChange={(event) =>
              updateActiveMeeting((meeting) => ({
                ...meeting,
                transcript: event.target.value,
                updatedAt: new Date().toISOString(),
              }))
            }
            onSelect={(event) => handleSelect("transcript", event)}
            placeholder="Transcript will appear here..."
          />
        </section>

        <section className="panel summary-panel">
          <div className="panel-header">
            <div>
              <h2>Summary</h2>
              {isSummarizing ? (
                <span className="pill">Enhancing notes…</span>
              ) : null}
            </div>
            <div className="panel-actions">
              <select
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                onClick={handleGenerateSummary}
                disabled={isSummarizing}
              >
                Generate summary
              </button>
              <button
                className="ghost"
                onClick={handleEnhanceSelection}
                disabled={selection.field !== "summary"}
              >
                Enhance selection
              </button>
            </div>
          </div>
          <textarea
            ref={summaryRef}
            value={activeMeeting?.summary ?? ""}
            onChange={(event) =>
              updateActiveMeeting((meeting) => ({
                ...meeting,
                summary: event.target.value,
                updatedAt: new Date().toISOString(),
              }))
            }
            onSelect={(event) => handleSelect("summary", event)}
            placeholder="Summary will be generated here..."
          />
        </section>

        <section className={`panel diagnostics ${diagnosticsOpen ? "open" : ""}`}>
          <div className="panel-header">
            <button
              className="ghost"
              onClick={() => setDiagnosticsOpen((prev) => !prev)}
            >
              {diagnosticsOpen ? "Hide diagnostics" : "Show diagnostics"}
            </button>
            <div className="panel-actions">
              <button className="ghost" onClick={handleDiagnostics}>
                Run diagnostics
              </button>
              <button className="ghost" onClick={() => setLogs([])}>
                Clear
              </button>
            </div>
          </div>
          <div className="diagnostics-body">
            <textarea
              value={logs.join("\n\n")}
              readOnly
              placeholder="Logs will appear here..."
            />
            <div className="config-hint">
              Config: {config?.whisperPath ? "Loaded" : "Missing"}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function getFallbackModels() {
  return [
    "grok-fast-1",
    "gemini-flash-3",
    "claude-haiku",
    "gpt-4.1",
  ];
}

export default App;
