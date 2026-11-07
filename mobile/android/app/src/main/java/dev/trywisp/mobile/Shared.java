package dev.trywisp.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.core.content.IntentCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What another app shared with wisp, from Android's share sheet. Grants on content URIs don't
 * outlast the activity, so the files are copied at once into a folder of the app's cache, and
 * read from there by wisp's page (web/js/features/share-in.js) when one is up. That folder goes
 * when the page has them, or on the next start of the app.
 */
final class Shared {
    // The page's caps too (web/js/share-form.js).
    static final int MAX_FILES = 10;
    static final long MAX_BYTES = 20L * 1024 * 1024;
    private static final int CHUNK = 192 * 1024;
    private static final String DIR = "shared";

    private static final class Item {
        final File file;
        final String name;
        final String type;

        Item(File file, String name, String type) {
            this.file = file;
            this.name = name;
            this.type = type;
        }
    }

    private final String title;
    private final String text;
    private final List<Uri> uris;
    private final String intentType;
    private final List<Item> items = new ArrayList<>();
    private final File dir;
    private int left;
    volatile boolean ready;

    private Shared(Context c, Intent intent) {
        title = str(intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT));
        text = str(intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        uris = streams(intent);
        intentType = intent.getType();
        dir = new File(new File(c.getCacheDir(), DIR), Long.toString(System.nanoTime()));
    }

    /** A share in this intent, or null. Opened again from Recents, Android replays the old one. */
    static Shared from(Context c, Intent intent) {
        if (intent == null || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return null;
        Shared s = new Shared(c, intent);
        return s.title.isEmpty() && s.text.isEmpty() && s.uris.isEmpty() ? null : s;
    }

    private static String str(CharSequence s) {
        return s == null ? "" : s.toString();
    }

    private static List<Uri> streams(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri one = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (one != null) out.add(one);
        } else {
            List<Uri> many = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (many != null) out.addAll(many);
        }
        return out;
    }

    /** Whether this type may be shared in: the manifest's filter, for what's in a mixed share. */
    static boolean allowedType(String type) {
        if (type == null) return false;
        String t = type.toLowerCase(java.util.Locale.ROOT);
        return t.startsWith("image/") || t.startsWith("text/") || t.equals("application/pdf");
    }

    /**
     * Only another app's content. A file:// path, or a URI of our own provider, would have any app
     * that can send an intent read wisp's own files (its SSH keys) out through the prompt box.
     */
    static boolean foreign(String scheme, String authority, String ownPackage) {
        return "content".equals(scheme) && authority != null && !authority.equals(ownPackage) && !authority.startsWith(ownPackage + ".");
    }

    /** Copies the files in. On a thread of its own: 20 MB doesn't belong on the UI thread. */
    void read(Context c) {
        ContentResolver cr = c.getContentResolver();
        long bytes = 0;
        for (Uri u : uris) {
            if (items.size() >= MAX_FILES) {
                left++;
                continue;
            }
            String type = cr.getType(u);
            if (type == null) type = intentType;
            if (!foreign(u.getScheme(), u.getAuthority(), c.getPackageName()) || !allowedType(type)) {
                left++;
                continue;
            }
            File f = new File(dir, Integer.toString(items.size()));
            long got = -1;
            try {
                got = copy(cr, u, f, MAX_BYTES - bytes);
            } catch (IOException | SecurityException ignored) {
                // The other app took it back, or it's gone: counted as left out.
            }
            if (got < 0) {
                f.delete();
                left++;
                continue;
            }
            bytes += got;
            items.add(new Item(f, nameOf(cr, u, items.size()), type));
        }
        ready = true;
    }

    /** The bytes written, or -1 over the room left. */
    private long copy(ContentResolver cr, Uri u, File to, long room) throws IOException {
        dir.mkdirs();
        try (InputStream in = cr.openInputStream(u); OutputStream out = new FileOutputStream(to)) {
            if (in == null) return -1;
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            for (int n; (n = in.read(buf)) > 0; ) {
                total += n;
                if (total > room) return -1;
                out.write(buf, 0, n);
            }
            return total;
        }
    }

    private static String nameOf(ContentResolver cr, Uri u, int i) {
        try (Cursor q = cr.query(u, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (q != null && q.moveToFirst() && !q.isNull(0) && !q.getString(0).isEmpty()) return q.getString(0);
        } catch (RuntimeException ignored) {
            // A provider that can't say: the name below does.
        }
        return "shared-" + (i + 1);
    }

    /** What the page reads first: the words, and the files by position. */
    String json() {
        JSONObject o = new JSONObject();
        JSONArray files = new JSONArray();
        try {
            o.put("title", title);
            o.put("text", text);
            o.put("left", left);
            for (Item it : items) files.put(new JSONObject().put("name", it.name).put("type", it.type));
            o.put("files", files);
        } catch (JSONException ignored) {}
        return o.toString();
    }

    /** A piece of file i from offset, as base64; empty at the end. */
    String chunk(int i, long offset) {
        if (i < 0 || i >= items.size()) return "";
        try (RandomAccessFile f = new RandomAccessFile(items.get(i).file, "r")) {
            f.seek(offset);
            byte[] buf = new byte[CHUNK];
            int n = f.read(buf);
            return n <= 0 ? "" : Base64.encodeToString(Arrays.copyOf(buf, n), Base64.NO_WRAP);
        } catch (IOException e) {
            return "";
        }
    }

    void delete() {
        delete(dir);
    }

    /** Whatever an earlier run left: the app was killed with a share still here. */
    static void clear(Context c) {
        delete(new File(c.getCacheDir(), DIR));
    }

    private static void delete(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) delete(k);
        f.delete();
    }
}
