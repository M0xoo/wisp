package dev.trywisp.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The computers this phone reaches (v2): `{id, kind: 'ssh'|'grid', name, peer?, …}`. SSH ones carry
 * target, sshPort, port, keyId, command; grid ones url and the device token. They live here, not in
 * the page, because there's no local wisp on a phone and Reach needs them to open a tunnel by id.
 * v1 kept them in the computers screen's localStorage; the bundle copies those in once (mobile/web
 * migrate.ts). Backups are off for the app, as for the keys.
 */
final class Computers {
    private static final String KEY = "list";

    private Computers() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("wisp.computers", 0);
    }

    static synchronized JSONArray list(Context c) {
        try {
            return new JSONArray(prefs(c).getString(KEY, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static synchronized JSONObject get(Context c, String id) {
        JSONArray all = list(c);
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) return o;
        }
        return null;
    }

    /** Adds it, or merges its fields into the saved one (a learnt peer id, a new token). */
    static synchronized JSONObject save(Context c, JSONObject computer) throws JSONException {
        String id = computer.optString("id", "");
        if (id.isEmpty()) throw new JSONException("a computer needs an id");
        JSONArray all = list(c);
        JSONArray out = new JSONArray();
        JSONObject merged = null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o == null) continue;
            if (id.equals(o.optString("id"))) {
                for (Iterator<String> k = computer.keys(); k.hasNext();) {
                    String key = k.next();
                    o.put(key, computer.get(key));
                }
                merged = o;
            }
            out.put(o);
        }
        if (merged == null) {
            if (!computer.has("kind")) throw new JSONException("a new computer needs a kind");
            merged = computer;
            out.put(computer);
        }
        prefs(c).edit().putString(KEY, out.toString()).apply();
        return merged;
    }

    static synchronized void forget(Context c, String id) {
        JSONArray all = list(c);
        JSONArray out = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o != null && !id.equals(o.optString("id"))) out.put(o);
        }
        prefs(c).edit().putString(KEY, out.toString()).apply();
    }
}
