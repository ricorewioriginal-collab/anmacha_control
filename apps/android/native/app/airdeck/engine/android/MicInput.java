// Mikrofon des Handys → Mischpult (44,1 kHz; Mono-Mikrofone werden auf beide Kanäle gelegt).
package app.airdeck.engine.android;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import app.airdeck.engine.Mixer;
import app.airdeck.engine.PcmRing;
import app.airdeck.engine.Resampler;

final class MicInput {
    private final PcmRing target;
    private AudioRecord rec;
    private Thread thread;
    private volatile boolean running;

    MicInput(PcmRing target) {
        this.target = target;
    }

    boolean isRunning() {
        return running;
    }

    /** Aufnahme starten. Voraussetzung: Berechtigung RECORD_AUDIO. */
    @SuppressWarnings("MissingPermission")
    synchronized void start() {
        if (running) return;
        int rate = Mixer.RATE;
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) throw new IllegalStateException("Mikrofon unterstützt 44,1 kHz nicht");
        AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate / 5 * 2));
        if (r.getState() != AudioRecord.STATE_INITIALIZED) {
            r.release();
            throw new IllegalStateException("Mikrofon nicht verfügbar (von einer anderen App belegt?)");
        }
        rec = r;
        running = true;
        r.startRecording();
        thread = new Thread(() -> {
            Resampler toStereo = new Resampler(rate, 1, rate);
            short[] in = new short[rate / 50];
            short[] out = new short[toStereo.maxOut(in.length)];
            while (running) {
                int n = r.read(in, 0, in.length);
                if (n <= 0) continue;
                int m = toStereo.process(in, n, out);
                target.writeDropOldest(out, 0, m);
            }
        }, "airdeck-mic");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    synchronized void stop() {
        if (!running) return;
        running = false;
        try {
            rec.stop();
        } catch (IllegalStateException ignored) {
            // bereits gestoppt
        }
        try {
            if (thread != null) thread.join(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        rec.release();
        rec = null;
        thread = null;
        target.clear();
    }
}
