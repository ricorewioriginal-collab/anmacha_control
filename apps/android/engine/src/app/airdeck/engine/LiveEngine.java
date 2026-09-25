// Sende-Engine des Handys: mischt im Echtzeit-Takt, kodiert MP3 und schickt es an den Sender.
// Läuft ohne AirDeck-Server (z. B. unterwegs direkt zu laut.fm oder Icecast).
package app.airdeck.engine;

public final class LiveEngine {
    public static final int BLOCK_MS = 20;

    public interface Listener {
        void onState(String state, String error);
    }

    /** Abgriff des gemischten Signals, z. B. zum Mithören auf dem Handy */
    public interface PcmTap {
        void onPcm(short[] block, int frames);
    }

    /** Mithören: wird im Engine-Takt aufgerufen und darf nicht blockieren */
    public volatile PcmTap tap;

    public final Mixer mixer = new Mixer();
    private final IcecastSource.Config cfg;
    private final int bitrate;
    private final Listener listener;
    private IcecastSource source;
    private Thread thread;
    private volatile boolean running;
    private volatile long startedAt;

    public LiveEngine(IcecastSource.Config cfg, int bitrateKbps, Listener listener) {
        this.cfg = cfg;
        this.bitrate = bitrateKbps;
        this.listener = listener;
    }

    public boolean isRunning() { return running; }
    public long startedAt() { return startedAt; }
    public IcecastSource source() { return source; }

    public synchronized void start() {
        if (running) return;
        running = true;
        startedAt = System.currentTimeMillis();
        source = new IcecastSource(cfg, (st, err) -> { if (listener != null) listener.onState(st, err); });
        source.start();
        thread = new Thread(this::loop, "airdeck-engine");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        Thread t;
        synchronized (this) {
            if (!running) return;
            running = false;
            t = thread;
            thread = null;
        }
        if (t != null) {
            try { t.join(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
        if (source != null) source.stop();
        startedAt = 0;
    }

    /** Takt wie bei der Server-Engine: nach Uhr mischen, nicht nach Datenmenge (sonst driftet der Stream). */
    private void loop() {
        Mp3Encoder enc = new Mp3Encoder(Mixer.RATE, bitrate, 5);
        short[] block = new short[Mixer.RATE * Mixer.CHANNELS];
        long t0 = System.nanoTime();
        long framesOut = 0;
        try {
            while (running) {
                long due = (System.nanoTime() - t0) * Mixer.RATE / 1_000_000_000L - framesOut;
                if (due > Mixer.RATE * 2L) {
                    // hing (z. B. Energiesparmodus): nicht nachholen, neu takten
                    framesOut += due - Mixer.RATE * BLOCK_MS / 1000;
                    due = Mixer.RATE * BLOCK_MS / 1000;
                }
                if (due < Mixer.RATE * BLOCK_MS / 1000) {
                    Thread.sleep(5);
                    continue;
                }
                int frames = (int) Math.min(due, Mixer.RATE / 2);
                mixer.mix(block, frames);
                framesOut += frames;
                PcmTap t = tap;
                if (t != null) t.onPcm(block, frames);
                byte[] mp3 = enc.encode(block, frames);
                if (mp3.length > 0) source.offer(mp3);
            }
            byte[] tail = enc.flush();
            if (tail.length > 0) source.offer(tail);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            if (listener != null) listener.onState("error", "Engine: " + e.getMessage());
        } finally {
            enc.close();
        }
    }
}
