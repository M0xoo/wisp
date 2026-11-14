package dev.trywisp.mobile;

import android.content.SharedPreferences;
import android.webkit.WebView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyPair;
import java.security.Security;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.json.JSONObject;

/**
 * The page's side of {@link Tunnel} and {@link Keys}: listKeys, createKey, importKey, deleteKey,
 * connect, status, disconnect, forgetHost, and a `line` event per `@@wisp …` line.
 *
 * One machine is connected at a time (the phone's 127.0.0.1:port can only lead to one wisp), so
 * connecting another stops the first; wisp and its agents keep running on both. The tunnel is
 * static so it outlives the page: the WebView leaves this page for wisp's own and comes back.
 * While one is connected, {@link TunnelService} keeps the app running in the background.
 *
 * v2 (the bundle in the APK, mobile/web): every saved computer at once. list, saveComputer,
 * forgetComputer ({@link Computers}); connect({id}) answers how to reach it ({@link Reach}), and
 * disconnect({id}) lets one go; leave sends the app to the background. Events: `tunnel` {id, state,
 * line}, `computers` (the list changed), `back` (Android's Back, when the bundle listens) and `open`
 * {target} (a tapped notification). Called with `host`, connect is still v1's single tunnel.
 */
@CapacitorPlugin(name = "WispSsh")
public class WispSshPlugin extends Plugin {
    private static Tunnel tunnel;
    private static String machineId = "";
    private static volatile String cloudOrigin; // the cloud computer the list opened (stayOpen)
    private static volatile WispSshPlugin self; // the page's plugin: v2's tunnels outlive a reload
    private static final Reach reach = new Reach((id, state, line) -> {
        WispSshPlugin p = self;
        if (p == null) return;
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("state", state);
        ev.put("line", line);
        p.notifyListeners("tunnel", ev);
    });
    private static volatile boolean serving; // TunnelService started for v2's computers
    private String template; // assets/wisp/bootstrap.sh
    private Keys keys;

    @Override
    public void load() {
        // Android ships a cut-down "BC" provider without Ed25519: put the full one first.
        Security.removeProvider("BC");
        Security.insertProviderAt(new BouncyCastleProvider(), 1);
        self = this;
    }

    // Back from the background: check the tunnel now rather than when keep-alives give up.
    @Override
    protected void handleOnResume() {
        Tunnel t = tunnel;
        if (t != null) t.nudge();
        reach.nudgeAll();
    }

    private synchronized Keys keys() {
        if (keys == null) keys = new Keys(new java.io.File(getContext().getFilesDir(), "keys"));
        return keys;
    }

    private static JSObject json(Keys.Info k) {
        JSObject o = new JSObject();
        o.put("id", k.id);
        o.put("name", k.name);
        o.put("source", k.source);
        o.put("type", net.schmizz.sshj.common.KeyType.fromKey(k.pub).toString());
        o.put("publicKey", Keys.authorizedKey(k.pub));
        o.put("fingerprint", Keys.fingerprint(k.pub));
        return o;
    }

    private SharedPreferences hosts() {
        return getContext().getSharedPreferences("wisp.hosts", 0);
    }

    // A wisp Grid signed in to: its pages (the grid and <handle>.<grid>) load in the app.
    @PluginMethod
    public void allowGrid(PluginCall call) {
        Grid.allow(getContext(), call.getString("domain", ""));
        call.resolve();
    }

    // Into a cloud computer (no SSH): the app must still stay up in the background, or Android
    // freezes it once it's off screen and wisp's page never hears that a task finished or asks.
    // Called before leaving the list, while the app is on screen (a foreground service can't start
    // from the background). The list stops it again when it's back with no tunnel (disconnect).
    @PluginMethod
    public void stayOpen(PluginCall call) {
        cloudOrigin = Shared.originOf(call.getString("origin"));
        TunnelService.start(getContext(), call.getString("name", ""));
        call.resolve();
    }

