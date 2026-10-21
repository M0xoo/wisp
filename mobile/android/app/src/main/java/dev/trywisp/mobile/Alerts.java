package dev.trywisp.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Android notifications: a task that finished or asks (posted by wisp's page through
 * MainActivity's `wispAndroid` bridge, as the desktop page does with the Notification API), and
 * the ongoing one {@link TunnelService} needs while a machine is connected.
 */
final class Alerts {
    static final String TASKS = "tasks";
    static final String CONNECTION = "connection";
    static final String EXTRA_TASK = "dev.trywisp.mobile.task";

    private Alerts() {}

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel tasks = new NotificationChannel(TASKS, "Tasks", NotificationManager.IMPORTANCE_HIGH);
        tasks.setDescription("A task finished, has a question or needs your approval");
        nm.createNotificationChannel(tasks);
        NotificationChannel conn = new NotificationChannel(CONNECTION, "Connection", NotificationManager.IMPORTANCE_LOW);
        conn.setDescription("Shown while a machine is connected, so the tunnel stays open in the background");
        conn.setShowBadge(false);
        nm.createNotificationChannel(conn);
    }

    /** Opens the app; with a task id, wisp's page reveals that task. */
    static PendingIntent open(Context ctx, String task) {
        Intent i = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (task != null) i.putExtra(EXTRA_TASK, task);
        int code = task == null ? 0 : task.hashCode();
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** One per task (tagged with its id), so a later state replaces the earlier note. */
    static void task(Context ctx, String id, String title, String body) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        if (!nm.areNotificationsEnabled()) return;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, TASKS)
            .setSmallIcon(R.drawable.ic_stat_wisp)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(open(ctx, id));
        try {
            nm.notify(id, 1, b.build());
        } catch (SecurityException e) {
            // the permission was revoked between the check and the post
        }
    }
}
