package com.example.my_fire_iptv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Recria os alarmes de lembrete depois que a TV reinicia ou que o app é atualizado
 * (o Android apaga os alarmes nesses casos).
 */
class ReagendarLembretesReceiver : BroadcastReceiver() {

    override fun onReceive(contexto: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                AgendadorLembretes.reagendarTodos(contexto)
            }
        }
    }
}
