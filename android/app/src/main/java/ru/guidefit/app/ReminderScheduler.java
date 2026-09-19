package ru.guidefit.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Локальные напоминания GuideFit.
 *
 * Расписание приходит из веб-слоя (window.GuideFitNative.setReminders) и живёт только
 * на устройстве: серверу ничего не отправляется, никаких внешних сервисов не нужно.
 * Каждый пункт расписания — ежедневный будильник AlarmManager, время задаётся
 * В ЛОКАЛЬНОМ ВРЕМЕНИ УСТРОЙСТВА (веб-слой сам пересчитывает часовой пояс пользователя).
 */
final class ReminderScheduler {

    static final String PREFS = "gf_app";
    static final String KEY_JSON = "reminders_json";
    static final String CHANNEL_ID = "guidefit_reminders";

    private ReminderScheduler() {}

    /** Канал уведомлений (Android 8+) создаём заранее — иначе первые напоминания молча пропадут. */
    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Напоминания", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Напоминания о питании, воде и активности");
        nm.createNotificationChannel(ch);
    }

    /** Сохранить расписание и (пере)ставить будильники. */
    static void schedule(Context c, JSONArray entries) {
        ensureChannel(c);
        cancelAlarms(c);
        if (entries == null || entries.length() == 0) return;

        try {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_JSON, entries.toString()).apply();
        } catch (Exception ignored) { }

        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        for (int i = 0; i < entries.length(); i++) {
            JSONObject e = entries.optJSONObject(i);
            if (e == null) continue;
            int hour = clamp(e.optInt("hour", 11), 0, 23);
            int minute = clamp(e.optInt("minute", 0), 0, 59);
            String title = safe(e.optString("title", "GuideFit"), 80);
            String text = safe(e.optString("text", "Пора проверить дневник"), 300);
            int reqCode = reqCodeFor(e.optString("id", "slot" + i), i);

            PendingIntent pi = PendingIntent.getBroadcast(
                    c, reqCode, reminderIntent(c, reqCode, title, text),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Calendar next = Calendar.getInstance();
            next.set(Calendar.HOUR_OF_DAY, hour);
            next.set(Calendar.MINUTE, minute);
            next.set(Calendar.SECOND, 0);
            next.set(Calendar.MILLISECOND, 0);
            if (next.getTimeInMillis() <= System.currentTimeMillis()) {
                next.add(Calendar.DAY_OF_YEAR, 1);
            }
            // setInexactRepeating не требует разрешения на точные будильники — для напоминаний этого достаточно
            am.setInexactRepeating(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(),
                    AlarmManager.INTERVAL_DAY, pi);
        }
    }

    /** Снять будильники, но оставить сохранённое расписание (например, при паузе). */
    static void cancelAlarms(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = p.getString(KEY_JSON, null);
        if (saved == null) return;
        try {
            JSONArray arr = new JSONArray(saved);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject e = arr.optJSONObject(i);
                String id = e == null ? ("slot" + i) : e.optString("id", "slot" + i);
                int reqCode = reqCodeFor(id, i);
                PendingIntent pi = PendingIntent.getBroadcast(
                        c, reqCode, reminderIntent(c, reqCode, "", ""),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.cancel(pi);
                pi.cancel();
            }
        } catch (Exception ignored) { }
    }

    /** Полностью выключить напоминания: будильники + забыть расписание. */
    static void cancelAll(Context c) {
        cancelAlarms(c);
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_JSON).putBoolean("reminders_enabled", false).apply();
    }

    /** Переставить расписание после перезагрузки/обновления приложения. */
    static void restore(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("reminders_enabled", false)) return;
        String saved = p.getString(KEY_JSON, null);
        if (saved == null) return;
        try { schedule(c, new JSONArray(saved)); } catch (Exception ignored) { }
    }

    static void setEnabled(Context c, boolean enabled) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("reminders_enabled", enabled).apply();
        if (!enabled) cancelAll(c);
    }

    static boolean isEnabled(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean("reminders_enabled", false);
    }

    static Intent reminderIntent(Context c, int reqCode, String title, String text) {
        Intent i = new Intent(c, ReminderReceiver.class);
        i.putExtra("req_code", reqCode);
        i.putExtra("title", title);
        i.putExtra("text", text);
        return i;
    }

    /** Устойчивый requestCode: один и тот же id всегда даёт один и тот же код. */
    static int reqCodeFor(String id, int fallbackIndex) {
        int h = 17;
        String s = id == null ? "" : id;
        for (int i = 0; i < s.length(); i++) h = h * 31 + s.charAt(i);
        int code = Math.abs(h % 100000);
        return code == 0 ? 100000 + fallbackIndex : code;
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static String safe(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) : s;
    }
}