    // The grid's sign-in page goes to the browser: Google and others refuse embedded WebViews.
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            call.reject("Not a web address.");
            return;
        }
        android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void listKeys(PluginCall call) {
        try {
            JSArray list = new JSArray();
            java.util.List<String> unreadable = new java.util.ArrayList<>();
            for (Keys.Info k : keys().listOrCreate(unreadable)) list.put(json(k));
            JSObject r = new JSObject();
            r.put("keys", list);
            r.put("unreadable", new JSArray(unreadable));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Couldn’t read this phone’s keys: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void createKey(PluginCall call) {
        try {
            call.resolve(json(keys().create(call.getString("name", "Key"))));
        } catch (Exception e) {
            call.reject("Couldn’t make a key: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void importKey(PluginCall call) {
        try {
            call.resolve(json(keys().importKey(call.getString("name", "Imported key"), call.getString("privateKey", ""), call.getString("passphrase"))));
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Couldn’t read that key.", e);
        }
    }

    @PluginMethod
    public void deleteKey(PluginCall call) {
        try {
            keys().delete(call.getString("id"));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!call.getData().has("host") && call.getData().has("id")) {
            reachConnect(call);
            return;
        }
        String host = call.getString("host", "").trim();
        String user = call.getString("user", "").trim();
        String script = call.getString("script", "");
        int sshPort = call.getInt("sshPort", 22);
        int port = call.getInt("port", 4477);
        if (host.isEmpty() || user.isEmpty() || script.isEmpty()) {
            call.reject("Need user@host and the bootstrap script.");
            return;
        }
        KeyPair kp;
        try {
            kp = keys().load(call.getString("keyId"));
        } catch (Exception e) {
            call.reject("This machine’s key is gone: pick another one.", e);
            return;
        }
        synchronized (WispSshPlugin.class) {
            if (tunnel != null) tunnel.stop();
            machineId = call.getString("machineId", "");
            tunnel = new Tunnel(host, sshPort, user, call.getString("password"), port, script, kp, this::trust, (text) -> {
                JSObject ev = new JSObject();
                ev.put("text", text);
                notifyListeners("line", ev);
                toPage(text);
            });
            tunnel.start();
        }
        TunnelService.start(getContext(), call.getString("name", host));
        call.resolve();
    }

    // wisp's own page (http://127.0.0.1:<port>) has no Capacitor bridge, but the app may show it
    // before the tunnel is up (from its cache): it hears the same lines as a `wisp-tunnel` event
    // (web/js/features/live.js), and reads where things are with window.wispAndroid.tunnel().
    private void toPage(String text) {
        if (getBridge() == null) return;
        WebView web = getBridge().getWebView();
        web.post(() -> {
            String url = web.getUrl();
            if (!Shared.isPage(url, pageOrigin())) return;
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('wisp-tunnel', { detail: " + JSONObject.quote(text) + " }))", null);
        });
    }

    /** Where wisp's page is on the computer open now, or null: the tunnel's port, or the cloud computer. */
    static String pageOrigin() {
        Tunnel t = tunnel;
        return t != null ? "http://127.0.0.1:" + t.port : cloudOrigin;
    }

    static boolean hasTunnel() {
        return tunnel != null;
    }

    /** wisp's page failed to load: check the tunnel now (a reconnect starts wisp again). */
    static void nudgeTunnel() {
        Tunnel t = tunnel;
        if (t != null) t.nudge();
    }

    /** {state, line}: the tunnel's state and its last progress line, for wisp's page as it opens. */
    static String pageState() {
        JSObject r = new JSObject();
        Tunnel t = tunnel;
        java.util.List<String> lines = t == null ? java.util.Collections.emptyList() : t.lines();
        r.put("state", t == null ? "idle" : t.state());
        r.put("line", lines.isEmpty() ? "" : lines.get(lines.size() - 1));
        return r.toString();
    }

    // Trust on first use, per host:port. A changed key is refused until forgetHost.
    private boolean trust(String host, int port, String fingerprint) {
        String id = host + ":" + port;
        String known = hosts().getString(id, null);
        if (known == null) {
            hosts().edit().putString(id, fingerprint).apply();
            return true;
        }
        return known.equals(fingerprint);
    }

    @PluginMethod
    public void forgetHost(PluginCall call) {
        hosts().edit().remove(call.getString("host", "") + ":" + call.getInt("sshPort", 22)).apply();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        Tunnel t = tunnel;
        r.put("state", t == null ? "idle" : t.state());
        r.put("machineId", machineId);
        r.put("port", t == null ? 4477 : t.port);
        r.put("lines", new JSArray(t == null ? java.util.Collections.emptyList() : t.lines()));
        call.resolve(r);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            reach.disconnect(id);
            released();
            call.resolve();
            return;
        }
        stopTunnel();
        cloudOrigin = null;
        TunnelService.stop(getContext());
        call.resolve();
    }

    static void stopTunnel() {
        synchronized (WispSshPlugin.class) {
            if (tunnel != null) tunnel.stop();
            tunnel = null;
            machineId = "";
        }
        reach.stopAll();
        serving = false;
    }

    // ---- v2: the bundle reaches every computer at once ----

    @PluginMethod
    public void list(PluginCall call) {
        call.resolve(new JSObject().put("computers", Computers.list(getContext())));
    }

    @PluginMethod
    public void saveComputer(PluginCall call) {
        try {
            JSObject saved = JSObject.fromJSONObject(Computers.save(getContext(), call.getObject("computer", new JSObject())));
            notifyListeners("computers", new JSObject());
            call.resolve(saved);
        } catch (org.json.JSONException e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void forgetComputer(PluginCall call) {
        String id = call.getString("id", "");
        reach.disconnect(id);
        Computers.forget(getContext(), id);
        released();
        notifyListeners("computers", new JSObject());
        call.resolve();
    }

    // Back with nothing left to close in the bundle: the app goes behind, its tunnels kept.
    @PluginMethod
    public void leave(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    private void reachConnect(PluginCall call) {
        String id = call.getString("id", "");
        org.json.JSONObject c = Computers.get(getContext(), id);
        if (c == null) {
            call.reject("No saved computer " + id + "."); // forgotten meanwhile
            return;
        }
        String name = c.optString("name", id);
        serve();
        if ("grid".equals(c.optString("kind"))) {
            JSObject r = new JSObject().put("kind", "grid").put("base", c.optString("url")).put("token", c.optString("token")).put("name", name);
            if (!c.optString("peer").isEmpty()) r.put("peer", c.optString("peer"));
            call.resolve(r);
            return;
        }
        try {
            reach.connect(id, name, sshTunnel(id, name, c, call.getString("password")), call);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
        }
    }

    private Tunnel sshTunnel(String id, String name, org.json.JSONObject c, String password) throws Exception {
        Bootstrap.Target t = Bootstrap.target(c.optString("target", ""), c.optInt("sshPort", 22));
        if (t.user.isEmpty() || t.host.isEmpty()) throw new Exception("Add your user name: you@its-name");
        int port = c.optInt("port", 4477);
        String keyId = c.optString("keyId", "");
        if (keyId.isEmpty()) keyId = keys().listOrCreate().get(0).id; // as v1's keyOf
        KeyPair kp = keys().load(keyId);
        String script = Bootstrap.fill(template(), port, c.optString("command", ""));
        Tunnel[] box = new Tunnel[1];
        box[0] = Reach.tunnel(t.host, t.sshPort, t.user, password, port, script, kp, this::trust, (text) -> reach.line(id, name, box[0], text));
        return box[0];
    }

    private synchronized String template() throws java.io.IOException {
        if (template == null) {
            try (java.io.InputStream in = getContext().getAssets().open(Bootstrap.ASSET)) {
                template = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            }
        }
        return template;
    }

    // Kept running while any computer is reached, as v1 did for its one (TunnelService).
    private void serve() {
        if (serving) return;
        serving = true;
        TunnelService.start(getContext(), "your computers");
    }

    private void released() {
        if (!serving || reach.count() > 0 || tunnel != null) return;
        serving = false;
        TunnelService.stop(getContext());
    }

    /** Android's Back: true when the bundle listens for it (it closes what's open, or calls leave). */
    static boolean back() {
        WispSshPlugin p = self;
        if (p == null || !p.hasListeners("back")) return false;
        p.notifyListeners("back", new JSObject());
        return true;
    }

    /** A tapped notification (Notifications.schedule): kept until the bundle listens, on a cold start. */
    static void opened(String target) {
        WispSshPlugin p = self;
        if (p == null) return;
        JSObject ev = new JSObject();
        ev.put("target", target);
        p.notifyListeners("open", ev, true);
    }
}
