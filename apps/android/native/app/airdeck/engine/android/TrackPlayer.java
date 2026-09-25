// Titel vom Handy dekodieren (MediaExtractor/MediaCodec: MP3, AAC, FLAC, OGG, WAV …) und ins Mischpult geben.
// Der Decoder liest nur so schnell, wie gesendet wird (blockierender Ringpuffer).
package app.airdeck.engine.android;

import android.content.Context;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import app.airdeck.engine.Mixer;
import app.airdeck.engine.PcmRing;
import app.airdeck.engine.Resampler;

final class TrackPlayer {
    interface Listener {
        /** Titel zu Ende (natürlich) oder Fehler (error != null) */
        void onEnded(TrackPlayer p, String error);
    }

    final Uri uri;
    final String title;
    private final Context ctx;
    private final PcmRing target;
    private final Listener listener;
    private Thread thread;
    private volatile boolean stopped;
    private volatile long durationMs = -1;
    private volatile long framesWritten;

    TrackPlayer(Context ctx, Uri uri, String title, PcmRing target, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.uri = uri;
        this.title = title;
        this.target = target;
        this.listener = listener;
    }

    long durationMs() {
        return durationMs;
    }

    /** Hörbare Position: geschrieben minus noch im Puffer liegend. */
    long positionMs() {
        long frames = framesWritten - target.available() / Mixer.CHANNELS;
        return Math.max(0, frames * 1000 / Mixer.RATE);
    }

    void start() {
        thread = new Thread(this::run, "airdeck-track");
        thread.start();
    }

    /** Sofort anhalten (Puffer wird geleert). */
    void stop() {
        stopped = true;
        target.close();
        if (thread != null) {
            try {
                thread.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        target.reopen();
    }

    private void run() {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        String error = null;
        try {
            ex.setDataSource(ctx, uri, null);
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    fmt = f;
                    break;
                }
            }
            if (track < 0) throw new IllegalStateException("Keine Tonspur gefunden");
            ex.selectTrack(track);
            if (fmt.containsKey(MediaFormat.KEY_DURATION)) durationMs = fmt.getLong(MediaFormat.KEY_DURATION) / 1000;
            codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
            codec.configure(fmt, null, null, 0);
            codec.start();

            int rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            Resampler rs = new Resampler(rate, channels, Mixer.RATE);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            short[] pcm = new short[0];
            short[] out = new short[0];
            while (!stopped) {
                if (!inputDone) {
                    int in = codec.dequeueInputBuffer(10_000);
                    if (in >= 0) {
                        ByteBuffer b = codec.getInputBuffer(in);
                        int n = b == null ? -1 : ex.readSampleData(b, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(in, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int outIdx = codec.dequeueOutputBuffer(info, 10_000);
                if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    rs = new Resampler(rate, channels, Mixer.RATE);
                    continue;
                }
                if (outIdx < 0) continue;
                ByteBuffer ob = codec.getOutputBuffer(outIdx);
                int samples = info.size / 2;
                if (ob != null && samples > 0) {
                    if (pcm.length < samples) pcm = new short[samples];
                    ob.position(info.offset);
                    ob.limit(info.offset + info.size);
                    ob.order(ByteOrder.nativeOrder()).asShortBuffer().get(pcm, 0, samples);
                    int frames = samples / channels;
                    int need = rs.maxOut(frames);
                    if (out.length < need) out = new short[need];
                    int m = rs.process(pcm, frames, out);
                    codec.releaseOutputBuffer(outIdx, false);
                    if (!target.writeBlocking(out, 0, m)) break;
                    framesWritten += m / Mixer.CHANNELS;
                } else {
                    codec.releaseOutputBuffer(outIdx, false);
                }
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
            }
            // Rest im Puffer ausspielen lassen
            while (!stopped && target.available() > 0) Thread.sleep(50);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            error = "Titel nicht abspielbar: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            if (codec != null) {
                try { codec.stop(); } catch (Exception ignored) { }
                codec.release();
            }
            ex.release();
        }
        if (!stopped && listener != null) listener.onEnded(this, error);
    }
}
