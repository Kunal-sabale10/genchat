export interface VoiceRecordingResult {
  blob: Blob;
  durationSec: number;
  waveform: number[];
  mimeType: string;
}

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private animFrameId: number | null = null;
  private sampleIntervalId: any = null;

  private chunks: Blob[] = [];
  private samples: number[] = [];
  private startTime: number = 0;
  private volumeCallback: ((volume: number) => void) | null = null;

  public static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  public onVolume(cb: (volume: number) => void): void {
    this.volumeCallback = cb;
  }

  public async start(): Promise<void> {
    if (!VoiceRecorder.isSupported()) {
      throw new Error('Audio recording is not supported in this browser.');
    }

    this.chunks = [];
    this.samples = [];

    // 1. Request microphone stream with noise suppression & echo cancellation
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 2. Set up Web Audio Analyser for live visualizer and waveform extraction
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtx();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.4;
      this.sourceNode.connect(this.analyserNode);

      const bufferLength = this.analyserNode.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      // Periodically sample volume (every ~60ms)
      this.sampleIntervalId = setInterval(() => {
        if (!this.analyserNode) return;
        this.analyserNode.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / (bufferLength * 255);
        // Normalize with a dynamic curve for vibrant visualizer movement
        const vol = Math.min(1.0, Math.max(0.08, avg * 2.8));
        this.samples.push(vol);

        if (this.volumeCallback) {
          this.volumeCallback(vol);
        }
      }, 60);
    } catch (e) {
      console.warn('[VoiceRecorder] Web Audio API analyser setup failed, proceeding with basic recording:', e);
    }

    // 3. Select best supported codec
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else {
        mimeType = '';
      }
    }

    const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, options);

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    this.startTime = Date.now();
    this.mediaRecorder.start(200); // 200ms chunk timeslice
  }

  public stop(): Promise<VoiceRecordingResult> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        return reject(new Error('Recorder is not active.'));
      }

      this.mediaRecorder.onstop = () => {
        const rawDuration = (Date.now() - this.startTime) / 1000;
        const durationSec = Math.max(1, Math.round(rawDuration));
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });

        // Normalize samples into exactly 32 bars (0.1 to 1.0)
        const waveform = this.normalizeWaveform(this.samples, 32);

        this.cleanup();
        resolve({
          blob,
          durationSec,
          waveform,
          mimeType,
        });
      };

      try {
        if (this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        }
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  public cancel(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {}
    }
    this.cleanup();
    this.chunks = [];
    this.samples = [];
  }

  private cleanup(): void {
    if (this.sampleIntervalId) {
      clearInterval(this.sampleIntervalId);
      this.sampleIntervalId = null;
    }
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    // Stop all media tracks to turn off hardware mic indicator
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    // Close AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.sourceNode = null;
    this.volumeCallback = null;
  }

  /**
   * Resamples raw amplitude samples to a fixed count of normalized bars (default 32)
   */
  private normalizeWaveform(rawSamples: number[], targetBars = 32): number[] {
    if (!rawSamples || rawSamples.length === 0) {
      // Return a balanced default waveform if no samples collected
      return Array.from({ length: targetBars }, (_, i) => {
        const x = i / (targetBars - 1);
        return Math.round((0.2 + 0.5 * Math.sin(x * Math.PI)) * 100) / 100;
      });
    }

    const result: number[] = [];
    const bucketSize = rawSamples.length / targetBars;

    for (let i = 0; i < targetBars; i++) {
      const startIdx = Math.floor(i * bucketSize);
      const endIdx = Math.min(rawSamples.length, Math.floor((i + 1) * bucketSize));
      let maxVal = 0.15;

      for (let j = startIdx; j < endIdx; j++) {
        if (rawSamples[j] > maxVal) {
          maxVal = rawSamples[j];
        }
      }

      // Clamp between 0.15 and 1.0, formatted to 2 decimal places
      const normalized = Math.min(1.0, Math.max(0.15, Math.round(maxVal * 100) / 100));
      result.push(normalized);
    }

    return result;
  }
}
