package dev.trywisp.mobile;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.NoRouteToHostException;
import java.net.ServerSocket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.schmizz.keepalive.KeepAliveProvider;
import net.schmizz.sshj.DefaultConfig;
import net.schmizz.sshj.SSHClient;
import net.schmizz.sshj.connection.channel.direct.LocalPortForwarder;
import net.schmizz.sshj.connection.channel.direct.Parameters;
import net.schmizz.sshj.connection.channel.direct.Session;
import net.schmizz.sshj.transport.verification.HostKeyVerifier;
import net.schmizz.sshj.userauth.UserAuthException;
import net.schmizz.sshj.userauth.keyprovider.KeyPairWrapper;
import net.schmizz.sshj.userauth.method.AuthMethod;
import net.schmizz.sshj.userauth.method.AuthNone;
import net.schmizz.sshj.userauth.method.AuthPassword;
import net.schmizz.sshj.userauth.method.AuthPublickey;
import net.schmizz.sshj.userauth.password.PasswordFinder;
import net.schmizz.sshj.userauth.password.Resource;

/**
 * One machine, the phone's version of server/machines.js: SSH in, run wisp's bootstrap script
 * (server/machines/bootstrap.js, sent by the page) on `sh -s`, and once it says `@@wisp ready`,
 * forward 127.0.0.1:port here to 127.0.0.1:port there. The same port on both sides, because wisp
 * only answers requests whose Host is its own 127.0.0.1:port.
 *
 * Progress goes out as the script's `@@wisp …` lines plus a few of our own (see www/app.js). A
 * connection that drops after it was up is retried (agents keep running there meanwhile); a
 * failure before that waits for the user. Plain Java, so test/TunnelCheck runs it on a desktop JVM.
 */
public final class Tunnel {
    public interface Lines {
        void line(String text);
    }

    /** Trust on first use: true to accept this host key. */
    public interface HostKeys {
        boolean trust(String host, int port, String fingerprint);
    }

    private static final long[] RETRY_MS = { 2_000, 5_000, 15_000, 30_000, 60_000 };
    private static final int MAX_LINES = 300;
    private static final Pattern VERSION = Pattern.compile("\"version\"\\s*:\\s*\"([^\"]+)\"");

    public final String host, user, password, script;
    public final int sshPort, port;
    private final KeyPair key;
    private final HostKeys hostKeys;
    private final Lines out;
    private final List<String> lines = new ArrayList<>();

    private volatile String state = "connecting"; // connecting | ready | failed | idle
    private volatile boolean stopped;
    private volatile SSHClient ssh;
    private volatile ServerSocket server;
    private volatile String stage = "ssh"; // the step a failure belongs to
    private volatile String rejectedKey; // set when the host key changed
    private volatile boolean everUp;
    private volatile int tries; // reconnects since the tunnel was last up
    private final Object wake = new Object(); // nudge() cuts a retry wait short
    private Thread thread;
    // Where the phone end listens. Tests use [::1] so a wisp on the same computer keeps 127.0.0.1.
    String bindHost = "127.0.0.1";

    public Tunnel(String host, int sshPort, String user, String password, int port, String script, KeyPair key, HostKeys hostKeys, Lines out) {
        this.host = host;
        this.sshPort = sshPort;
        this.user = user;
        this.password = password;
        this.port = port;
        this.script = script;
        this.key = key;
        this.hostKeys = hostKeys;
        this.out = out;
    }

    public void start() {
        thread = new Thread(this::loop, "wisp-ssh");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        stopped = true;
        state = "idle";
        close();
        if (thread != null) thread.interrupt();
    }

    public String state() {
        return state;
    }

    /**
     * The app is back in front. Android may have cut the network while it was away: a dead SSH
     * connection only shows after keep-alives miss (about a minute), and a failed reconnect may
     * be waiting up to 60s. Meanwhile wisp's page hangs on Loading. So: retry now if waiting,
     * and if up, ask wisp through the tunnel and reconnect at once when it doesn't answer.
     */
    public void nudge() {
        if (stopped) return;
        tries = 0;
        synchronized (wake) {
            wake.notifyAll();
        }
        if (!"ready".equals(state)) return;
        Thread t = new Thread(() -> {
            try {
                ping(3_000);
            } catch (IOException e) {
                if (!stopped && "ready".equals(state)) close(); // the loop reports it lost and reconnects
            }
        }, "wisp-nudge");
        t.setDaemon(true);
        t.start();
    }

