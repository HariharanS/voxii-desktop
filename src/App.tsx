import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

// ============================================================================
// Types
// ============================================================================

type RecorderHandle = {
  stop: () => Promise<Blob>;
  getChunk: () => Promise<Blob | null>;
  getFinalChunk: () => Promise<Blob | null>;
  systemAudioActive: boolean;
  mimeType: string;
};

type TranscribeResponse = {
  transcript: string;
  stdout: string;
  stderr: string;
  command: string;
  provider: string;
};

type TranscriptionProvider = "local" | "openai-compatible" | "auto";

type StreamingConfig = {
  enabled: boolean;
  chunkDurationMs: number;
  overlapMs: number;
};

type LocalTranscriptionConfig = {
  whisperPath: string;
  modelPath: string;
  modelName: string;
  beamSize: number;
  bestOf: number;
};

type OpenAICompatibleConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
};

type TranscriptionConfig = {
  provider: TranscriptionProvider;
  language: string;
  streaming: StreamingConfig;
  local: LocalTranscriptionConfig;
  openaiCompatible: OpenAICompatibleConfig;
};

type AIConfig = {
  defaultModel: string;
};

type ExportConfig = {
  defaultFormat: string;
  localPath: string;
};

type UIConfig = {
  theme: string;
  showDiagnostics: boolean;
  includeSystemAudio: boolean;
};

type AppConfig = {
  version: number;
  transcription: TranscriptionConfig;
  ai: AIConfig;
  export: ExportConfig;
  ui: UIConfig;
  // Legacy fields for backward compat
  whisperPath?: string;
  modelPath?: string;
  language?: string;
  includeSystemAudio?: boolean;
  defaultModel?: string;
};

type ActionItem = {
  id: string;
  task: string;
  assignee: string | null;
  dueDate: string | null;
  priority: "high" | "medium" | "low";
  status: "pending" | "completed";
  context: string | null;
};

type MeetingRecord = {
  id: string;
  title: string;
  notes: string;
  transcript: string;
  summary: string;
  actionItems: ActionItem[];
  createdAt: string;
  updatedAt: string;
};

type SelectionState = {
  field: "notes" | "summary" | "transcript" | null;
  start: number;
  end: number;
};

// ============================================================================
// Audio Recording
// ============================================================================

