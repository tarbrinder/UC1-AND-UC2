import { useState, useRef, useEffect } from 'react';
import { Square, X, AlertCircle } from 'lucide-react';

interface Props {
  onRecordingComplete: (blob: Blob, duration: number) => void;
  onCancel: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const MAX_DURATION = 60;
const WAVE_BARS = 5;
const WAVE_DELAYS = ['0s', '0.1s', '0.2s', '0.15s', '0.05s'];

export default function VoiceRecorder({ onRecordingComplete, onCancel }: Props) {
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    let localElapsed = 0;

    async function init() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        const mr = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = mr;
        chunksRef.current = [];

        mr.ondataavailable = e => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        mr.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          onRecordingComplete(blob, localElapsed);
          stream.getTracks().forEach(t => t.stop());
        };

        mr.start(250);
        setRecording(true);

        // Start timer
        timerRef.current = setInterval(() => {
          localElapsed += 1;
          setElapsed(localElapsed);
          if (localElapsed >= MAX_DURATION) {
            clearInterval(timerRef.current!);
            timerRef.current = null;
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              mediaRecorderRef.current.stop();
            }
          }
        }, 1000);

      } catch {
        if (!cancelled) setPermissionDenied(true);
      }
    }

    init();

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        // Don't call onstop handler if unmounting/cancelled
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleStop() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }

  function handleCancel() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    onCancel();
  }

  if (permissionDenied) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-red-500" />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-700">Microphone access denied</p>
          <p className="text-xs text-gray-400 mt-1">
            Please allow microphone access in your browser settings and try again.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-1 px-4 py-2 rounded-lg text-sm text-gray-500 border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5 py-6 px-4">
      {/* Status row */}
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
        <span className="text-sm font-semibold text-gray-700">
          {recording ? 'Recording...' : 'Starting...'}
        </span>
        <span className="text-sm font-mono text-gray-500">{formatTime(elapsed)}</span>
      </div>

      {/* Waveform bars */}
      <div className="flex items-end gap-1 h-8">
        {Array.from({ length: WAVE_BARS }).map((_, i) => (
          <div
            key={i}
            className="w-1.5 rounded-full bg-teal-500 animate-voice-bar"
            style={{
              animationDelay: WAVE_DELAYS[i],
              minHeight: '4px',
            }}
          />
        ))}
      </div>

      {/* Stop & Cancel buttons */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleCancel}
          className="w-10 h-10 rounded-full flex items-center justify-center border border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-all"
          aria-label="Cancel recording"
        >
          <X className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={handleStop}
          className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg animate-glow-ring transition-colors"
          aria-label="Stop recording"
        >
          <Square className="w-6 h-6 fill-white" />
        </button>
      </div>

      <p className="text-xs text-gray-400">Max {MAX_DURATION}s · Tap stop when done</p>
    </div>
  );
}
