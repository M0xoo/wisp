package dev.trywisp.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private ActivityResultLauncher<String> askPermission;
    private volatile boolean resumed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WispSshPlugin.class);
        super.onCreate(savedInstanceState);
        Alerts.channels(this);
        askPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), (granted) -> {
            prefs().edit().putBoolean("asked", true).apply();
            if (granted) TunnelService.refresh(this);
            answer();
        });
        // wisp's page is served from the machine (http://127.0.0.1:<port>), where Capacitor's bridge
        // isn't injected, and the WebView has no Notification API: web/js/features/notify.js
        // uses this instead.
        WebView web = getBridge().getWebView();
        web.addJavascriptInterface(new Notify(), "wispAndroid");
        // Cloud computers (wisp Grid) load here too; see Grid.java.
        getBridge().setWebViewClient(new Grid.Client(getBridge(), this));
        // Between pages (the list, then wisp's) the WebView shows its own background: the pages'
        // (--bg in web/css/tokens.css), so dark mode doesn't flash white. It also draws the parts
        // just off screen ahead of time, so a fling doesn't show blank tiles.
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(night ? 0xFF111111 : 0xFFFFFFFF);
        web.getSettings().setOffscreenPreRaster(true);
        // Back goes back in the WebView: from wisp's page to the machines list, and closes an open
        // sheet there (it pushes a history entry). Only with nothing to go back to does it leave.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge().getWebView();
                if (web.canGoBack()) {
                    web.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    // A tapped task notification: wisp's page reveals the task (its #/s/<id> route).
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String task = intent == null ? null : intent.getStringExtra(Alerts.EXTRA_TASK);
        if (task == null || getBridge() == null) return;
        WebView web = getBridge().getWebView();
        String url = web.getUrl();
        if (url != null && (url.startsWith("http://127.0.0.1:") || Grid.allowed(this, android.net.Uri.parse(url).getHost()))) js("location.hash = " + JSONObject.quote("#/s/" + task));
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("wisp.notify", 0);
    }

    private void answer() {
        js("window.dispatchEvent(new CustomEvent('wisp-notify-permission', { detail: " + JSONObject.quote(permission()) + " }))");
    }

    private void js(String code) {
        runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(code, null));
    }

    // The Notification API's permission names. Android only asks twice; after that it's denied.
    private String permission() {
        boolean enabled = NotificationManagerCompat.from(this).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < 33) return enabled ? "granted" : "denied";
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return enabled ? "granted" : "denied";
        }
        boolean asked = prefs().getBoolean("asked", false);
        return asked && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) ? "denied" : "default";
    }

    /** window.wispAndroid. Called on a WebView thread, so nothing here touches views directly. */
    private final class Notify {
        @JavascriptInterface
        public String permission() {
            return MainActivity.this.permission();
        }

        @JavascriptInterface
        public void requestPermission() {
            if (Build.VERSION.SDK_INT < 33 || !"default".equals(permission())) {
                answer();
                return;
            }
            runOnUiThread(() -> askPermission.launch(Manifest.permission.POST_NOTIFICATIONS));
        }

        @JavascriptInterface
        public String tunnel() {
            return WispSshPlugin.pageState();
        }

        @JavascriptInterface
        public boolean foreground() {
            return resumed;
        }

        @JavascriptInterface
        public void notify(String id, String title, String body) {
            if (id == null || id.isEmpty()) return;
            Alerts.task(MainActivity.this, id, title == null ? "wisp" : title, body == null ? "" : body);
        }
    }
}
