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
 * Runs while a machine is connected. Without it Android freezes the app a few seconds after it
 * leaves the screen: the tunnel drops and wisp's page can't post a notification when a task
 * finishes or asks. Its own notification (low importance, no sound) says which machine.
 */
public class TunnelService extends Service {
    private static final String EXTRA_NAME = "name";
    private static final int ID = 1;
    private static volatile String running; // the machine's name while started

    static void start(Context ctx, String name) {
        Intent i = new Intent(ctx, TunnelService.class).putExtra(EXTRA_NAME, name);
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (RuntimeException e) {
            // Not allowed from the background (a reconnect): the tunnel still works while open.
        }
    }

    static void stop(Context ctx) {
        running = null;
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
        running = name == null ? "" : name;
        Alerts.channels(this);
        Notification n = new NotificationCompat.Builder(this, Alerts.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_wisp)
            .setContentTitle(name == null || name.isEmpty() ? "Connected" : "Connected to " + name)
            .setContentText("Keeps the tunnel open so wisp can tell you when a task needs you")
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(Alerts.open(this, null))
            .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        try {
            ServiceCompat.startForeground(this, ID, n, type);
        } catch (RuntimeException e) {
            running = null;
            stopSelf();
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
