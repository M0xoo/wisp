package dev.trywisp.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
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
    private boolean clearHistory; // after falling back to the list: Back mustn't return to the error
    private String openTask; // a tapped notification's task, opened once wisp's page has loaded

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
        // Between pages (the list, then wisp's) the WebView shows its own background: the pages'
        // (--bg in web/css/tokens.css), so dark mode doesn't flash white. It also draws the parts
        // just off screen ahead of time, so a fling doesn't show blank tiles.
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(night ? 0xFF111111 : 0xFFFFFFFF);
        web.getSettings().setOffscreenPreRaster(true);
        // Tapped with the app gone (closed, or killed while the screen was off): the intent comes
        // here, not to onNewIntent. Not on a re-create, which would open it again.
        if (savedInstanceState == null) openTask = taskOf(getIntent());
        // wisp's page comes from the computer through the tunnel. SSH can be up while wisp isn't
        // (it was quit or crashed there), and with nothing cached the WebView would show its own
        // error page. Instead: back to the computers list, which says what's happening, while the
        // tunnel reconnects (that starts wisp again) and opens wisp once it answers.
        // One client for both: it extends Grid.Client so cloud computers (wisp Grid) load here too
        // instead of in the browser, where the page isn't the app's (no way back to the list).
        getBridge().setWebViewClient(new Grid.Client(getBridge(), this) {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (!request.isForMainFrame() || !request.getUrl().toString().startsWith("http://127.0.0.1:")) return;
                WispSshPlugin.nudgeTunnel();
                view.stopLoading();
                clearHistory = true;
                view.loadUrl(getBridge().getLocalUrl() + "/?reopen=1");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (clearHistory && url != null && url.startsWith(getBridge().getLocalUrl())) {
                    clearHistory = false;
                    view.clearHistory();
                }
                if (openTask != null && wispPage(url)) {
                    open(openTask);
                    openTask = null;
                }
            }
        });
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

    // Left for good (Back from wisp's page with nothing before it) on a cloud computer: its page is
    // gone with the WebView, so the service would only keep an empty app and its notification up.
    // An SSH tunnel stays, so coming back opens that computer at once.
    @Override
    public void onDestroy() {
        if (isFinishing() && !WispSshPlugin.hasTunnel()) TunnelService.stop(this);
        super.onDestroy();
    }

    // A tapped task notification: wisp's page reveals the task (its #/s/<id> route). On the list
    // (the tunnel is reconnecting after the screen was off, or no computer is open yet) it waits
    // for wisp's page to load instead of being dropped.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String task = taskOf(intent);
        if (task == null || getBridge() == null) return;
        if (wispPage(getBridge().getWebView().getUrl())) open(task);
        else openTask = task;
    }

    private static String taskOf(Intent intent) {
        String task = intent == null ? null : intent.getStringExtra(Alerts.EXTRA_TASK);
        return task == null || task.isEmpty() ? null : task;
    }

    private boolean wispPage(String url) {
        return url != null && (url.startsWith("http://127.0.0.1:") || Grid.allowed(this, android.net.Uri.parse(url).getHost()));
    }

    // wisp's page opens it without a history entry (window.wispOpen); an older wisp only has the route.
    private void open(String task) {
        js("window.wispOpen ? wispOpen(" + JSONObject.quote(task) + ") : (location.hash = " + JSONObject.quote("#/s/" + task) + ")");
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
