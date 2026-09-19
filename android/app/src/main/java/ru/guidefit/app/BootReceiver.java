package ru.guidefit.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * После перезагрузки телефона будильники AlarmManager сбрасываются системой,
 * поэтому расписание напоминаний нужно поставить заново — из локальных настроек.
 * Также вызывается после обновления приложения (MY_PACKAGE_REPLACED).
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            ReminderScheduler.restore(context);
        }
    }
}
