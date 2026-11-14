package dev.trywisp.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * v2: every saved SSH computer at once, one {@link Tunnel} each, keyed by the computer's id. The
 * bundle (mobile/web) asks for one with connect({id}) each time its sync stream (re)opens: a ready
 * tunnel answers at once with its local port and token; one still connecting answers when it opens,
 * so a reconnect hands back the port it came back on. The tunnel's own retry loop stays as in v1.
 */
final class Reach {
    interface Events {
        /** state: connecting | ready | failed | idle; line: the `@@wisp …` line that moved it */
        void tunnel(String id, String state, String line);
    }

    private final Map<String, Tunnel> tunnels = new HashMap<>();
    private final Map<String, List<PluginCall>> waiting = new HashMap<>();
    private final Events events;

    Reach(Events events) {
        this.events = events;
    }

    synchronized int count() {
        return tunnels.size();
    }

    /** Opens (or reuses) the tunnel to `id` and answers `call` once it is up, or why it failed. */
    void connect(String id, String name, Tunnel fresh, PluginCall call) {
        Tunnel t;
        synchronized (this) {
            t = tunnels.get(id);
            if (t != null && "failed".equals(t.state())) {
                t.stop(); // it gave up (auth, host key, the script): a new connect tries again
                t = null;
            }
            if (t != null && "ready".equals(t.state())) {
                call.resolve(answer(t, name));
                return;
            }
            waiting.computeIfAbsent(id, k -> new ArrayList<>()).add(call);
            if (t != null) return;
            tunnels.put(id, fresh);
        }
        fresh.start();
    }

    /** What the bundle reaches it with: http://127.0.0.1:<port> and `Authorization: Bearer <token>`. */
    private static JSObject answer(Tunnel t, String name) {
        JSObject r = new JSObject();
        r.put("kind", "ssh");
        r.put("port", t.localPort);
        r.put("token", t.token);
        r.put("name", name);
        if (!t.peer.isEmpty()) r.put("peer", t.peer);
        return r;
    }

    /** The tunnel's lines, in order: settles the waiting calls and tells the bundle its state. */
    void line(String id, String name, Tunnel t, String text) {
        String state = null;
        List<PluginCall> settle = null;
        synchronized (this) {
            if (tunnels.get(id) != t) return; // replaced or stopped meanwhile
            if (text.startsWith("@@wisp open")) state = "ready";
            else if (text.startsWith("@@wisp fail ")) state = "failed";
            else if (text.startsWith("@@wisp lost ") || text.startsWith("@@wisp step ")) state = "connecting";
            if ("ready".equals(state) || "failed".equals(state)) settle = waiting.remove(id);
        }
        if (settle != null) {
            for (PluginCall c : settle) {
                if ("ready".equals(state)) c.resolve(answer(t, name));
                else c.reject(failure(text));
            }
        }
        if (state != null) events.tunnel(id, state, text);
    }

    // "@@wisp fail <stage> <message>" → the message.
    static String failure(String line) {
        String rest = line.substring("@@wisp fail ".length());
        int sp = rest.indexOf(' ');
        return sp < 0 ? rest : rest.substring(sp + 1);
    }

    void disconnect(String id) {
        Tunnel t;
        List<PluginCall> settle;
        synchronized (this) {
            t = tunnels.remove(id);
            settle = waiting.remove(id);
        }
        if (t != null) t.stop();
        if (settle != null) for (PluginCall c : settle) c.reject("Disconnected.");
        if (t != null) events.tunnel(id, "idle", "");
    }

    void stopAll() {
        List<String> ids;
        synchronized (this) {
            ids = new ArrayList<>(tunnels.keySet());
        }
        for (String id : ids) disconnect(id);
    }

    void nudgeAll() {
        List<Tunnel> all;
        synchronized (this) {
            all = new ArrayList<>(tunnels.values());
        }
        for (Tunnel t : all) t.nudge();
    }

    /** A v2 tunnel for a saved SSH computer, whose lines come back through {@link #line}. */
    static Tunnel tunnel(String host, int sshPort, String user, String password, int port, String script, KeyPair key, Tunnel.HostKeys trust, Tunnel.Lines out) {
        Tunnel t = new Tunnel(host, sshPort, user, password, port, script, key, trust, out);
        t.anyLocalPort = true;
        return t;
    }
}