async function startRecorder(includeSystemAudio: boolean): Promise<RecorderHandle> {
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

  let systemStream: MediaStream | null = null;
  let systemAudioActive = false;
  if (includeSystemAudio) {
    try {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });

      systemAudioActive = true;

      for (const track of systemStream.getVideoTracks()) {
        track.stop();
      }
    } catch {
      // System audio capture failed, continue with mic only
      console.warn("System audio capture not available");
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

  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  const selectedType = preferredTypes.find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
  const createRecorder = () =>
    selectedType
      ? new MediaRecorder(destination.stream, { mimeType: selectedType })
      : new MediaRecorder(destination.stream);

  const fullRecorder = createRecorder();
  const blobType = fullRecorder.mimeType || "audio/webm";

  const chunks: Blob[] = [];

  fullRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  // Request data every second for streaming
  fullRecorder.start(1000);

  let streamRecorder: MediaRecorder | null = null;
  let streamParts: Blob[] = [];
  let streamChunkResolver: ((chunk: Blob | null) => void) | null = null;
  let streamActive = false;
  let streamWarmup = true;

  const ensureStreamRecorder = () => {
    if (streamRecorder) return;
    streamRecorder = createRecorder();
    streamRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        streamParts.push(event.data);
      }
    };
    streamRecorder.onstop = () => {
      const chunkType = streamRecorder?.mimeType || blobType;
      const blob = streamParts.length
        ? new Blob(streamParts, { type: chunkType })
        : null;
      streamParts = [];
      const resolver = streamChunkResolver;
      streamChunkResolver = null;
      if (resolver) resolver(blob);
      if (streamActive) {
        streamRecorder.start();
      }
    };
    streamActive = true;
    streamRecorder.start();
  };

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        fullRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: blobType });
          micStream.getTracks().forEach((track) => track.stop());
          systemStream?.getTracks().forEach((track) => track.stop());
          audioContext.close();
          resolve(blob);
        };
        fullRecorder.stop();
      }),
    getChunk: async () => {
      ensureStreamRecorder();
      if (!streamRecorder) return null;
      if (streamWarmup) {
        streamWarmup = false;
        return null;
      }
      if (streamRecorder.state !== "recording") return null;
      if (streamChunkResolver) return null;
      const chunkPromise = new Promise<Blob | null>((resolve) => {
        streamChunkResolver = resolve;
      });
      streamRecorder.stop();
      return chunkPromise;
    },
    getFinalChunk: async () => {
      if (!streamRecorder) return null;
      if (streamRecorder.state === "inactive") return null;
      if (streamChunkResolver) return null;
      streamActive = false;
      const chunkPromise = new Promise<Blob | null>((resolve) => {
        streamChunkResolver = resolve;
      });
      streamRecorder.stop();
      return chunkPromise;
    },
    systemAudioActive,
    mimeType: fullRecorder.mimeType || selectedType || "",
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
  // Config & Data
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gpt-4.1");
  const [localModelOptions, setLocalModelOptions] = useState<string[]>([]);
  
  // UI State
  const [status, setStatus] = useState("Idle");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isCleaningTranscript, setIsCleaningTranscript] = useState(false);
  const [isEnhancingSelection, setIsEnhancingSelection] = useState(false);
  const [isExtractingActions, setIsExtractingActions] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isTranscriptCollapsed, setIsTranscriptCollapsed] = useState(false);
  const [selection, setSelection] = useState<SelectionState>({
    field: null,
    start: 0,
    end: 0,
  });
  
  // Live transcript during recording
  const [liveTranscript, setLiveTranscript] = useState<string>("");
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);

  // Refs
  const recorderRef = useRef<RecorderHandle | null>(null);
  const activeMeetingRef = useRef<string | null>(null);
  const summaryStartRef = useRef<number | null>(null);
  const summaryFirstTokenRef = useRef<boolean>(false);
  const summaryBufferRef = useRef<string>("");
  const enhanceBufferRef = useRef<string>("");
  const enhanceContextRef = useRef<{
    meetingId: string;
    selectionId: string;
    field: "notes" | "summary" | "transcript";
    prefix: string;
    suffix: string;
  } | null>(null);
  const cleanBufferRef = useRef<string>("");
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const summaryRef = useRef<HTMLTextAreaElement | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const streamingIntervalRef = useRef<number | null>(null);
  const streamingChunkIndexRef = useRef<number>(0);
  const streamingBusyRef = useRef<boolean>(false);
  const pendingStreamingChunkRef = useRef<Blob | null>(null);

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
          setSelectedModel((prev) => (names.includes(prev) ? prev : names[0]));
          appendLog(`Models available (${names.length}): ${names.join(", ")}`);
        } else {
          setModels(getFallbackModels());
        }
      })
      .catch(() => setModels(getFallbackModels()));
  }, []);

  useEffect(() => {
    if (!config) return;
    const modelDir = config?.transcription?.local?.modelPath ?? "";
    if (!modelDir.trim()) {
      setLocalModelOptions([]);
      return;
    }

    void invoke<string[]>("list_local_models", { modelDir })
      .then((data) => {
        const list = Array.isArray(data) ? data.filter(Boolean) : [];
        setLocalModelOptions(list);
      })
      .catch((error) => {
        appendLog(`Failed to list local models: ${String(error)}`);
        setLocalModelOptions([]);
      });
  }, [config?.transcription?.local?.modelPath]);

  useEffect(() => {
    if (!config) return;
    if (!localModelOptions.length) return;
    const current = config?.transcription?.local?.modelName ?? "";
    if (current && localModelOptions.includes(current)) return;

    const next = localModelOptions[0];
    const newConfig = {
      ...config,
      transcription: {
        ...config.transcription,
        local: {
          ...config.transcription.local,
          modelName: next,
        },
      },
    };
    setConfig(newConfig);
    void invoke("save_config_command", { config: newConfig }).catch((error) =>
      appendLog(`Failed to save model selection: ${String(error)}`)
    );
  }, [localModelOptions, config]);

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
      if (!summaryFirstTokenRef.current && payload.event.type === "delta") {
        summaryFirstTokenRef.current = true;
        if (summaryStartRef.current) {
          const elapsed = Date.now() - summaryStartRef.current;
          appendLog(`UI: first summary token after ${elapsed}ms.`);
        }
      }
      if (payload.event.type === "delta") {
        const next = summaryBufferRef.current + (payload.event.content ?? "");
        summaryBufferRef.current = next;
        if (summaryRef.current) {
          summaryRef.current.value = next;
        }
        updateActiveMeeting((meeting) => ({
          ...meeting,
          summary: next,
          updatedAt: new Date().toISOString(),
        }));
      }
      if (payload.event.type === "final") {
        const finalText = payload.event.content ?? summaryBufferRef.current;
        summaryBufferRef.current = finalText;
        if (summaryRef.current) {
          summaryRef.current.value = finalText;
        }
        updateActiveMeeting((meeting) => ({
          ...meeting,
          summary: finalText,
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
        if (summaryStartRef.current) {
          const elapsed = Date.now() - summaryStartRef.current;
          appendLog(`Summary complete after ${elapsed}ms.`);
        } else {
          appendLog("Summary complete.");
        }
      }
    });

    const unlistenError = listen("summary-error", (event) => {
      const message = String(event.payload ?? "Summary generation failed");
      setIsSummarizing(false);
      setStatus(message);
      appendLog(message);
      if (summaryStartRef.current) {
        const elapsed = Date.now() - summaryStartRef.current;
        appendLog(`Summary failed after ${elapsed}ms.`);
      }
    });

    const unlistenLog = listen("summary-log", (event) => {
      const message = String(event.payload ?? "");
      if (message.trim()) {
        appendLog(`Copilot: ${message}`);
      }
    });

    const unlistenEnhanceDelta = listen("enhance-delta", (event) => {
      const payload = event.payload as {
        meetingId: string;
        selectionId: string;
        event: { type: string; content?: string };
      };
      const context = enhanceContextRef.current;
      if (!context) return;
      if (payload?.meetingId !== context.meetingId) return;
      if (payload?.selectionId !== context.selectionId) return;
      if (payload.event.type === "delta") {
        const next = enhanceBufferRef.current + (payload.event.content ?? "");
        enhanceBufferRef.current = next;
        const updated = context.prefix + next + context.suffix;
        updateActiveMeeting((meeting) => ({
          ...meeting,
          [context.field]: updated,
          updatedAt: new Date().toISOString(),
        }));
      }
      if (payload.event.type === "final") {
        const finalText = payload.event.content ?? enhanceBufferRef.current;
        enhanceBufferRef.current = finalText;
        const updated = context.prefix + finalText + context.suffix;
        updateActiveMeeting((meeting) => ({
          ...meeting,
          [context.field]: updated,
          updatedAt: new Date().toISOString(),
        }));
      }
    });

    const unlistenEnhanceDone = listen("enhance-done", (event) => {
      const payload = event.payload as {
        meetingId: string;
        selectionId: string;
        text?: string | null;
      };
      const context = enhanceContextRef.current;
      if (!context) return;
      if (payload?.meetingId !== context.meetingId) return;
      if (payload?.selectionId !== context.selectionId) return;
      const finalText = payload.text ?? enhanceBufferRef.current;
      const updated = context.prefix + finalText + context.suffix;
      updateActiveMeeting((meeting) => ({
        ...meeting,
        [context.field]: updated,
        updatedAt: new Date().toISOString(),
      }));
      setIsEnhancingSelection(false);
      setStatus("Idle");
      appendLog("Enhancement complete.");
      enhanceContextRef.current = null;
    });

    const unlistenEnhanceError = listen("enhance-error", (event) => {
      const message = String(event.payload ?? "Enhancement failed");
      setIsEnhancingSelection(false);
      setStatus(message);
      appendLog(message);
      enhanceContextRef.current = null;
    });

    const unlistenCleanDelta = listen("clean-transcript-delta", (event) => {
      const payload = event.payload as {
        meetingId: string;
        event: { type: string; content?: string };
      };
      if (!payload) return;
      if (payload.meetingId !== activeMeetingRef.current) return;
      if (payload.event.type === "delta") {
        const next = cleanBufferRef.current + (payload.event.content ?? "");
        cleanBufferRef.current = next;
        updateActiveMeeting((meeting) => ({
          ...meeting,
          transcript: next,
          updatedAt: new Date().toISOString(),
        }));
      }
      if (payload.event.type === "final") {
        const finalText = payload.event.content ?? cleanBufferRef.current;
        cleanBufferRef.current = finalText;
        updateActiveMeeting((meeting) => ({
          ...meeting,
          transcript: finalText,
          updatedAt: new Date().toISOString(),
        }));
      }
    });

    const unlistenCleanDone = listen("clean-transcript-done", (event) => {
      const payload = event.payload as { meetingId: string; text?: string | null };
      if (payload?.meetingId !== activeMeetingRef.current) return;
      if (payload?.text) {
        updateActiveMeeting((meeting) => ({
          ...meeting,
          transcript: payload.text ?? meeting.transcript,
          updatedAt: new Date().toISOString(),
        }));
      }
      setIsCleaningTranscript(false);
      setStatus("Idle");
      appendLog("Transcript cleaned.");
    });

    const unlistenCleanError = listen("clean-transcript-error", (event) => {
      const message = String(event.payload ?? "Transcript cleanup failed");
      setIsCleaningTranscript(false);
      setStatus(message);
      appendLog(message);
    });

    // Action items events
    const unlistenActionsDone = listen("actions-done", (event) => {
      const payload = event.payload as { 
        meetingId: string; 
        actions: { items: ActionItem[] } 
      };
      if (payload?.meetingId === activeMeetingRef.current) {
        const items = payload.actions?.items || [];
        updateActiveMeeting((meeting) => ({
          ...meeting,
          actionItems: items,
          updatedAt: new Date().toISOString(),
        }));
        setIsExtractingActions(false);
        setStatus("Idle");
        appendLog(`Extracted ${items.length} action items.`);
      }
    });

    const unlistenActionsError = listen("actions-error", (event) => {
      const payload = event.payload as { meetingId: string; error: string };
      if (payload?.meetingId === activeMeetingRef.current) {
        setIsExtractingActions(false);
        setStatus(payload.error || "Action extraction failed");
        appendLog(payload.error || "Action extraction failed");
      }
    });

    // Streaming transcription events
    const unlistenTranscriptionChunk = listen("transcription-chunk", (event) => {
      const payload = event.payload as {
        sessionId: string;
        chunkIndex: number;
        text: string;
        provider: string;
      };
      setLiveTranscript((prev) => prev + " " + payload.text);
    });

    const unlistenTranscriptionError = listen("transcription-error", (event) => {
      const payload = event.payload as {
        sessionId: string;
        chunkIndex: number;
        error: string;
      };
      appendLog(`Transcription chunk error: ${payload.error}`);
    });

    return () => {
      void unlistenDelta.then((fn) => fn());
      void unlistenDone.then((fn) => fn());
      void unlistenError.then((fn) => fn());
      void unlistenLog.then((fn) => fn());
      void unlistenEnhanceDelta.then((fn) => fn());
      void unlistenEnhanceDone.then((fn) => fn());
      void unlistenEnhanceError.then((fn) => fn());
      void unlistenCleanDelta.then((fn) => fn());
      void unlistenCleanDone.then((fn) => fn());
      void unlistenCleanError.then((fn) => fn());
      void unlistenActionsDone.then((fn) => fn());
      void unlistenActionsError.then((fn) => fn());
      void unlistenTranscriptionChunk.then((fn) => fn());
      void unlistenTranscriptionError.then((fn) => fn());
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
      actionItems: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  // Helper to get effective config values (handles legacy config)
  function getEffectiveWhisperPath(): string {
    if (!config) return "";
    return config.transcription?.local?.whisperPath || config.whisperPath || "";
  }

  function getEffectiveModelPath(): string {
    if (!config) return "";
    return config.transcription?.local?.modelPath || config.modelPath || "";
  }

  function isTranscriptionConfigured(): boolean {
    const localConfigured = getEffectiveWhisperPath() && getEffectiveModelPath();
    const cloudConfigured = config?.transcription?.openaiCompatible?.apiKey;
    return !!(localConfigured || cloudConfigured);
  }

  function updateActiveMeeting(updater: (meeting: MeetingRecord) => MeetingRecord) {
    const targetId = activeMeetingRef.current;
    if (!targetId) return;
    setMeetings((prev) =>
      prev.map((meeting) =>
        meeting.id === targetId ? updater(meeting) : meeting
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

    setIsEnhancingSelection(true);
    setStatus("Enhancing selection...");
    appendLog("Enhancing selected text...");

    const selectionId = crypto.randomUUID();
    const prefix = source.slice(0, start);
    const suffix = source.slice(end);
    enhanceBufferRef.current = "";
    enhanceContextRef.current = {
      meetingId: activeMeeting.id,
      selectionId,
      field: selection.field,
      prefix,
      suffix,
    };

    try {
      await invoke("start_enhance_stream", {
        meetingId: activeMeeting.id,
        selectionId,
        text: snippet,
        model: selectedModel,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Enhancement failed";
      setStatus(message);
      setIsEnhancingSelection(false);
      appendLog(message);
      enhanceContextRef.current = null;
    }
  }

  async function handleCleanTranscript() {
    if (!activeMeeting) return;
    const source = activeMeeting.transcript.trim();
    if (!source) return;

    setIsCleaningTranscript(true);
    setStatus("Cleaning transcript...");
    appendLog("Cleaning transcript for accuracy...");
    cleanBufferRef.current = "";

    try {
      await invoke("start_clean_transcript_stream", {
        meetingId: activeMeeting.id,
        text: source,
        model: selectedModel,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Transcript cleanup failed";
      setStatus(message);
      appendLog(message);
      setIsCleaningTranscript(false);
    }
  }

  async function handleStart() {
    if (isRecording) return;
    if (!isTranscriptionConfigured()) {
      setStatus("Transcription not configured");
      appendLog("Configure transcription in settings (local whisper or cloud API).");
      setSettingsOpen(true);
      return;
    }
    setStatus("Requesting audio sources...");
    try {
      const includeSystem = config?.ui?.includeSystemAudio ?? false;
      recorderRef.current = await startRecorder(includeSystem);
      if (includeSystem && recorderRef.current && !recorderRef.current.systemAudioActive) {
        appendLog("System audio capture not available; continuing with mic only.");
      }
      if (recorderRef.current?.mimeType) {
        appendLog(`Recorder mime: ${recorderRef.current.mimeType}`);
      }
      setIsRecording(true);
      setRecordingTime(0);
      setLiveTranscript("");
      setStatus("Recording...");
      appendLog("Recording started.");

      // Start recording timer
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);

      // Start streaming transcription if enabled
      if (config?.transcription?.streaming?.enabled) {
        try {
          const sessionId = await invoke<string>("start_streaming_session", {
            provider: config.transcription.provider,
          });
          setStreamingSessionId(sessionId);
          streamingChunkIndexRef.current = 0;
          appendLog(`Streaming session started: ${sessionId}`);

          const intervalMs = Math.max(
            1000,
            config.transcription.streaming?.chunkDurationMs ?? 5000
          );
          streamingIntervalRef.current = window.setInterval(async () => {
            if (streamingBusyRef.current) return;
            if (!recorderRef.current) return;
            if (!sessionId) return;
            try {
              streamingBusyRef.current = true;
              const chunk = await recorderRef.current.getChunk();
              if (!chunk) return;
              const audioBase64 = await blobToWavBase64(chunk);
              const chunkIndex = streamingChunkIndexRef.current;
              streamingChunkIndexRef.current += 1;
              await invoke("transcribe_chunk", {
                sessionId,
                audioBase64,
                chunkIndex,
              });
            } catch (err) {
              appendLog(`Streaming chunk failed: ${String(err)}`);
            } finally {
              streamingBusyRef.current = false;
            }
          }, intervalMs);
        } catch (err) {
          appendLog(`Streaming not available: ${err}`);
        }
      }
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
    const recorder = recorderRef.current;
    if (!recorder) return;
    setStatus("Finalizing audio...");
    setIsRecording(false);
    
    // Stop recording timer
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    
    // Stop streaming interval
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
    }
    streamingBusyRef.current = false;

    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      setStatus("Preparing transcription...");
      appendLog(`Recording stopped. Audio size: ${blob.size} bytes. Duration: ${recordingTime}s`);

      // Flush any remaining streaming audio before ending the session
      if (config?.transcription?.streaming?.enabled && streamingSessionId) {
        await waitForStreamingIdle(1500);
        try {
          const pending = pendingStreamingChunkRef.current;
          const finalChunk = await recorder.getFinalChunk();
          const chunkType =
            pending?.type || finalChunk?.type || recorder.mimeType || "audio/webm";
          const combined = pending && finalChunk
            ? new Blob([pending, finalChunk], { type: chunkType })
            : pending || finalChunk;
          pendingStreamingChunkRef.current = null;
          if (combined) {
            const audioBase64 = await blobToWavBase64(combined);
            const chunkIndex = streamingChunkIndexRef.current;
            streamingChunkIndexRef.current += 1;
            await invoke("transcribe_chunk", {
              sessionId: streamingSessionId,
              audioBase64,
              chunkIndex,
            });
          }
        } catch (err) {
          appendLog(`Final streaming chunk failed: ${String(err)}`);
        }
      }

      // End streaming session if active
      let mergedTranscript = "";
      if (streamingSessionId) {
        try {
          mergedTranscript = await invoke<string>("end_streaming_session", {
            sessionId: streamingSessionId,
          });
        } catch {
          // Ignore cleanup errors
        }
        setStreamingSessionId(null);
      }

      const streamingEnabled = config?.transcription?.streaming?.enabled ?? false;
      const mergedText = mergedTranscript.trim();
      const liveText = liveTranscript.trim();
      const shouldUseStreaming = streamingEnabled && (mergedText || liveText);

      let finalTranscript = "";

      if (shouldUseStreaming) {
        finalTranscript = mergedText || liveText;
        appendLog("Using streaming transcript; skipping batch transcription.");
      } else {
        const audioBase64 = await blobToWavBase64(blob);
        const provider = config?.transcription?.provider || "local";
        setStatus(`Transcribing (${provider})...`);
        appendLog(`Sending audio to transcription provider: ${provider}`);

        const result = await invoke<TranscribeResponse>("transcribe_audio", {
          audioBase64,
          language: config?.transcription?.language ?? "en",
        });

        appendLog(`Provider: ${result.provider}`);
        appendLog(`Command: ${result.command}`);
        if (result.stdout.trim()) appendLog(`stdout: ${result.stdout.trim()}`);
        if (result.stderr.trim()) appendLog(`stderr: ${result.stderr.trim()}`);

        finalTranscript = result.transcript.trim();
      }
      
      updateActiveMeeting((meeting) => ({
        ...meeting,
        transcript: meeting.transcript
          ? `${meeting.transcript}\n${finalTranscript}`
          : finalTranscript,
        updatedAt: new Date().toISOString(),
      }));
      
      setLiveTranscript("");
      setRecordingTime(0);
      streamingChunkIndexRef.current = 0;
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

  async function handleExtractActions() {
    if (!activeMeeting) return;
    if (!activeMeeting.transcript.trim() && !activeMeeting.notes.trim()) {
      appendLog("Action extraction blocked: transcript and notes are empty.");
      return;
    }
    
    setIsExtractingActions(true);
    setStatus("Extracting action items...");
    appendLog("Starting action items extraction...");
    
    try {
      await invoke("extract_action_items", {
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
            : "Action extraction failed";
      setStatus(message);
      appendLog(message);
      setIsExtractingActions(false);
    }
  }

  async function handleExportMarkdown() {
    if (!activeMeeting) return;
    
    setStatus("Exporting markdown...");
    try {
      const path = await invoke<string>("export_meeting_markdown", {
        meeting: activeMeeting,
        includeTranscript: true,
      });
      setStatus("Exported!");
      appendLog(`Exported to: ${path}`);
      setTimeout(() => setStatus("Idle"), 2000);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Export failed";
      setStatus(message);
      appendLog(message);
    }
  }

  function toggleActionItem(itemId: string) {
    updateActiveMeeting((meeting) => ({
      ...meeting,
      actionItems: meeting.actionItems.map((item) =>
        item.id === itemId
          ? { ...item, status: item.status === "completed" ? "pending" : "completed" }
          : item
      ),
      updatedAt: new Date().toISOString(),
    }));
  }

  function buildMeetingMarkdown(meeting: MeetingRecord): string {
    const lines: string[] = [];
    lines.push(`# ${meeting.title || "Untitled meeting"}`);
    lines.push(`**Date:** ${meeting.createdAt}`);
    lines.push(`**Last Updated:** ${meeting.updatedAt}`);
    lines.push("");

    if (meeting.summary.trim()) {
      lines.push("## Summary");
      lines.push(meeting.summary.trim());
      lines.push("");
    }

    if (meeting.actionItems.length) {
      lines.push("## Action Items");
      for (const item of meeting.actionItems) {
        const checkbox = item.status === "completed" ? "[x]" : "[ ]";
        const assignee = item.assignee ? `**${item.assignee}**: ` : "";
        const due = item.dueDate ? ` (due: ${item.dueDate})` : "";
        lines.push(`- ${checkbox} ${assignee}${item.task}${due}`);
      }
      lines.push("");
    }

    if (meeting.notes.trim()) {
      lines.push("## Notes");
      lines.push(meeting.notes.trim());
      lines.push("");
    }

    if (meeting.transcript.trim()) {
      lines.push("## Transcript");
      lines.push(meeting.transcript.trim());
      lines.push("");
    }

    lines.push("---");
    lines.push("*Generated by Voxii*");
    return lines.join("\n");
  }

  async function handleCopyMarkdown() {
    if (!activeMeeting) return;
    const markdown = buildMeetingMarkdown(activeMeeting).trim();
    if (!markdown) {
      setStatus("Nothing to copy");
      appendLog("Copy blocked: meeting content is empty.");
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      setStatus("Copied markdown");
      appendLog("Markdown copied to clipboard.");
      setTimeout(() => setStatus("Idle"), 1500);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Copy failed";
      setStatus(message);
      appendLog(message);
    }
  }

  function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  async function waitForStreamingIdle(timeoutMs: number) {
    const start = Date.now();
    while (streamingBusyRef.current) {
      if (Date.now() - start > timeoutMs) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function handleGenerateSummary() {
    if (!activeMeeting) return;
    if (!activeMeeting.transcript.trim() && !activeMeeting.notes.trim()) {
      appendLog("Summary blocked: transcript and notes are empty.");
      return;
    }
    summaryStartRef.current = Date.now();
    summaryFirstTokenRef.current = false;
    summaryBufferRef.current = "";
    setStatus("Generating summary...");
    setIsSummarizing(true);
    appendLog("UI: invoking summary generation.");
    updateActiveMeeting((meeting) => ({
      ...meeting,
      summary: "",
      updatedAt: new Date().toISOString(),
    }));
    if (summaryRef.current) {
      summaryRef.current.value = "";
    }
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
      if (summaryStartRef.current) {
        const elapsed = Date.now() - summaryStartRef.current;
        appendLog(`Summary invoke failed after ${elapsed}ms.`);
      }
    }
  }

  async function handleDiagnostics() {
    if (!config?.transcription?.local?.whisperPath?.trim()) {
      appendLog("Diagnostics failed: whisper binary path is empty.");
      return;
    }

    setStatus("Running diagnostics...");
    try {
      const result = await invoke<string>("diagnose_whisper", {
        whisperPath: config.transcription.local.whisperPath,
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
          <div className="record-controls">
            <button
              className={`primary ${isRecording ? "danger" : ""}`}
              onClick={isRecording ? handleStop : handleStart}
            >
              {isRecording ? "Stop listening" : "Start listening"}
            </button>
            {config?.transcription?.provider !== "openai-compatible" && (
              <select
                className="model-select"
                value={config?.transcription?.local?.modelName ?? ""}
                disabled={!localModelOptions.length || isRecording}
                onChange={(event) => {
                  if (!config) return;
                  const newConfig = {
                    ...config,
                    transcription: {
                      ...config.transcription,
                      local: {
                        ...config.transcription.local,
                        modelName: event.target.value,
                      },
                    },
                  };
                  setConfig(newConfig);
                  void invoke("save_config_command", { config: newConfig }).catch(
                    (error) =>
                      appendLog(`Failed to save model selection: ${String(error)}`)
                  );
                }}
                title="Local Whisper model"
              >
                {!localModelOptions.length && (
                  <option value="">No models found</option>
                )}
                {localModelOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {config && (
              <label className="capture-toggle" title="Include system audio in the recording">
                <input
                  type="checkbox"
                  checked={Boolean(config?.ui?.includeSystemAudio)}
                  disabled={isRecording}
                  onChange={async (event) => {
                    const next = event.target.checked;
                    const newConfig = {
                      ...config,
                      ui: {
                        ...config.ui,
                        includeSystemAudio: next,
                      },
                    };
                    setConfig(newConfig);
                    try {
                      await invoke("save_config_command", { config: newConfig });
                    } catch (error) {
                      appendLog(`Failed to save capture setting: ${String(error)}`);
                    }
                  }}
                />
                <span>System audio</span>
              </label>
            )}
            {config && (
              <label className="capture-toggle" title="Enable live transcription during recording">
                <input
                  type="checkbox"
                  checked={config?.transcription?.streaming?.enabled ?? true}
                  disabled={isRecording}
                  onChange={async (event) => {
                    const next = event.target.checked;
                    const newConfig = {
                      ...config,
                      transcription: {
                        ...config.transcription,
                        streaming: {
                          ...config.transcription.streaming,
                          enabled: next,
                        },
                      },
                    };
                    setConfig(newConfig);
                    try {
                      await invoke("save_config_command", { config: newConfig });
                    } catch (error) {
                      appendLog(`Failed to save streaming toggle: ${String(error)}`);
                    }
                  }}
                />
                <span>Live transcript</span>
              </label>
            )}
            {isRecording && (
              <span className="recording-timer">{formatTime(recordingTime)}</span>
            )}
          </div>
          <div className="record-actions">
            <button
              className="ghost"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              ⚙️ Settings
            </button>
            <button
              className="ghost"
              onClick={handleExportMarkdown}
              disabled={!activeMeeting?.summary?.trim()}
              title="Export as Markdown"
            >
              📄 Export
            </button>
          </div>
          <div className="record-hint">
            {config?.ui?.includeSystemAudio
              ? "System + mic capture enabled (configured)."
              : "Mic-only capture (configured)."}
          </div>
        </section>

        {isRecording && liveTranscript && (
          <section className="panel live-transcript-panel">
            <div className="panel-header">
              <h2>
                <span className="live-indicator" />
                Live Transcript
              </h2>
            </div>
            <div className="live-transcript-body">
              {liveTranscript}
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-header">
            <h2>Scratch pad</h2>
            <div className="panel-actions">
              <button
                className="ghost"
                onClick={handleEnhanceSelection}
                disabled={isEnhancingSelection || selection.field !== "notes"}
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

        <section className={`panel ${isTranscriptCollapsed ? "panel--collapsed" : ""}`}>
          <div className="panel-header">
            <h2>Transcript</h2>
            <div className="panel-actions">
              <button
                className="ghost"
                onClick={handleCleanTranscript}
                disabled={
                  isCleaningTranscript ||
                  isEnhancingSelection ||
                  !activeMeeting?.transcript.trim()
                }
              >
                {isCleaningTranscript ? "Cleaning..." : "Clean transcript"}
              </button>
              <button
                className="ghost"
                onClick={handleEnhanceSelection}
                disabled={
                  isEnhancingSelection ||
                  selection.field !== "transcript"
                }
              >
                Enhance selection
              </button>
              <button
                className="ghost"
                onClick={() => setIsTranscriptCollapsed((prev) => !prev)}
              >
                {isTranscriptCollapsed ? "Show transcript" : "Collapse"}
              </button>
            </div>
          </div>
          {isTranscriptCollapsed ? (
            <div className="panel-collapsed">Transcript hidden.</div>
          ) : (
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
          )}
        </section>

        <section
          className={`panel summary-panel ${isSummarizing ? "summary-panel--loading" : ""}`}
        >
          <div className="panel-header">
            <div>
              <h2>Summary</h2>
              {isSummarizing ? (
                <span className="pill">Generating summary…</span>
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
                disabled={isSummarizing || isEnhancingSelection || isCleaningTranscript}
              >
                Generate summary
              </button>
              <button
                className="ghost"
                onClick={handleEnhanceSelection}
                disabled={
                  isEnhancingSelection ||
                  selection.field !== "summary"
                }
              >
                Enhance selection
              </button>
            </div>
          </div>
          <div
            className={`summary-body ${isSummarizing ? "summary-body--loading" : ""}`}
          >
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
            {isSummarizing ? (
              <div className="summary-stream" aria-hidden>
                <span>Drafting insights</span>
                <span className="summary-dots">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="summary-caret" />
              </div>
            ) : null}
          </div>
        </section>

        <section className={`panel action-items-panel ${isExtractingActions ? "action-items-panel--loading" : ""}`}>
          <div className="panel-header">
            <div>
              <h2>Action Items</h2>
              {isExtractingActions ? (
                <span className="pill">Extracting actions…</span>
              ) : activeMeeting?.actionItems?.length ? (
                <span className="pill">{activeMeeting.actionItems.length} items</span>
              ) : null}
            </div>
            <div className="panel-actions">
              <button
                className="primary"
                onClick={handleExtractActions}
                disabled={isExtractingActions || isSummarizing || !activeMeeting?.transcript?.trim()}
              >
                Extract actions
              </button>
            </div>
          </div>
          <div className="action-items-body">
            {activeMeeting?.actionItems?.length ? (
              <ul className="action-items-list">
                {activeMeeting.actionItems.map((item) => (
                  <li
                    key={item.id}
                    className={`action-item ${item.status === "completed" ? "action-item--completed" : ""}`}
                  >
                    <label className="action-item-checkbox">
                      <input
                        type="checkbox"
                        checked={item.status === "completed"}
                        onChange={() => toggleActionItem(item.id)}
                      />
                      <span className="checkmark" />
                    </label>
                    <div className="action-item-content">
                      <div className="action-item-task">{item.task}</div>
                      <div className="action-item-meta">
                        {item.assignee && (
                          <span className="action-item-assignee">👤 {item.assignee}</span>
                        )}
                        {item.dueDate && (
                          <span className="action-item-due">📅 {item.dueDate}</span>
                        )}
                        {item.priority && (
                          <span className={`action-item-priority priority-${item.priority.toLowerCase()}`}>
                            {item.priority}
                          </span>
                        )}
                      </div>
                      {item.context && (
                        <div className="action-item-context">{item.context}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="action-items-empty">
                No action items yet. Click "Extract actions" after generating a summary.
              </div>
            )}
          </div>
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
              Config: {config?.transcription?.local?.whisperPath ? "Loaded" : "Missing"}
            </div>
          </div>
        </section>
      </section>

      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="settings-body">
              <section className="settings-section">
                <h3>Transcription</h3>
                <div className="settings-field">
                  <label>Provider</label>
                  <select
                    value={config?.transcription?.provider ?? "local"}
                    onChange={(e) => {
                      const newConfig = {
                        ...config,
                        transcription: {
                          ...config?.transcription,
                          provider: e.target.value as TranscriptionProvider,
                        },
                      };
                      setConfig(newConfig as AppConfig);
                    }}
                  >
                    <option value="local">Local (whisper.cpp)</option>
                    <option value="openai-compatible">OpenAI Compatible API</option>
                    <option value="auto">Auto (local → cloud fallback)</option>
                  </select>
                </div>
                {(config?.transcription?.provider === "openai-compatible" || config?.transcription?.provider === "auto") && (
                  <>
                    <div className="settings-field">
                      <label>API Endpoint</label>
                      <input
                        type="text"
                        value={config?.transcription?.openaiCompatible?.endpoint ?? "https://api.openai.com/v1/audio/transcriptions"}
                        onChange={(e) => {
                          const newConfig = {
                            ...config,
                            transcription: {
                              ...config?.transcription,
                              openaiCompatible: {
                                ...config?.transcription?.openaiCompatible,
                                endpoint: e.target.value,
                              },
                            },
                          };
                          setConfig(newConfig as AppConfig);
                        }}
                        placeholder="https://api.openai.com/v1/audio/transcriptions"
                      />
                    </div>
                    <div className="settings-field">
                      <label>API Key</label>
                      <input
                        type="password"
                        value={config?.transcription?.openaiCompatible?.apiKey ?? ""}
                        onChange={(e) => {
                          const newConfig = {
                            ...config,
                            transcription: {
                              ...config?.transcription,
                              openaiCompatible: {
                                ...config?.transcription?.openaiCompatible,
                                apiKey: e.target.value,
                              },
                            },
                          };
                          setConfig(newConfig as AppConfig);
                        }}
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="settings-field">
                      <label>Model</label>
                      <input
                        type="text"
                        value={config?.transcription?.openaiCompatible?.model ?? "whisper-1"}
                        onChange={(e) => {
                          const newConfig = {
                            ...config,
                            transcription: {
                              ...config?.transcription,
                              openaiCompatible: {
                                ...config?.transcription?.openaiCompatible,
                                model: e.target.value,
                              },
                            },
                          };
                          setConfig(newConfig as AppConfig);
                        }}
                        placeholder="whisper-1"
                      />
                    </div>
                  </>
                )}
              </section>

              <section className="settings-section">
                <h3>Export</h3>
                <div className="settings-field">
                  <label>Default Export Path</label>
                  <input
                    type="text"
                    value={config?.export?.localPath ?? ""}
                    onChange={(e) => {
                      const newConfig = {
                        ...config,
                        export: {
                          ...config?.export,
                          localPath: e.target.value,
                        },
                      };
                      setConfig(newConfig as AppConfig);
                    }}
                    placeholder="~/Documents/voxii-meetings"
                  />
                </div>
              </section>

              <section className="settings-section">
                <h3>Local Whisper</h3>
                <div className="settings-field">
                  <label>Whisper Binary Path</label>
                  <input
                    type="text"
                    value={config?.transcription?.local?.whisperPath ?? ""}
                    onChange={(e) => {
                      const newConfig = {
                        ...config,
                        transcription: {
                          ...config?.transcription,
                          local: {
                            ...config?.transcription?.local,
                            whisperPath: e.target.value,
                          },
                        },
                      };
                      setConfig(newConfig as AppConfig);
                    }}
                    placeholder="Path to whisper binary"
                  />
                </div>
                <div className="settings-field">
                  <label>Models Folder Path</label>
                  <input
                    type="text"
                    value={config?.transcription?.local?.modelPath ?? ""}
                    onChange={(e) => {
                      const newConfig = {
                        ...config,
                        transcription: {
                          ...config?.transcription,
                          local: {
                            ...config?.transcription?.local,
                            modelPath: e.target.value,
                            modelName: "",
                          },
                        },
                      };
                      setConfig(newConfig as AppConfig);
                    }}
                    placeholder="Path to Whisper models folder"
                  />
                </div>
                <div className="settings-field">
                  <label>Language</label>
                  <input
                    type="text"
                    value={config?.transcription?.language ?? "en"}
                    onChange={(e) => {
                      const newConfig = {
                        ...config,
                        transcription: {
                          ...config?.transcription,
                          language: e.target.value,
                        },
                      };
                      setConfig(newConfig as AppConfig);
                    }}
                    placeholder="en"
                  />
                </div>
              </section>
            </div>
            <div className="settings-footer">
              <button className="ghost" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={async () => {
                  if (config) {
                    await invoke("save_config_command", { config });
                    setSettingsOpen(false);
                  }
                }}
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
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
