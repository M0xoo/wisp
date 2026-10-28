package dev.trywisp.mobile;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Runs while a machine is connected, over SSH or as a cloud computer (WispSshPlugin.stayOpen).
 * Without it Android freezes the app a few seconds after it leaves the screen: the tunnel and
 * wisp's live stream drop, and the page can't post a notification when a task finishes or asks.
 * Its own notification (low importance, no sound) says which machine.
 */
public class TunnelService extends Service {
    private static final String EXTRA_NAME = "name";
    private static final int ID = 1;
    private static volatile String running; // the machine's name while started
    private static final Object lock = new Object();
    private static int pending; // starts whose onStartCommand hasn't run yet
    private static boolean stopWhenStarted;

    static void start(Context ctx, String name) {
        Intent i = new Intent(ctx, TunnelService.class).putExtra(EXTRA_NAME, name);
        synchronized (lock) {
            try {
                ContextCompat.startForegroundService(ctx, i);
                pending++;
                stopWhenStarted = false;
            } catch (RuntimeException e) {
                // Not allowed from the background (a reconnect): the tunnel still works while open.
            }
        }
    }

    static void stop(Context ctx) {
        synchronized (lock) {
            running = null;
            // Stopped before onStartCommand called startForeground, Android kills the app ("did not
            // then call Service.startForeground()"): a quick Connect then Disconnect. Stop it there.
            if (pending > 0) {
                stopWhenStarted = true;
                return;
            }
        }
        ctx.stopService(new Intent(ctx, TunnelService.class));
    }

    // Started before notifications were allowed, its notification was dropped: post it again.
    static void refresh(Context ctx) {
        String name = running;
        if (name != null) start(ctx, name);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String name = intent == null ? null : intent.getStringExtra(EXTRA_NAME);
        Alerts.channels(this);
        Notification n = new NotificationCompat.Builder(this, Alerts.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_wisp)
            .setContentTitle(name == null || name.isEmpty() ? "Connected" : "Connected to " + name)
            .setContentText("Stays open so wisp can tell you when a task needs you")
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(Alerts.open(this, null))
            .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        boolean up;
        try {
            ServiceCompat.startForeground(this, ID, n, type);
            up = true;
        } catch (RuntimeException e) {
            // Refused (Android 12+ from the background, a missing permission): the tunnel still
            // works while the app is open, so don't crash, just don't keep the service.
            up = false;
        }
        // This start is done either way, so a Disconnect that came meanwhile is honoured here and a
        // refused start doesn't leave `pending` or `running` claiming a service that isn't there.
        synchronized (lock) {
            if (pending > 0) pending--;
            boolean stop = !up || (stopWhenStarted && pending == 0);
            if (pending == 0) stopWhenStarted = false;
            running = stop ? null : name == null ? "" : name;
            // Only this start: one still on its way (a reconnect) keeps the service.
            if (stop) stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    // Swiped away from recents: the page is gone, so nothing would show the alerts.
    @Override
    public void onTaskRemoved(Intent root) {
        WispSshPlugin.stopTunnel();
        running = null;
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
