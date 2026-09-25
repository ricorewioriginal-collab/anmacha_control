// Steuerzentrale der Handy-Engine (eine pro App): Sendung, Mikrofon, Titelliste, Mithören, Zustand.
package app.airdeck.engine.android;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.net.Uri;
import android.os.Build;

import java.util.ArrayList;
import java.util.List;

import app.airdeck.engine.IcecastSource;
import app.airdeck.engine.LiveEngine;
import app.airdeck.engine.Mixer;

final class EngineHub {
    static final class Track {
        final String uri;
        final String title;

        Track(String uri, String title) {
            this.uri = uri;
            this.title = title;
        }
    }

    private static EngineHub instance;

    static synchronized EngineHub get(Context ctx) {
        if (instance == null) instance = new EngineHub(ctx.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final SharedPreferences prefs;
    private LiveEngine engine;
    private MicInput mic;
    private TrackPlayer player;
    private AudioTrack monitor;
    private final List<Track> playlist = new ArrayList<>();
    private int current = -1;
    private volatile String state = "stopped";
    private volatile String error;
    private boolean autoNext = true;

    private EngineHub(Context ctx) {
        this.ctx = ctx;
        this.prefs = ctx.getSharedPreferences("airdeck-engine", Context.MODE_PRIVATE);
    }

    // ---------- Einstellungen (Passwort bleibt in der App, geht nie zurück an die Oberfläche) ----------

    SharedPreferences prefs() {
        return prefs;
    }

    IcecastSource.Config config() {
        IcecastSource.Config c = new IcecastSource.Config();
        c.host = prefs.getString("host", "");
        c.port = prefs.getInt("port", 8000);
        c.tls = prefs.getBoolean("tls", false);
        c.mount = prefs.getString("mount", "/live");
        c.user = prefs.getString("user", "source");
        c.password = prefs.getString("password", "");
        c.name = prefs.getString("name", "AirDeck");
        return c;
    }

    int bitrate() {
        return prefs.getInt("bitrate", 128);
    }

    // ---------- Sendung ----------

    synchronized boolean running() {
        return engine != null && engine.isRunning();
    }

    synchronized void start(boolean withMicPermission) {
        if (running()) return;
        IcecastSource.Config c = config();
        if (c.host.isEmpty() || c.password.isEmpty()) throw new IllegalStateException("Bitte zuerst Server und Passwort eintragen");
        error = null;
        engine = new LiveEngine(c, bitrate(), (st, err) -> {
            state = st;
            if (err != null) error = err;
        });
        engine.mixer.setMicGainDb(prefs.getFloat("micDb", 0));
        engine.mixer.setMusicGainDb(prefs.getFloat("musicDb", 0));
        engine.mixer.setDuckDb(prefs.getFloat("duckDb", -10));
        // Vordergrund-Dienst hält die Sendung am Leben (auch bei ausgeschaltetem Bildschirm)
        Intent i = new Intent(ctx, EngineService.class).putExtra(EngineService.EXTRA_MIC, withMicPermission);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
        engine.start();
        if (withMicPermission) {
            mic = new MicInput(engine.mixer.mic);
            try {
                mic.start();
            } catch (RuntimeException e) {
                mic = null;
                error = e.getMessage();
            }
        }
        if (prefs.getBoolean("monitor", false)) setMonitor(true);
    }

    synchronized void stop() {
        stopTrack();
        setMonitor(false);
        if (mic != null) {
            mic.stop();
            mic = null;
        }
        if (engine != null) {
            engine.stop();
            engine = null;
        }
        state = "stopped";
        ctx.stopService(new Intent(ctx, EngineService.class));
    }

    synchronized void setMic(boolean on) {
        if (engine == null) throw new IllegalStateException("Erst die Sendung starten");
        if (on && mic == null) throw new IllegalStateException("Kein Mikrofon (Berechtigung fehlt oder belegt)");
        engine.mixer.setMic(on);
    }

    synchronized void setLevels(Float micDb, Float musicDb, Float duckDb) {
        SharedPreferences.Editor e = prefs.edit();
        if (micDb != null) e.putFloat("micDb", micDb);
        if (musicDb != null) e.putFloat("musicDb", musicDb);
        if (duckDb != null) e.putFloat("duckDb", duckDb);
        e.apply();
        if (engine == null) return;
        if (micDb != null) engine.mixer.setMicGainDb(micDb);
        if (musicDb != null) engine.mixer.setMusicGainDb(musicDb);
        if (duckDb != null) engine.mixer.setDuckDb(duckDb);
    }

    /** Mithören über Kopfhörer (bei Lautsprecher und offenem Mikrofon droht Rückkopplung). */
    synchronized void setMonitor(boolean on) {
        prefs.edit().putBoolean("monitor", on).apply();
        if (!on) {
            if (engine != null) engine.tap = null;
            if (monitor != null) {
                monitor.pause();
                monitor.flush();
                monitor.release();
                monitor = null;
            }
            return;
        }
        if (engine == null || monitor != null) return;
        int min = AudioTrack.getMinBufferSize(Mixer.RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack t = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(Mixer.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(Math.max(min, Mixer.RATE)) // ca. 0,25 s
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
        t.play();
        monitor = t;
        engine.tap = (block, frames) -> t.write(block, 0, frames * Mixer.CHANNELS, AudioTrack.WRITE_NON_BLOCKING);
    }

    // ---------- Titel ----------

    synchronized void addTracks(List<Track> tracks) {
        playlist.addAll(tracks);
    }

    synchronized void clearPlaylist() {
        stopTrack();
        playlist.clear();
        current = -1;
    }

    synchronized void removeTrack(int index) {
        if (index < 0 || index >= playlist.size()) return;
        if (index == current) stopTrack();
        playlist.remove(index);
        if (current > index) current--;
        else if (current == index) current = -1;
    }

    synchronized void setAutoNext(boolean on) {
        autoNext = on;
    }

    synchronized void play(int index) {
        if (engine == null) throw new IllegalStateException("Erst die Sendung starten");
        if (index < 0 || index >= playlist.size()) throw new IllegalArgumentException("Titel nicht in der Liste");
        stopTrack();
        current = index;
        Track t = playlist.get(index);
        player = new TrackPlayer(ctx, Uri.parse(t.uri), t.title, engine.mixer.music, this::onTrackEnded);
        player.start();
        engine.source().updateMetadata(t.title);
    }

    synchronized void stopTrack() {
        if (player != null) {
            player.stop();
            player = null;
        }
    }

    private synchronized void onTrackEnded(TrackPlayer p, String err) {
        if (p != player) return;
        player = null;
        if (err != null) error = err;
        // AutoDJ auf dem Handy: nächster Titel der Liste
        if (autoNext && engine != null && current + 1 < playlist.size()) play(current + 1);
    }

    // ---------- Zustand für die Oberfläche ----------

    synchronized Status status() {
        Status s = new Status();
        s.running = running();
        s.state = state;
        s.error = error;
        s.micAvailable = mic != null;
        s.monitor = monitor != null;
        s.autoNext = autoNext;
        if (engine != null) {
            s.micOn = engine.mixer.isMicOn();
            s.micDb = engine.mixer.micDb();
            s.musicDb = engine.mixer.musicDb();
            s.masterDb = engine.mixer.masterDb();
            s.peakDb = engine.mixer.peakDb();
            s.startedAt = engine.startedAt();
            s.bytesSent = engine.source() == null ? 0 : engine.source().bytesSent();
            s.dropped = engine.source() == null ? 0 : engine.source().dropped();
        }
        s.current = player == null ? -1 : current;
        if (player != null) {
            s.positionMs = player.positionMs();
            s.durationMs = player.durationMs();
        }
        s.playlist = new ArrayList<>(playlist);
        return s;
    }

    static final class Status {
        boolean running;
        String state;
        String error;
        boolean micAvailable;
        boolean micOn;
        boolean monitor;
        boolean autoNext;
        float micDb = -90;
        float musicDb = -90;
        float masterDb = -90;
        float peakDb = -90;
        long startedAt;
        long bytesSent;
        long dropped;
        int current = -1;
        long positionMs;
        long durationMs = -1;
        List<Track> playlist;
    }
}
