package com.example.my_fire_iptv

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Recebe o alarme de um lembrete de jogo (agendado pelo [AgendadorLembretes]) e exibe a notificação.
 *
 * A notificação usa prioridade alta (canal com importância alta) para aparecer brevemente
 * sobre o vídeo no Fire TV / Android TV, e some sozinha depois de alguns segundos.
 */
class LembreteReceiver : BroadcastReceiver() {

    override fun onReceive(contexto: Context, intent: Intent) {
        if (intent.action != AgendadorLembretes.ACAO_LEMBRETE) return

        val id = intent.getStringExtra(AgendadorLembretes.EXTRA_ID).orEmpty()
        val titulo = intent.getStringExtra(AgendadorLembretes.EXTRA_TITULO).orEmpty()
        Log.i(TAG, "Lembrete \"$id\" disparou.")

        // O alarme já foi consumido: não deve ser recriado ao reiniciar a TV.
        AgendadorLembretes.removerRegistro(contexto, id)
        exibirNotificacao(contexto, id, titulo)
    }

    @SuppressLint("MissingPermission") // a permissão é conferida com areNotificationsEnabled()
    private fun exibirNotificacao(contexto: Context, id: String, titulo: String) {
        val gerenciador = NotificationManagerCompat.from(contexto)
        if (!gerenciador.areNotificationsEnabled()) {
            Log.w(TAG, "Notificações desativadas para o app; lembrete \"$id\" não será exibido.")
            return
        }
        criarCanal(contexto)

        // Tocar na notificação abre o app e a interface mostra o jogo do lembrete.
        val abrirApp = Intent(contexto, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(AgendadorLembretes.EXTRA_ID, id)
        }
        val intencaoAbrir = PendingIntent.getActivity(
            contexto, id.hashCode(), abrirApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notificacao = NotificationCompat.Builder(contexto, CANAL_ID)
            .setSmallIcon(R.drawable.ic_notificacao)
            .setContentTitle(contexto.getString(R.string.lembrete_titulo))
            .setContentText(titulo)
            .setPriority(NotificationCompat.PRIORITY_HIGH) // aparece sobre o vídeo (heads-up) no Android < 8
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setContentIntent(intencaoAbrir)
            .setAutoCancel(true)
            .setTimeoutAfter(TEMPO_NA_TELA_MS) // some sozinha: "aparecer brevemente"
            .build()

        gerenciador.notify(id.hashCode(), notificacao)
    }

    /** Cria o canal de notificação (Android 8+) com importância alta. */
    private fun criarCanal(contexto: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val canal = NotificationChannel(
            CANAL_ID,
            contexto.getString(R.string.lembrete_canal_nome),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = contexto.getString(R.string.lembrete_canal_descricao)
        }
        contexto.getSystemService(NotificationManager::class.java).createNotificationChannel(canal)
    }

    private companion object {
        const val TAG = "Sintonia"
        const val CANAL_ID = "lembretes_de_jogos"
        const val TEMPO_NA_TELA_MS = 15_000L
    }
}
