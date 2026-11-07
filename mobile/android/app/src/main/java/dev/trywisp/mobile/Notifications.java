package dev.trywisp.mobile;

import android.Manifest;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;

/**
 * The bundle's notifications (@wisp/shell's androidPlatform calls LocalNotifications.schedule),
 * posted by {@link Alerts} on its Tasks channel instead of pulling in @capacitor/local-notifications.
 * Same method names and shapes as that plugin, so the shell needs nothing Android-specific; if the
 * real one is ever added, drop this class (two plugins can't share a name).
 */
@CapacitorPlugin(name = "LocalNotifications", permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "display"))
public class Notifications extends Plugin {
    /** {notifications: [{id, title, body, extra}]}: extra is where a tap goes (a Target). */
    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray list = call.getArray("notifications", new JSArray());
        JSArray ids = new JSArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject n = list.optJSONObject(i);
            if (n == null) continue;
            String tag = n.optString("id", Integer.toString(i));
            Object extra = n.opt("extra");
            String target = extra == null || extra == JSONObject.NULL ? null : extra.toString();
            Alerts.target(getContext(), tag, n.optString("title", "wisp"), n.optString("body", ""), target);
            ids.put(new JSObject().put("id", tag));
        }
        call.resolve(new JSObject().put("notifications", ids));
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(new JSObject().put("display", state()));
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("display") == PermissionState.GRANTED) {
            checkPermissions(call);
            return;
        }
        requestPermissionForAlias("display", call, "answered");
    }

    @PermissionCallback
    private void answered(PluginCall call) {
        if (getPermissionState("display") == PermissionState.GRANTED) TunnelService.refresh(getContext()); // its note was dropped
        checkPermissions(call);
    }

    // Android 13+ asks; before that it is the app's notification switch in Settings.
    private String state() {
        boolean on = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < 33) return on ? "granted" : "denied";
        PermissionState p = getPermissionState("display");
        if (p == PermissionState.GRANTED) return on ? "granted" : "denied";
        return p == PermissionState.DENIED ? "denied" : "prompt";
    }
}
