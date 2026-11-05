package com.example.my_fire_iptv

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log

/**
 * Agenda e cancela os lembretes de jogo no [AlarmManager].
 *
 * Cada lembrete também é gravado em `SharedPreferences`, porque o Android apaga todos os alarmes
 * quando a TV reinicia; o [ReagendarLembretesReceiver] usa esse registro para recriá-los.
 */
object AgendadorLembretes {

    private const val TAG = "Sintonia"
    private const val ARQUIVO_PREFERENCIAS = "lembretes"

    /** Ação do alarme que dispara o [LembreteReceiver]. */
    const val ACAO_LEMBRETE = "com.example.my_fire_iptv.ACAO_LEMBRETE"

    const val EXTRA_ID = "lembrete_id"
    const val EXTRA_TITULO = "lembrete_titulo"

    /**
     * Agenda (ou substitui) o lembrete [id] para o instante [horarioMs] (epoch em milissegundos).
     * Usa alarme exato quando o sistema permite; senão, cai para um alarme aproximado.
     */
    fun agendar(contexto: Context, id: String, titulo: String, horarioMs: Long) {
        if (horarioMs <= System.currentTimeMillis()) {
            Log.w(TAG, "Lembrete \"$id\" ignorado: o horário já passou.")
            cancelar(contexto, id)
            return
        }

        gravarRegistro(contexto, id, titulo, horarioMs)
        val alarmes = contexto.getSystemService(AlarmManager::class.java)
        val intencao = criarIntencaoPendente(contexto, id, titulo)

        // O Android 12+ (API 31) exige a permissão SCHEDULE_EXACT_ALARM concedida; sem ela, usa alarme aproximado.
        val podeExato = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmes.canScheduleExactAlarms()
        try {
            if (podeExato) {
                alarmes.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, horarioMs, intencao)
            } else {
                alarmes.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, horarioMs, intencao)
                Log.w(TAG, "Lembrete \"$id\" agendado (alarme aproximado: sem permissão de alarme exato).")
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "Alarme exato recusado pelo sistema; usando alarme aproximado.", e)
            alarmes.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, horarioMs, intencao)
        }
    }

    /** Cancela o lembrete [id], se existir. */
    fun cancelar(contexto: Context, id: String) {
        val alarmes = contexto.getSystemService(AlarmManager::class.java)
        alarmes.cancel(criarIntencaoPendente(contexto, id, ""))
        removerRegistro(contexto, id)
    }

    /** Recria os alarmes salvos (após reiniciar a TV ou atualizar o app); descarta os já vencidos. */
    fun reagendarTodos(contexto: Context) {
        val preferencias = contexto.getSharedPreferences(ARQUIVO_PREFERENCIAS, Context.MODE_PRIVATE)
        val agora = System.currentTimeMillis()
        var recriados = 0
        for ((id, valor) in preferencias.all) {
            val partes = (valor as? String)?.split('\n', limit = 2)
            val horario = partes?.getOrNull(0)?.toLongOrNull()
            if (partes == null || horario == null || horario <= agora) {
                removerRegistro(contexto, id)
                continue
            }
            agendar(contexto, id, partes.getOrElse(1) { "" }, horario)
            recriados++
        }
    }

    /** Remove o registro de um lembrete que já disparou (ou foi cancelado). */
    fun removerRegistro(contexto: Context, id: String) {
        contexto.getSharedPreferences(ARQUIVO_PREFERENCIAS, Context.MODE_PRIVATE)
            .edit().remove(id).apply()
    }

    private fun gravarRegistro(contexto: Context, id: String, titulo: String, horarioMs: Long) {
        contexto.getSharedPreferences(ARQUIVO_PREFERENCIAS, Context.MODE_PRIVATE)
            .edit().putString(id, "$horarioMs\n$titulo").apply()
    }

    /**
     * PendingIntent do alarme. O `data` com o id torna cada lembrete único para o sistema
     * (sem isso, agendar um segundo lembrete substituiria o primeiro).
     */
    private fun criarIntencaoPendente(contexto: Context, id: String, titulo: String): PendingIntent {
        val intent = Intent(contexto, LembreteReceiver::class.java).apply {
            action = ACAO_LEMBRETE
            data = Uri.parse("sintonia://lembrete/${Uri.encode(id)}")
            putExtra(EXTRA_ID, id)
            putExtra(EXTRA_TITULO, titulo)
        }
        return PendingIntent.getBroadcast(
            contexto, id.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
