package com.example.my_fire_iptv

import android.content.Context
import android.net.Uri
import android.util.Log
import java.io.File
import java.io.IOException

/**
 * Estado de reprodução visível para fora da [MainActivity].
 *
 * O [AtualizacaoInterfaceWorker] roda em outra thread (e pode rodar até com o app fechado) e não pode
 * tocar no ExoPlayer; a [MainActivity] mantém este valor atualizado e o Worker apenas o lê.
 */
object EstadoReproducao {
    /** `true` enquanto o ExoPlayer está carregando ou reproduzindo (não pausado, parado ou concluído). */
    @Volatile
    var reproduzindo: Boolean = false
}

/**
 * Decide de onde a interface web é carregada e guarda a versão baixada por atualização OTA.
 *
 * Duas cópias da interface podem existir:
 *  - a **empacotada** no APK: `file:///android_asset/app/index.html` (sempre disponível, serve de reserva);
 *  - a **baixada** pelo Worker: `Context.filesDir/app/index.html` (tem prioridade quando válida).
 *
 * Uma cópia baixada só vale enquanto o APK instalado for o mesmo que a recebeu. Se o app for
 * atualizado ou reinstalado, a cópia é descartada, para uma interface antiga baixada nunca
 * esconder uma interface mais nova que veio no APK.
 */
object GerenciadorInterface {
    private const val TAG = "Sintonia"

    /** Interface empacotada no APK (reserva). */
    const val URL_ASSETS = "file:///android_asset/app/index.html"
    const val PREFIXO_ASSETS = "file:///android_asset/app/"

    /** Pasta da interface baixada, dentro de `filesDir`. */
    private const val DIR_OTA = "app"

    /** Pasta temporária onde o Worker monta a interface nova antes da troca. */
    const val DIR_NOVO = "app_novo"
    private const val DIR_ANTIGO = "app_antigo"

    private const val PREFS = "interface_ota"
    private const val CHAVE_VERSAO = "versao"
    private const val CHAVE_APK = "apk_atualizado_em"
    private const val CHAVE_RECUSADA = "versao_recusada"

    /** Rótulo mostrado nos Ajustes enquanto nenhuma interface baixada está em uso. */
    private const val ROTULO_EMPACOTADA = "do app"

    private fun prefs(contexto: Context) =
        contexto.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun pasta(contexto: Context) = File(contexto.filesDir, DIR_OTA)

    /** Carimbo da última instalação/atualização do APK; muda a cada novo APK instalado. */
    private fun carimboDoApk(contexto: Context): Long = try {
        contexto.packageManager.getPackageInfo(contexto.packageName, 0).lastUpdateTime
    } catch (e: Exception) {
        Log.w(TAG, "Não foi possível ler a data de instalação do app", e)
        0L
    }

    /** Pasta onde o Worker deve montar a interface nova. */
    fun pastaTemporaria(contexto: Context) = File(contexto.filesDir, DIR_NOVO)

    /** Endereço `file://` da interface baixada. */
    fun urlOta(contexto: Context): String = Uri.fromFile(File(pasta(contexto), "index.html")).toString()

    /** Prefixo `file://` de qualquer arquivo da interface baixada (para liberar a navegação). */
    fun prefixoOta(contexto: Context): String = Uri.fromFile(pasta(contexto)).toString() + "/"

    /** Existe uma interface baixada, íntegra e compatível com o APK atual? */
    @Synchronized
    fun otaValida(contexto: Context): Boolean {
        val p = prefs(contexto)
        return !p.getString(CHAVE_VERSAO, null).isNullOrEmpty() &&
            p.getLong(CHAVE_APK, -1L) == carimboDoApk(contexto) &&
            File(pasta(contexto), "index.html").isFile
    }

    /** Endereço que o WebView deve abrir: a interface baixada, se válida; senão a empacotada. */
    fun urlInicial(contexto: Context): String =
        if (otaValida(contexto)) urlOta(contexto) else URL_ASSETS

    /** Versão (hash do commit) da interface baixada em uso; vazio se está usando a do APK. */
    fun versaoInstalada(contexto: Context): String =
        if (otaValida(contexto)) prefs(contexto).getString(CHAVE_VERSAO, "").orEmpty() else ""

    /** Texto curto da versão da interface, para a tela Sobre. */
    fun versaoParaExibir(contexto: Context): String =
        versaoInstalada(contexto).take(7).ifEmpty { ROTULO_EMPACOTADA }

    /** Última versão baixada que falhou ao carregar; o Worker não a baixa de novo. */
    fun versaoRecusada(contexto: Context): String =
        prefs(contexto).getString(CHAVE_RECUSADA, "").orEmpty()

    /** Descarta a interface baixada se ela veio de um APK diferente do atual. */
    @Synchronized
    fun descartarSeApkMudou(contexto: Context) {
        val p = prefs(contexto)
        if (p.getString(CHAVE_VERSAO, null).isNullOrEmpty() && !pasta(contexto).exists()) return
        if (p.getLong(CHAVE_APK, -1L) != carimboDoApk(contexto)) {
            descartar(contexto, "APK diferente do que baixou a interface", recusar = false)
        }
    }

    /**
     * Apaga a interface baixada; o app volta a usar a empacotada.
     * Com [recusar], a versão apagada é lembrada para o Worker não tentar baixá-la de novo.
     */
    @Synchronized
    fun descartar(contexto: Context, motivo: String, recusar: Boolean) {
        val p = prefs(contexto)
        val versao = p.getString(CHAVE_VERSAO, "").orEmpty()
        Log.w(TAG, "Descartando a interface baixada ($motivo).")
        pasta(contexto).deleteRecursively()
        val editor = p.edit().remove(CHAVE_VERSAO).remove(CHAVE_APK)
        if (recusar && versao.isNotEmpty()) editor.putString(CHAVE_RECUSADA, versao)
        editor.commit()
    }

    /**
     * Coloca a interface montada em [novo] no lugar da atual e registra a [versao].
     * A troca é por renomeação de pastas; se algo falhar, a interface anterior é restaurada.
     */
    @Synchronized
    fun instalar(contexto: Context, novo: File, versao: String) {
        val atual = pasta(contexto)
        val antiga = File(contexto.filesDir, DIR_ANTIGO)
        antiga.deleteRecursively()

        if (atual.exists() && !atual.renameTo(antiga)) {
            throw IOException("Não foi possível guardar a interface atual antes da troca")
        }
        if (!novo.renameTo(atual)) {
            if (antiga.exists()) antiga.renameTo(atual) // restaura a anterior
            throw IOException("Não foi possível ativar a interface nova")
        }

        prefs(contexto).edit()
            .putString(CHAVE_VERSAO, versao)
            .putLong(CHAVE_APK, carimboDoApk(contexto))
            .remove(CHAVE_RECUSADA)
            .commit()
        antiga.deleteRecursively()
    }
}
