// Vordergrund-Dienst: hält die Sendung am Leben (Benachrichtigung „AirDeck sendet live“ mit Beenden-Knopf).
package app.airdeck.engine.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public final class EngineService extends Service {
    static final String EXTRA_MIC = "mic";
    private static final String ACTION_STOP = "app.airdeck.engine.STOP";
    private static final String CHANNEL = "airdeck-live";
    private static final int ID = 7310;

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            EngineHub.get(this).stop();
            stopSelf();
            return START_NOT_STICKY;
        }
        boolean mic = intent != null && intent.getBooleanExtra(EXTRA_MIC, false);
        Notification n = notification();
        if (Build.VERSION.SDK_INT >= 30) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK | (mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
            startForeground(ID, n, type);
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(ID, n);
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Live-Sendung", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Zeigt an, solange AirDeck vom Handy sendet");
                nm.createNotificationChannel(ch);
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) b.setContentIntent(PendingIntent.getActivity(this, 0, open, flags));
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, EngineService.class).setAction(ACTION_STOP), flags);
        b.addAction(new Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_media_pause), "Sendung beenden", stop).build());
        return b.setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("AirDeck sendet live")
            .setContentText("Tippen zum Öffnen – Sendung läuft auch bei ausgeschaltetem Bildschirm")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void acquireLocks() {
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AirDeck:live");
            wake.setReferenceCounted(false);
            wake.acquire(12 * 60 * 60 * 1000L); // spätestens nach 12 h freigeben
        }
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, "AirDeck:live");
                wifi.setReferenceCounted(false);
                wifi.acquire();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null;
        wifi = null;
        super.onDestroy();
    }
}
