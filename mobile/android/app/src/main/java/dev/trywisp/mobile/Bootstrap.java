package dev.trywisp.mobile;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * v2's remote bootstrap on the phone: plugins/machines/core/bootstrap.sh, the same file desktop wisp
 * sends (bootstrap.rs fills it there). app/build.gradle copies it into the APK's assets with
 * __VERSION__ and __DIST__ already filled from the workspace's version; this fills the rest per
 * computer. Plain Java, so BootstrapTest runs it on a desktop JVM.
 */
final class Bootstrap {
    static final String ASSET = "wisp/bootstrap.sh";
    private static final Pattern HOST_PORT = Pattern.compile("^(.*?)(?::(\\d+))?$");
    // The fields of server.json that the bundle needs: the loopback token and the peer id.
    private static final Pattern FIELD = Pattern.compile("\"(token|peer)\"\\s*:\\s*\"([^\"\\\\]*)\"");

    private Bootstrap() {}

    /** api "any": the phone takes whichever wisp runs there; the sync welcome decides if it fits. */
    static String fill(String template, int port, String command) {
        String cmd = command == null || command.trim().isEmpty() ? "''" : shq(command.trim());
        return template
            .replace("__PORT__", Integer.toString(port))
            .replace("__INSTALL__", "1")
            .replace("__API__", "any")
            .replace("__CMD__", cmd);
    }

    /** POSIX single quotes, as plugins/machines/core/src/shell.rs shq. */
    static String shq(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /** One string field ("token" or "peer") of server.json, or "" when it has none. */
    static String field(String json, String name) {
        if (json == null) return "";
        Matcher m = FIELD.matcher(json);
        while (m.find()) {
            if (m.group(1).equals(name)) return m.group(2);
        }
        return "";
    }

    /** Where a saved SSH computer is: `you@host` or `you@host:2222`, as the computers screen saves it. */
    static final class Target {
        final String user, host;
        final int sshPort;

        Target(String user, String host, int sshPort) {
            this.user = user;
            this.host = host;
            this.sshPort = sshPort;
        }
    }

    static Target target(String raw, int defaultPort) {
        String s = raw == null ? "" : raw.trim();
        int at = s.lastIndexOf('@');
        Matcher m = HOST_PORT.matcher(at > 0 ? s.substring(at + 1) : s);
        boolean ok = m.matches();
        String host = ok ? m.group(1) : "";
        int port = ok && m.group(2) != null ? Integer.parseInt(m.group(2)) : defaultPort;
        return new Target(at > 0 ? s.substring(0, at) : "", host, port);
    }
}
