// Ringpuffer für Stereo-PCM (16 Bit). Mikrofon: bei Überlauf ältestes verwerfen (Latenz klein halten).
// Musik: Decoder wartet, bis Platz frei ist (liest nur so schnell wie gesendet wird).
package app.airdeck.engine;

public final class PcmRing {
    private final short[] buf;
    private int read;
    private int size;
    private boolean closed;

    /** @param capacitySamples Anzahl Samples (Frames × Kanäle) */
    public PcmRing(int capacitySamples) {
        buf = new short[capacitySamples];
    }

    public synchronized int available() {
        return size;
    }

    public int capacity() {
        return buf.length;
    }

    /** Schreiben; bei Überlauf wird das Älteste überschrieben. */
    public synchronized void writeDropOldest(short[] src, int off, int len) {
        if (len >= buf.length) {
            off += len - buf.length;
            len = buf.length;
        }
        int overflow = size + len - buf.length;
        if (overflow > 0) {
            read = (read + overflow) % buf.length;
            size -= overflow;
        }
        put(src, off, len);
        notifyAll();
    }

    /** Schreiben und warten, bis Platz ist. Liefert false, wenn der Puffer geschlossen wurde. */
    public synchronized boolean writeBlocking(short[] src, int off, int len) throws InterruptedException {
        while (len > 0) {
            while (!closed && size == buf.length) wait();
            if (closed) return false;
            int n = Math.min(len, buf.length - size);
            put(src, off, n);
            off += n;
            len -= n;
            notifyAll();
        }
        return true;
    }

    private void put(short[] src, int off, int len) {
        int w = (read + size) % buf.length;
        int first = Math.min(len, buf.length - w);
        System.arraycopy(src, off, buf, w, first);
        if (first < len) System.arraycopy(src, off + first, buf, 0, len - first);
        size += len;
    }

    /** Liest bis zu len Samples; fehlende bleiben unverändert. Liefert die Anzahl gelesener Samples. */
    public synchronized int read(short[] dst, int off, int len) {
        int n = Math.min(len, size);
        int first = Math.min(n, buf.length - read);
        System.arraycopy(buf, read, dst, off, first);
        if (first < n) System.arraycopy(buf, 0, dst, off + first, n - first);
        read = (read + n) % buf.length;
        size -= n;
        if (n > 0) notifyAll();
        return n;
    }

    /** Leeren und wartende Schreiber lösen (z. B. Titel gestoppt). */
    public synchronized void clear() {
        read = 0;
        size = 0;
        notifyAll();
    }

    public synchronized void close() {
        closed = true;
        notifyAll();
    }

    public synchronized void reopen() {
        closed = false;
        read = 0;
        size = 0;
    }
}
