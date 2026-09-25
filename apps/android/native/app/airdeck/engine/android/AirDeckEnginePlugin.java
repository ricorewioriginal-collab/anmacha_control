// Brücke zwischen App-Oberfläche und Handy-Engine (Capacitor-Plugin „AirDeckEngine“).
package app.airdeck.engine.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "AirDeckEngine",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
    }
)
public class AirDeckEnginePlugin extends Plugin {
    private EngineHub hub() {
        return EngineHub.get(getContext());
    }

    /** Gespeicherte Einstellungen (ohne Passwort, nur ob eins hinterlegt ist). */
    @PluginMethod
    public void getConfig(PluginCall call) {
        android.content.SharedPreferences p = hub().prefs();
        JSObject r = new JSObject();
        r.put("host", p.getString("host", ""));
        r.put("port", p.getInt("port", 8000));
        r.put("tls", p.getBoolean("tls", false));
        r.put("mount", p.getString("mount", "/live"));
        r.put("user", p.getString("user", "source"));
        r.put("name", p.getString("name", "AirDeck"));
        r.put("bitrate", p.getInt("bitrate", 128));
        r.put("hasPassword", !p.getString("password", "").isEmpty());
        r.put("micDb", p.getFloat("micDb", 0));
        r.put("musicDb", p.getFloat("musicDb", 0));
        r.put("duckDb", p.getFloat("duckDb", -10));
        r.put("monitor", p.getBoolean("monitor", false));
        call.resolve(r);
    }

    @PluginMethod
    public void saveConfig(PluginCall call) {
        String host = call.getString("host", "").trim();
        int port = call.getInt("port", 8000);
        int bitrate = call.getInt("bitrate", 128);
        if (host.isEmpty() || host.contains("/") || host.contains(" ")) {
            call.reject("Server: nur der Name, z. B. stream.example.org");
            return;
        }
        if (port < 1 || port > 65535) {
            call.reject("Port 1–65535");
            return;
        }
        if (bitrate != 64 && bitrate != 96 && bitrate != 128 && bitrate != 160 && bitrate != 192 && bitrate != 256 && bitrate != 320) {
            call.reject("Bitrate: 64, 96, 128, 160, 192, 256 oder 320 kbit/s");
            return;
        }
        String mount = call.getString("mount", "/live").trim();
        android.content.SharedPreferences.Editor e = hub().prefs().edit()
            .putString("host", host)
            .putInt("port", port)
            .putBoolean("tls", Boolean.TRUE.equals(call.getBoolean("tls", false)))
            .putString("mount", mount.startsWith("/") ? mount : "/" + mount)
            .putString("user", call.getString("user", "source").trim())
            .putString("name", call.getString("name", "AirDeck").trim())
            .putInt("bitrate", bitrate);
        String pw = call.getString("password", "");
        if (pw != null && !pw.isEmpty()) e.putString("password", pw);
        e.apply();
        getConfig(call);
    }

    /** Sendung starten; fragt vorher nach Mikrofon (ohne Mikrofon geht es nur mit Musik). */
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        doStart(call, true);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        doStart(call, getPermissionState("microphone") == PermissionState.GRANTED);
    }

    private void doStart(PluginCall call, boolean mic) {
        try {
            hub().start(mic);
            if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
                // Benachrichtigung ist optional – Sendung läuft auch ohne
                requestPermissionForAlias("notifications", call, "statusAfterPermission");
                return;
            }
            call.resolve(statusJson());
        } catch (RuntimeException e) {
            call.reject(e.getMessage());
        }
    }

    @PermissionCallback
    private void statusAfterPermission(PluginCall call) {
        call.resolve(statusJson());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        hub().stop();
        call.resolve(statusJson());
    }

    @PluginMethod
    public void setMic(PluginCall call) {
        try {
            hub().setMic(Boolean.TRUE.equals(call.getBoolean("on", false)));
            call.resolve(statusJson());
        } catch (RuntimeException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void setLevels(PluginCall call) {
        hub().setLevels(call.getFloat("micDb"), call.getFloat("musicDb"), call.getFloat("duckDb"));
        call.resolve(statusJson());
    }

    @PluginMethod
    public void setMonitor(PluginCall call) {
        hub().setMonitor(Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve(statusJson());
    }

    @PluginMethod
    public void setAutoNext(PluginCall call) {
        hub().setAutoNext(Boolean.TRUE.equals(call.getBoolean("on", true)));
        call.resolve(statusJson());
    }

    /** Titel vom Handy auswählen (Systemdialog) und an die Liste anhängen. */
    @PluginMethod
    public void pickTracks(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("audio/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "tracksPicked");
    }

    @ActivityCallback
    private void tracksPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.resolve(statusJson());
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        List<EngineHub.Track> tracks = new ArrayList<>();
        for (Uri u : uris) {
            try {
                // Zugriff dauerhaft behalten (auch nach Neustart der App)
                getContext().getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // nicht jeder Anbieter erlaubt das – für diese Sitzung reicht es
            }
            tracks.add(new EngineHub.Track(u.toString(), displayName(u)));
        }
        hub().addTracks(tracks);
        call.resolve(statusJson());
    }

    private String displayName(Uri u) {
        try (Cursor c = getContext().getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null) return n.replaceAll("\\.[A-Za-z0-9]{2,4}$", "");
            }
        } catch (RuntimeException ignored) {
            // Name nicht lesbar
        }
        String last = u.getLastPathSegment();
        return last == null ? "Titel" : last;
    }

    @PluginMethod
    public void play(PluginCall call) {
        try {
            hub().play(call.getInt("index", 0));
            call.resolve(statusJson());
        } catch (RuntimeException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stopTrack(PluginCall call) {
        hub().stopTrack();
        call.resolve(statusJson());
    }

    @PluginMethod
    public void removeTrack(PluginCall call) {
        hub().removeTrack(call.getInt("index", -1));
        call.resolve(statusJson());
    }

    @PluginMethod
    public void clearTracks(PluginCall call) {
        hub().clearPlaylist();
        call.resolve(statusJson());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusJson());
    }

    private JSObject statusJson() {
        EngineHub.Status s = hub().status();
        JSObject r = new JSObject();
        r.put("running", s.running);
        r.put("state", s.state);
        r.put("error", s.error);
        r.put("micAvailable", s.micAvailable);
        r.put("micOn", s.micOn);
        r.put("monitor", s.monitor);
        r.put("autoNext", s.autoNext);
        r.put("micDb", s.micDb);
        r.put("musicDb", s.musicDb);
        r.put("masterDb", s.masterDb);
        r.put("peakDb", s.peakDb);
        r.put("startedAt", s.startedAt);
        r.put("bytesSent", s.bytesSent);
        r.put("dropped", s.dropped);
        r.put("current", s.current);
        r.put("positionMs", s.positionMs);
        r.put("durationMs", s.durationMs);
        JSArray list = new JSArray();
        for (EngineHub.Track t : s.playlist) {
            JSObject o = new JSObject();
            o.put("title", t.title);
            list.put(o);
        }
        r.put("playlist", list);
        return r;
    }
}
