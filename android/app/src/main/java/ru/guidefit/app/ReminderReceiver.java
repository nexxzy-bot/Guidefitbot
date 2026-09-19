package ru.guidefit.app;

import android.Manifest;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Показывает локальное напоминание GuideFit.
 *
 * Вызывается будильником AlarmManager (setInexactRepeating), поэтому одно и то же
 * уведомление повторяется каждый день без участия сервера и без интернета.
 */
public class ReminderReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        ReminderScheduler.ensureChannel(context);

        String title = intent == null ? null : intent.getStringExtra("title");
        String text = intent == null ? null : intent.getStringExtra("text");
        if (title == null || title.trim().isEmpty()) title = "GuideFit";
        if (text == null || text.trim().isEmpty()) text = "Пора проверить дневник 💪";

        if (!notificationsAllowed(context)) return; // пользователь не дал разрешение — молча выходим

        // Тап по уведомлению открывает приложение
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, ReminderScheduler.reqCodeFor("open", 0), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        android.app.Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new android.app.Notification.Builder(context, ReminderScheduler.CHANNEL_ID)
                : new android.app.Notification.Builder(context);

        b.setSmallIcon(R.drawable.ic_stat_guidefit)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new android.app.Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(contentIntent);

        int id = intent == null ? 1001 : intent.getIntExtra("req_code", 1001);
        nm.notify(id, b.build());
    }

    /** На Android 13+ нужен выданный системный разрешение POST_NOTIFICATIONS. */
    static boolean notificationsAllowed(Context c) {
        if (Build.VERSION.SDK_INT >= 33) {
            return c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        }
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm == null || nm.areNotificationsEnabled();
    }
}
