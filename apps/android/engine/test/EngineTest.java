// Tests der Handy-Engine ohne Android: Encoder, Resampler, Mixer und echte Sendung an Icecast.
// Aufruf über apps/android/engine/test.sh (lädt jump3r, startet Icecast, prüft mit ffprobe).
import app.airdeck.engine.IcecastSource;
import app.airdeck.engine.LiveEngine;
import app.airdeck.engine.Mixer;
import app.airdeck.engine.Mp3Encoder;
import app.airdeck.engine.PcmRing;
import app.airdeck.engine.Resampler;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class EngineTest {
    static int failed;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "  ok  " : "  FEHLER  ") + what);
        if (!ok) failed++;
    }

    static short[] sine(int rate, int channels, double seconds, double freq, double amp) {
        int frames = (int) (rate * seconds);
        short[] s = new short[frames * channels];
        for (int i = 0; i < frames; i++) {
            short v = (short) Math.round(amp * 32767 * Math.sin(2 * Math.PI * freq * i / rate));
            for (int c = 0; c < channels; c++) s[i * channels + c] = v;
        }
        return s;
    }

    public static void main(String[] args) throws Exception {
        String out = args[0];
        int icePort = Integer.parseInt(args[1]);

        System.out.println("Encoder");
        Mp3Encoder enc = new Mp3Encoder(44100, 128, 5);
        short[] tone = sine(44100, 2, 3, 440, 0.5);
        ByteArrayOutputStream mp3 = new ByteArrayOutputStream();
        for (int off = 0; off < tone.length / 2; off += 882) {
            int frames = Math.min(882, tone.length / 2 - off);
            short[] block = new short[frames * 2];
            System.arraycopy(tone, off * 2, block, 0, frames * 2);
            mp3.write(enc.encode(block, frames));
        }
        mp3.write(enc.flush());
        enc.close();
        byte[] data = mp3.toByteArray();
        try (FileOutputStream f = new FileOutputStream(out + "/tone.mp3")) { f.write(data); }
        check(data.length > 40000 && data.length < 60000, "3 s bei 128 kbit/s ergeben ca. 48 kB (" + data.length + " Bytes)");
        check((data[0] & 0xff) == 0xff && (data[1] & 0xe0) == 0xe0, "beginnt mit MP3-Frame-Sync");

        System.out.println("Resampler");
        Resampler rs = new Resampler(48000, 1, 44100);
        short[] in = sine(48000, 1, 1, 1000, 0.5);
        short[] o = new short[rs.maxOut(in.length)];
        int n = 0;
        // in Blöcken wie vom Decoder
        short[] tmp = new short[rs.maxOut(1024)];
        for (int off = 0; off < in.length; off += 1024) {
            int len = Math.min(1024, in.length - off);
            short[] b = new short[len];
            System.arraycopy(in, off, b, 0, len);
            int got = rs.process(b, len, tmp);
            System.arraycopy(tmp, 0, o, n, got);
            n += got;
        }
        int frames = n / 2;
        check(Math.abs(frames - 44100) <= 2, "1 s @48 kHz → " + frames + " Frames @44,1 kHz");
        int crossings = 0;
        for (int i = 1; i < frames; i++) if ((o[2 * (i - 1)] < 0) != (o[2 * i] < 0)) crossings++;
        check(Math.abs(crossings - 2000) <= 4, "Tonhöhe bleibt 1 kHz (" + crossings + " Nulldurchgänge)");
        boolean stereoEqual = true;
        for (int i = 0; i < frames; i++) if (o[2 * i] != o[2 * i + 1]) stereoEqual = false;
        check(stereoEqual, "Mono wird auf beide Kanäle verteilt");

        System.out.println("Mixer");
        Mixer mx = new Mixer();
        short[] block = new short[882 * 2];
        mx.music.writeDropOldest(sine(44100, 2, 0.5, 440, 0.5), 0, 44100);
        mx.mix(block, 882);
        float musicOnly = mx.musicDb();
        check(mx.micDb() <= -90, "Mikro aus: kein Mikrofonsignal");
        mx.setMic(true);
        for (int i = 0; i < 10; i++) {
            mx.mic.writeDropOldest(sine(44100, 2, 0.02, 1000, 0.3), 0, 882 * 2);
            mx.mix(block, 882);
        }
        float ducked = mx.musicDb();
        check(mx.micDb() > -20, "Mikro an: Signal kommt durch (" + mx.micDb() + " dB)");
        check(musicOnly - ducked > 8 && musicOnly - ducked < 12, "Musik wird um ca. 10 dB abgesenkt (" + (musicOnly - ducked) + " dB)");
        PcmRing r = new PcmRing(10);
        r.writeDropOldest(new short[] { 1, 2, 3, 4, 5, 6, 7, 8 }, 0, 8);
        r.writeDropOldest(new short[] { 9, 10, 11, 12 }, 0, 4);
        short[] rr = new short[10];
        int got = r.read(rr, 0, 10);
        check(got == 10 && rr[0] == 3 && rr[9] == 12, "Mikrofon-Puffer verwirft bei Überlauf das Älteste");

        System.out.println("Sendung an Icecast");
        IcecastSource.Config cfg = new IcecastSource.Config();
        cfg.host = "127.0.0.1";
        cfg.port = icePort;
        cfg.mount = "/handy";
        cfg.password = "quelle-geheim";
        cfg.name = "AirDeck Test";
        List<String> states = new ArrayList<>();
        LiveEngine eng = new LiveEngine(cfg, 128, (st, err) -> states.add(st + (err != null ? ":" + err : "")));
        eng.start();
        // Musik wie vom Decoder: blockierend nachfüllen
        Thread feeder = new Thread(() -> {
            short[] t = sine(44100, 2, 1, 440, 0.4);
            try {
                for (int i = 0; i < 12 && eng.isRunning(); i++) if (!eng.mixer.music.writeBlocking(t, 0, t.length)) break;
            } catch (InterruptedException ignored) { }
        });
        feeder.setDaemon(true);
        feeder.start();
        long end = System.currentTimeMillis() + 10000;
        while (!"connected".equals(eng.source().state()) && System.currentTimeMillis() < end) Thread.sleep(50);
        check("connected".equals(eng.source().state()), "verbunden (Zustände: " + states + ")");
        // als Hörer mitschneiden
        ByteArrayOutputStream heard = new ByteArrayOutputStream();
        Thread.sleep(1500);
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + icePort + "/handy").openConnection();
        c.setReadTimeout(5000);
        check(c.getResponseCode() == 200 && String.valueOf(c.getContentType()).startsWith("audio/mpeg"), "Hörer bekommt audio/mpeg");
        try (InputStream is = c.getInputStream()) {
            byte[] buf = new byte[8192];
            long stopAt = System.currentTimeMillis() + 4000;
            int k;
            while (System.currentTimeMillis() < stopAt && (k = is.read(buf)) > 0) heard.write(buf, 0, k);
        }
        c.disconnect();
        try (FileOutputStream f = new FileOutputStream(out + "/heard.mp3")) { f.write(heard.toByteArray()); }
        check(heard.size() > 40000, "Hörer empfängt Daten (" + heard.size() + " Bytes in 4 s)");
        eng.mixer.setMic(true);
        eng.source().updateMetadata("Test – Titelanzeige");
        Thread.sleep(800);
        String status = httpGet("http://127.0.0.1:" + icePort + "/status-json.xsl");
        check(status.contains("Titelanzeige"), "Titelanzeige kommt beim Server an");
        eng.stop();
        check("stopped".equals(eng.source().state()), "sauber beendet");

        System.out.println("Falsches Passwort");
        IcecastSource.Config bad = new IcecastSource.Config();
        bad.host = "127.0.0.1";
        bad.port = icePort;
        bad.mount = "/falsch";
        bad.password = "falsch";
        List<String> badStates = new ArrayList<>();
        IcecastSource src = new IcecastSource(bad, (st, err) -> badStates.add(st + (err != null ? ":" + err : "")));
        src.start();
        Thread.sleep(2500);
        check(badStates.toString().contains("Zugang abgelehnt"), "klare Meldung bei falschem Passwort (" + badStates + ")");
        long attempts = badStates.stream().filter(s -> s.equals("connecting")).count();
        check(attempts == 1, "kein endloses Anklopfen bei falschem Passwort (" + attempts + " Versuch)");
        src.stop();

        System.out.println(failed == 0 ? "ALLE TESTS OK" : failed + " FEHLER");
        System.exit(failed == 0 ? 0 : 1);
    }

    static String httpGet(String u) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        try (InputStream is = c.getInputStream()) {
            return new String(is.readAllBytes(), "UTF-8");
        } finally {
            c.disconnect();
        }
    }
}
