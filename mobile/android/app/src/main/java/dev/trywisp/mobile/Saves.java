package dev.trywisp.mobile;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * Download in wisp's page (a picture, a video, a file from My Stuff): the WebView ignores
 * `<a download>`, so the page hands the address here (window.wispAndroid.save). Pictures go to
 * Pictures/wisp and videos to Movies/wisp, where the gallery shows them; anything else to
 * Download/wisp. No storage permission: MediaStore takes them on Android 10+. Before that the
 * file goes to the share sheet instead.
 */
final class Saves {
    private Saves() {}

    interface Done {
        void done(String where, String error);
    }

    /** Off the UI thread. The request carries the WebView's cookies (a wisp Grid's sign-in). */
    static void save(Context c, String url, String name, Done done) {
        new Thread(() -> {
            try {
                done.done(write(c, url, name), null);
            } catch (Exception e) {
                done.done(null, e.getMessage() != null ? e.getMessage() : e.toString());
            }
        }, "wisp-save").start();
    }

    private static String write(Context c, String url, String name) throws Exception {
        String mime;
        InputStream in;
        HttpURLConnection conn = null;
        if (url.startsWith("data:")) {
            int comma = url.indexOf(',');
            String head = url.substring(5, Math.max(5, comma));
            mime = head.split(";")[0];
            byte[] body = head.endsWith(";base64") ? Base64.decode(url.substring(comma + 1), Base64.DEFAULT) : Uri.decode(url.substring(comma + 1)).getBytes("UTF-8");
            in = new ByteArrayInputStream(body);
        } else if (url.startsWith("http://") || url.startsWith("https://")) {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(20_000);
            conn.setReadTimeout(60_000);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) conn.setRequestProperty("Cookie", cookies);
            int status = conn.getResponseCode();
            if (status >= 400) throw new Exception("the computer answered " + status);
            mime = conn.getContentType();
            in = conn.getInputStream();
        } else {
            throw new Exception("not a web address");
        }
        try {
            mime = mime == null ? "" : mime.split(";")[0].trim().toLowerCase(Locale.ROOT);
            if (mime.isEmpty() || mime.equals("application/octet-stream")) mime = typeOf(name);
            name = fileName(name, mime);
            return Build.VERSION.SDK_INT >= 29 ? toMediaStore(c, in, name, mime) : toShareSheet(c, in, name, mime);
        } finally {
            in.close();
            if (conn != null) conn.disconnect();
        }
    }

    private static String toMediaStore(Context c, InputStream in, String name, String mime) throws Exception {
        String dir;
        Uri into;
        if (mime.startsWith("image/")) {
            dir = Environment.DIRECTORY_PICTURES;
            into = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        } else if (mime.startsWith("video/")) {
            dir = Environment.DIRECTORY_MOVIES;
            into = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        } else {
            dir = Environment.DIRECTORY_DOWNLOADS;
            into = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        }
        ContentResolver r = c.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        if (!mime.isEmpty()) v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir + "/wisp");
        // Pending until written, so the gallery never shows half a file.
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = r.insert(into, v);
        if (uri == null) throw new Exception("this phone wouldn’t make the file");
        try (OutputStream out = r.openOutputStream(uri)) {
            if (out == null) throw new Exception("this phone wouldn’t open the file");
            copy(in, out);
        } catch (Exception e) {
            r.delete(uri, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        r.update(uri, v, null, null);
        return dir + "/wisp";
    }

    // Android 8 and 9: writing to shared folders needs a permission the app doesn't ask for.
    private static String toShareSheet(Context c, InputStream in, String name, String mime) throws Exception {
        File dir = new File(c.getCacheDir(), "saved");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no room on this phone");
        File f = new File(dir, name);
        try (OutputStream out = new FileOutputStream(f)) {
            copy(in, out);
        }
        Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", f);
        Intent send = new Intent(Intent.ACTION_SEND).setType(mime.isEmpty() ? "*/*" : mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        c.startActivity(Intent.createChooser(send, name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        return "";
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }

    private static String typeOf(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        String t = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return t == null ? "" : t;
    }

    // A plain file name with an extension that matches what came back.
    private static String fileName(String name, String mime) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (n.isEmpty() || n.startsWith(".")) n = "wisp" + n;
        if (n.length() > 120) n = n.substring(n.length() - 120);
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        if (ext != null && !n.toLowerCase(Locale.ROOT).endsWith("." + ext) && typeOf(n).isEmpty()) n += "." + ext;
        return n;
    }
}
