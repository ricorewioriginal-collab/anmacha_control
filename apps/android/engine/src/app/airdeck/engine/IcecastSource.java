// Icecast-Quelle (laut.fm, Icecast 2.x): sendet den MP3-Strom, verbindet sich bei Abbruch selbst neu.
// Protokoll wie libshout: PUT (Icecast ≥ 2.4) mit „Expect: 100-continue“, bei Ablehnung SOURCE (ältere Server).
package app.airdeck.engine;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import javax.net.ssl.SSLSocketFactory;

public final class IcecastSource {
    public static final class Config {
        public String host;
        public int port = 8000;
        public boolean tls;
        public String mount = "/live";
        public String user = "source";
        public String password;
        public String name = "AirDeck";
        public String contentType = "audio/mpeg";
    }

    public interface Listener {
        /** state: connecting | connected | error | stopped */
        void onState(String state, String error);
    }

    /** höchstens so viel ungesendet puffern (ca. 5 s bei 128 kbit/s), sonst verwerfen */
    private static final int MAX_QUEUED = 80 * 1024;

    private final Config cfg;
    private final Listener listener;
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
    private int queued;
    private volatile boolean wanted;
    private volatile Socket socket;
    private Thread thread;
    private volatile String state = "stopped";
    private volatile long bytesSent;
    private volatile long dropped;
    private volatile String lastError;

    public IcecastSource(Config cfg, Listener listener) {
        this.cfg = cfg;
        this.listener = listener;
    }

    public String state() { return state; }
    public long bytesSent() { return bytesSent; }
    public long dropped() { return dropped; }
    public String lastError() { return lastError; }