    public synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }

    private void emit(String text) {
        if (stopped) return;
        synchronized (this) {
            lines.add(text);
            if (lines.size() > MAX_LINES) lines.remove(0);
        }
        out.line(text);
    }

    private void loop() {
        while (!stopped) {
            String lost;
            try {
                if (!once()) return; // the script said why it can't go on
                lost = "Connection lost.";
            } catch (Exception e) {
                if (stopped) return;
                // Before the first success, or when the machine refuses us: the user has to act.
                if (!everUp || rejectedKey != null || e instanceof UserAuthException) {
                    state = "failed";
                    emit("@@wisp fail " + stage + " " + message(e));
                    return;
                }
                lost = message(e);
            }
            if (stopped) return;
            state = "connecting";
            emit("@@wisp lost " + lost);
            try {
                synchronized (wake) {
                    wake.wait(RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
                }
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** One SSH session. False when the script failed (stop), true when it ended after being up. */
    private boolean once() throws Exception {
        stage = "ssh";
        rejectedKey = null;
        emit("@@wisp step ssh run " + (everUp ? "Reconnecting…" : user + "@" + host));
        DefaultConfig config = new DefaultConfig();
        config.setKeepAliveProvider(KeepAliveProvider.KEEP_ALIVE); // notice a dead network, not just a closed socket
        SSHClient c = new SSHClient(config);
        ssh = c;
        try {
            c.addHostKeyVerifier(new HostKeyVerifier() {
                @Override
                public boolean verify(String h, int p, PublicKey k) {
                    String fp = Keys.fingerprint(k);
                    if (hostKeys.trust(host, sshPort, fp)) return true;
                    rejectedKey = fp;
                    return false;
                }

                @Override
                public List<String> findExistingAlgorithms(String h, int p) {
                    return Collections.emptyList();
                }
            });
            c.setConnectTimeout(15_000);
            c.getConnection().getKeepAlive().setKeepAliveInterval(10);
            c.connect(host, sshPort);
            List<AuthMethod> methods = new ArrayList<>();
            // Tailscale SSH lets tailnet devices in by identity, with no key: it accepts "none".
            // A regular sshd refuses it and the key is next.
            methods.add(new AuthNone());
            methods.add(new AuthPublickey(new KeyPairWrapper(key)));
            if (password != null && !password.isEmpty()) methods.add(new AuthPassword(new OnePassword(password)));
            c.auth(user, methods);

            Session session = c.startSession();
            Session.Command cmd = session.exec("sh -s");
            OutputStream stdin = cmd.getOutputStream();
            stdin.write(script.getBytes(StandardCharsets.UTF_8));
            stdin.flush(); // stdin stays open: the script ends in `cat`, which holds the session
            BufferedReader r = new BufferedReader(new InputStreamReader(cmd.getInputStream(), StandardCharsets.UTF_8));
            for (String line; (line = r.readLine()) != null;) {
                if (!line.startsWith("@@wisp ")) continue;
                emit(line);
                if (line.startsWith("@@wisp fail ")) {
                    state = "failed";
                    return false;
                }
                if (line.startsWith("@@wisp ready")) forward(c);
            }
            if (!everUp) throw new IOException("The machine closed the session before wisp was ready.");
            return true;
        } finally {
            close();
        }
    }

    private void forward(SSHClient c) throws IOException {
        stage = "tunnel";
        emit("@@wisp step tunnel run");
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        try {
            s.bind(new InetSocketAddress(bindHost, port));
        } catch (IOException e) {
            s.close();
            throw new IOException("Port " + port + " is already in use on this phone.");
        }
        server = s;
        LocalPortForwarder fwd = c.newLocalPortForwarder(new Parameters(bindHost, port, "127.0.0.1", port), s);
        Thread t = new Thread(() -> {
            try {
                fwd.listen();
            } catch (IOException ignored) {
                // closed with the session
            }
        }, "wisp-forward");
        t.setDaemon(true);
        t.start();
        String version = health();
        everUp = true;
        tries = 0;
        state = "ready";
        emit("@@wisp step tunnel done 127.0.0.1:" + port + " → " + port);
        emit("@@wisp open " + version);
    }

    // wisp's /api/health through the tunnel: the forward is only useful once wisp answers there.
    private String health() throws IOException {
        IOException last = null;
        for (int i = 0; i < 6 && !stopped; i++) {
            try {
                return ping(4_000);
            } catch (IOException e) {
                last = e;
                try {
                    Thread.sleep(500);
                } catch (InterruptedException ie) {
                    break;
                }
            }
        }
        throw new IOException("The tunnel opened, but wisp doesn’t answer through it." + (last != null ? " (" + last.getMessage() + ")" : ""));
    }

    // One /api/health through the tunnel: wisp's version.
    private String ping(int timeoutMs) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL("http://" + (bindHost.contains(":") ? "[" + bindHost + "]" : bindHost) + ":" + port + "/api/health").openConnection();
        h.setConnectTimeout(timeoutMs);
        h.setReadTimeout(timeoutMs);
        try (InputStream in = h.getInputStream()) {
            Matcher m = VERSION.matcher(new String(readAll(in), StandardCharsets.UTF_8));
            return m.find() ? m.group(1) : "";
        } finally {
            h.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0;) b.write(buf, 0, n);
        return b.toByteArray();
    }

    // Package-private: the test drops a live connection with it to check the reconnect.
    void close() {
        ServerSocket s = server;
        server = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {}
        }
        SSHClient c = ssh;
        ssh = null;
        if (c != null) {
            try {
                c.disconnect();
            } catch (IOException ignored) {}
        }
    }

    private String message(Throwable e) {
        if (rejectedKey != null) return "The host key changed: it is now " + rejectedKey + ".";
        if (e instanceof UserAuthException) return password != null && !password.isEmpty() ? "Authentication failed: the machine refused this phone’s key and the password." : "Authentication failed: the machine refused this phone’s key.";
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        if (root instanceof UnknownHostException) return "Couldn’t resolve " + host + ".";
        if (root instanceof ConnectException) return "Connection refused by " + host + ":" + sshPort + ".";
        if (root instanceof NoRouteToHostException) return host + " is unreachable from this phone.";
        if (root instanceof SocketTimeoutException) return "Timed out reaching " + host + ":" + sshPort + ".";
        String m = e.getMessage();
        return m != null && !m.isEmpty() ? m : e.getClass().getSimpleName();
    }

    // Offered once: a wrong password fails the attempt instead of looping.
    private static final class OnePassword implements PasswordFinder {
        private final String password;

        OnePassword(String password) {
            this.password = password;
        }

        @Override
        public char[] reqPassword(Resource<?> resource) {
            return password.toCharArray();
        }

        @Override
        public boolean shouldRetry(Resource<?> resource) {
            return false;
        }
    }
}
