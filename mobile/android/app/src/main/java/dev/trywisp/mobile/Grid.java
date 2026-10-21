package dev.trywisp.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashSet;
import java.util.Set;

/**
 * wisp Grids the app signed in to (cloud computers). Their pages load in the app's WebView: the
 * grid itself and every <handle>.<grid> under it. Everything else still opens in the browser, as
 * Capacitor's allowNavigation does (it is fixed at build time; grids are added at run time).
 */
final class Grid {
    private Grid() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("wisp.grids", 0);
    }

    static void allow(Context c, String domain) {
        if (domain == null || domain.isEmpty()) return;
        Set<String> s = new HashSet<>(prefs(c).getStringSet("domains", new HashSet<>()));
        s.add(domain.toLowerCase());
        prefs(c).edit().putStringSet("domains", s).apply();
    }

    static boolean allowed(Context c, String host) {
        if (host == null) return false;
        String h = host.toLowerCase();
        for (String d : prefs(c).getStringSet("domains", new HashSet<>())) {
            if (h.equals(d) || h.endsWith("." + d)) return true;
        }
        return false;
    }

    /** Capacitor's client, plus the grids: load those here instead of handing them to the browser. */
    static final class Client extends BridgeWebViewClient {
        private final Context context;

        Client(Bridge bridge, Context context) {
            super(bridge);
            this.context = context;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (("https".equals(u.getScheme()) || "http".equals(u.getScheme())) && allowed(context, u.getHost())) return false;
            return super.shouldOverrideUrlLoading(view, request);
        }
    }
}