    public synchronized void start() {
        if (wanted) return;
        wanted = true;
        thread = new Thread(this::run, "airdeck-icecast");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        Thread t;
        synchronized (this) {
            wanted = false;
            t = thread;
            thread = null;
            queue.clear();
            queued = 0;
            notifyAll();
        }
        closeSocket();
        if (t != null) {
            try { t.join(3000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
        set("stopped", null);
    }

    /** Neue Daten anhängen (vom Engine-Thread). Blockiert nie. */
    public synchronized void offer(byte[] data) {
        if (!wanted || data.length == 0) return;
        if (!"connected".equals(state)) return; // während des Verbindens nichts ansammeln
        if (queued + data.length > MAX_QUEUED) {
            dropped += data.length;
            return;
        }
        queue.add(data);
        queued += data.length;
        notifyAll();
    }

    private synchronized byte[] take() throws InterruptedException {
        while (wanted && queue.isEmpty()) wait(1000);
        if (!wanted) return null;
        byte[] b = queue.poll();
        queued -= b.length;
        return b;
    }

    private void run() {
        long delay = 2000;
        while (wanted) {
            try {
                connect();
                delay = 2000;
                OutputStream out = socket.getOutputStream();
                while (wanted) {
                    byte[] b = take();
                    if (b == null) break;
                    out.write(b);
                    bytesSent += b.length;
                }
            } catch (AuthException e) {
                lastError = e.getMessage();
                set("error", e.getMessage());
                // falsches Passwort: nicht endlos anklopfen
                synchronized (this) { wanted = false; }
                break;
            } catch (Exception e) {
                lastError = e.getMessage();
                if (wanted) set("error", e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                closeSocket();
                synchronized (this) {
                    queue.clear();
                    queued = 0;
                }
            }
            if (!wanted) break;
            sleep(delay);
            delay = Math.min(delay * 2, 30000);
        }
    }

    static final class AuthException extends IOException {
        AuthException(String m) { super(m); }
    }

    private void connect() throws IOException {
        set("connecting", null);
        String mount = cfg.mount.startsWith("/") ? cfg.mount : "/" + cfg.mount;
        int code = handshake("PUT " + mount + " HTTP/1.1", true);
        if (code == 400 || code == 405 || code == 501) {
            // Server kennt kein PUT (Icecast < 2.4): klassisches SOURCE-Protokoll
            closeSocket();
            code = handshake("SOURCE " + mount + " ICE/1.0", false);
        }
        if (code == 401 || code == 403) throw new AuthException("Zugang abgelehnt (Benutzer/Passwort prüfen)");
        if (code == 409) throw new IOException("Mountpoint belegt – dort sendet schon jemand");
        if (code != 200 && code != 100) throw new IOException("Server antwortete " + code);
        set("connected", null);
    }

    private int handshake(String requestLine, boolean expectContinue) throws IOException {
        Socket s = cfg.tls ? SSLSocketFactory.getDefault().createSocket() : new Socket();
        socket = s;
        s.connect(new InetSocketAddress(cfg.host, cfg.port), 10000);
        s.setSoTimeout(10000);
        s.setTcpNoDelay(true);
        String auth = base64((cfg.user + ":" + cfg.password).getBytes(StandardCharsets.UTF_8));
        StringBuilder h = new StringBuilder();
        h.append(requestLine).append("\r\n");
        h.append("Host: ").append(cfg.host).append(':').append(cfg.port).append("\r\n");
        h.append("Authorization: Basic ").append(auth).append("\r\n");
        h.append("User-Agent: AirDeck-Android\r\n");
        h.append("Content-Type: ").append(cfg.contentType).append("\r\n");
        h.append("Ice-Public: 0\r\n");
        h.append("Ice-Name: ").append(cfg.name.replaceAll("[\\r\\n]", " ")).append("\r\n");
        if (expectContinue) h.append("Expect: 100-continue\r\n");
        h.append("\r\n");
        OutputStream out = s.getOutputStream();
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        out.flush();
        int code = readStatus(s.getInputStream());
        // danach blockiert nur noch das Schreiben
        s.setSoTimeout(0);
        return code;
    }

    /** Statuszeile und Kopfzeilen lesen, Code zurückgeben. */
    static int readStatus(InputStream in) throws IOException {
        String status = readLine(in);
        if (status == null) throw new IOException("Server hat die Verbindung beendet");
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) { /* Kopfzeilen überspringen */ }
        String[] p = status.split(" ");
        if (p.length < 2) throw new IOException("Unerwartete Antwort: " + status);
        try {
            return Integer.parseInt(p[1].trim());
        } catch (NumberFormatException e) {
            // ältere Server antworten „OK2“ auf SOURCE
            if (status.startsWith("OK")) return 200;
            throw new IOException("Unerwartete Antwort: " + status);
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("Kopfzeile zu lang");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    /** Titelanzeige (Icecast-Admin, nur MP3/AAC). Best effort, eigener Thread. */
    public void updateMetadata(String song) {
        if (!"connected".equals(state) || song == null) return;
        Thread t = new Thread(() -> {
            try {
                String mount = cfg.mount.startsWith("/") ? cfg.mount : "/" + cfg.mount;
                URL url = new URL((cfg.tls ? "https" : "http") + "://" + cfg.host + ":" + cfg.port + "/admin/metadata?mount="
                    + URLEncoder.encode(mount, "UTF-8") + "&mode=updinfo&song=" + URLEncoder.encode(song, "UTF-8"));
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                c.setRequestProperty("Authorization", "Basic " + base64((cfg.user + ":" + cfg.password).getBytes(StandardCharsets.UTF_8)));
                c.getResponseCode();
                c.disconnect();
            } catch (Exception ignored) {
                // Titelanzeige ist nicht kritisch
            }
        }, "airdeck-metadata");
        t.setDaemon(true);
        t.start();
    }

    /** Base64 ohne java.util.Base64 (erst ab Android 8 vorhanden). */
    static String base64(byte[] d) {
        final String t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder sb = new StringBuilder((d.length + 2) / 3 * 4);
        for (int i = 0; i < d.length; i += 3) {
            int b = (d[i] & 0xff) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xff) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xff : 0);
            sb.append(t.charAt(b >> 18 & 63)).append(t.charAt(b >> 12 & 63));
            sb.append(i + 1 < d.length ? t.charAt(b >> 6 & 63) : '=').append(i + 2 < d.length ? t.charAt(b & 63) : '=');
        }
        return sb.toString();
    }

    private void closeSocket() {
        Socket s = socket;
        socket = null;
        if (s != null) {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private void set(String st, String err) {
        state = st;
        if (listener != null) listener.onState(st, err);
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
