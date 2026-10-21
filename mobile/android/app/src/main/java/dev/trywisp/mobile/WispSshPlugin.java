package dev.trywisp.mobile;

import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyPair;
import java.security.Security;
import org.bouncycastle.jce.provider.BouncyCastleProvider;

/**
 * The page's side of {@link Tunnel} and {@link Keys}: listKeys, createKey, importKey, deleteKey,
 * connect, status, disconnect, forgetHost, and a `line` event per `@@wisp …` line.
 *
 * One machine is connected at a time (the phone's 127.0.0.1:port can only lead to one wisp), so
 * connecting another stops the first; wisp and its agents keep running on both. The tunnel is
 * static so it outlives the page: the WebView leaves this page for wisp's own and comes back.
 * While one is connected, {@link TunnelService} keeps the app running in the background.
 */
@CapacitorPlugin(name = "WispSsh")
public class WispSshPlugin extends Plugin {
    private static Tunnel tunnel;
    private static String machineId = "";
    private Keys keys;

    @Override
    public void load() {
        // Android ships a cut-down "BC" provider without Ed25519: put the full one first.
        Security.removeProvider("BC");
        Security.insertProviderAt(new BouncyCastleProvider(), 1);
    }

    // Back from the background: check the tunnel now rather than when keep-alives give up.
    @Override
    protected void handleOnResume() {
        Tunnel t = tunnel;
        if (t != null) t.nudge();
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

    @PluginMethod
    public void listKeys(PluginCall call) {
        try {
            JSArray list = new JSArray();
            for (Keys.Info k : keys().listOrCreate()) list.put(json(k));
            JSObject r = new JSObject();
            r.put("keys", list);
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
            });
            tunnel.start();
        }
        TunnelService.start(getContext(), call.getString("name", host));
        call.resolve();
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
        stopTunnel();
        TunnelService.stop(getContext());
        call.resolve();
    }

    static void stopTunnel() {
        synchronized (WispSshPlugin.class) {
            if (tunnel != null) tunnel.stop();
            tunnel = null;
            machineId = "";
        }
    }
}
