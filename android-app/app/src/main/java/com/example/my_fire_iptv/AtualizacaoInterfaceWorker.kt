package com.example.my_fire_iptv

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Atualiza em segundo plano a interface web (OTA), sem precisar de um APK novo.
 *
 * Fluxo:
 *  1. baixa `version.json` do GitHub Pages (só o hash do commit publicado);
 *  2. compara com a versão que o app já instalou ([GerenciadorInterface.versaoInstalada]);
 *  3. se há versão nova **e o ExoPlayer não está reproduzindo** ([EstadoReproducao]), baixa `arquivos.json`
 *     e cada arquivo da interface para uma pasta temporária, conferindo tamanho e SHA-256;
 *  4. só então troca a pasta `filesDir/app/` pela nova.
 *
 * A [MainActivity] passa a usar a interface nova na próxima abertura; se ela não carregar,
 * volta sozinha para a interface empacotada no APK.
 */
class AtualizacaoInterfaceWorker(contexto: Context, parametros: WorkerParameters) :
    Worker(contexto, parametros) {

    override fun doWork(): Result {
        val manual = inputData.getBoolean(ENTRADA_MANUAL, false)
        return try {
            val (estado, detalhe) = verificarEAtualizar()
            when {
                // Em segundo plano, tenta de novo mais tarde (o vídeo pode ter terminado).
                estado == ESTADO_ADIADA && !manual -> Result.retry()
                else -> Result.success(montarSaida(estado, detalhe))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao atualizar a interface (tentativa ${runAttemptCount + 1})", e)
            val mensagem = e.message ?: e.javaClass.simpleName
            when {
                manual -> Result.success(montarSaida(ESTADO_ERRO, mensagem))
                runAttemptCount + 1 >= MAX_TENTATIVAS -> Result.failure() // a próxima janela de 24 h tenta de novo
                else -> Result.retry()
            }
        }
    }

    /** @return o estado final ([ESTADO_ATUALIZADA], [ESTADO_INSTALADA] ou [ESTADO_ADIADA]) e a versão envolvida. */
    private fun verificarEAtualizar(): Pair<String, String> {
        val contexto = applicationContext
        GerenciadorInterface.descartarSeApkMudou(contexto)

        // 1) versão publicada x versão instalada
        val remota = lerVersaoRemota()
        val local = GerenciadorInterface.versaoInstalada(contexto)
        if (remota == local) return ESTADO_ATUALIZADA to remota
        if (!inputData.getBoolean(ENTRADA_MANUAL, false) && remota == GerenciadorInterface.versaoRecusada(contexto)) {
            Log.w(TAG, "A versão $remota já falhou ao carregar neste aparelho; não será baixada de novo.")
            return ESTADO_ATUALIZADA to remota
        }

        // 2) nunca baixa nem troca a interface durante um vídeo
        if (EstadoReproducao.reproduzindo) {
            return ESTADO_ADIADA to remota
        }

        // 3) lista de arquivos da versão publicada
        val manifesto = JSONObject(lerTexto(URL_BASE + "arquivos.json?v=$remota"))
        if (manifesto.optString("versao") != remota) {
            throw IOException("Publicação em andamento: a lista de arquivos é de outra versão")
        }
        val itens = manifesto.getJSONArray("arquivos")
        if (itens.length() < 1 || itens.length() > MAX_ARQUIVOS) {
            throw IOException("Quantidade de arquivos inválida na publicação: ${itens.length()}")
        }

        // 4) baixa tudo para a pasta temporária; qualquer erro apaga o que foi baixado
        val temporaria = GerenciadorInterface.pastaTemporaria(contexto)
        temporaria.deleteRecursively()
        if (!temporaria.mkdirs()) throw IOException("Não foi possível criar a pasta temporária da interface")
        try {
            var totalBytes = 0L
            for (i in 0 until itens.length()) {
                if (isStopped) throw IOException("Trabalho interrompido pelo sistema")
                if (EstadoReproducao.reproduzindo) {
                    return ESTADO_ADIADA to remota
                }
                val item = itens.getJSONObject(i)
                val caminho = item.getString("caminho")
                val tamanho = item.getLong("tamanho")
                val sha256 = item.getString("sha256").lowercase()
                if (!caminhoSeguro(caminho)) throw IOException("Caminho recusado na publicação: $caminho")
                if (tamanho < 0 || tamanho > MAX_BYTES_ARQUIVO) throw IOException("Tamanho inválido para $caminho: $tamanho")
                totalBytes += tamanho
                if (totalBytes > MAX_BYTES_TOTAL) throw IOException("A interface excede o limite de tamanho")

                val destino = File(temporaria, caminho)
                // reforço: o arquivo precisa ficar mesmo dentro da pasta temporária
                if (!destino.canonicalPath.startsWith(temporaria.canonicalPath + File.separator)) {
                    throw IOException("Caminho fora da pasta da interface: $caminho")
                }
                baixarArquivo(URL_BASE + caminho + "?v=$remota", destino, tamanho, sha256)
            }
            if (!File(temporaria, "index.html").isFile) throw IOException("A publicação não contém o index.html")

            // última checagem: um vídeo pode ter começado durante o último arquivo
            if (EstadoReproducao.reproduzindo) return ESTADO_ADIADA to remota

            GerenciadorInterface.instalar(contexto, temporaria, remota)
            return ESTADO_INSTALADA to remota
        } finally {
            temporaria.deleteRecursively() // após a troca bem-sucedida a pasta já não existe
        }
    }

    /** Lê `version.json` e devolve o hash publicado, validando o formato. */
    private fun lerVersaoRemota(): String {
        val versao = JSONObject(lerTexto(URL_BASE + "version.json?t=${System.currentTimeMillis()}"))
            .optString("versao")
        if (!REGEX_VERSAO.matches(versao)) throw IOException("version.json com versão inválida: \"$versao\"")
        return versao
    }

    /** Aceita só caminhos relativos simples (sem `..`, sem barra inicial, sem caracteres estranhos). */
    private fun caminhoSeguro(caminho: String): Boolean =
        REGEX_CAMINHO.matches(caminho) && caminho.split('/').none { it.isEmpty() || it == "." || it == ".." }

    /** Abre uma conexão HTTPS (só HTTPS) com tempos limite e sem cache. */
    private fun abrir(endereco: String): HttpURLConnection {
        if (!endereco.startsWith("https://")) throw IOException("Endereço sem HTTPS recusado: $endereco")
        val conexao = URL(endereco).openConnection() as HttpURLConnection
        conexao.connectTimeout = TEMPO_CONEXAO_MS
        conexao.readTimeout = TEMPO_LEITURA_MS
        conexao.useCaches = false
        conexao.setRequestProperty("Cache-Control", "no-cache")
        conexao.setRequestProperty("User-Agent", "Sintonia-OTA/1.0")
        val codigo = conexao.responseCode
        if (codigo != HttpURLConnection.HTTP_OK) {
            conexao.disconnect()
            throw IOException("HTTP $codigo em $endereco")
        }
        return conexao
    }

    /** Baixa um texto pequeno (JSON de controle), com limite de tamanho. */
    private fun lerTexto(endereco: String): String {
        val conexao = abrir(endereco)
        try {
            conexao.inputStream.use { entrada ->
                val bytes = entrada.readNBytesLimitado(MAX_BYTES_JSON)
                return String(bytes, Charsets.UTF_8)
            }
        } finally {
            conexao.disconnect()
        }
    }

    /** Baixa um arquivo para [destino] e confere tamanho e SHA-256 declarados na publicação. */
    private fun baixarArquivo(endereco: String, destino: File, tamanho: Long, sha256Esperado: String) {
        destino.parentFile?.mkdirs()
        val resumo = MessageDigest.getInstance("SHA-256")
        val conexao = abrir(endereco)
        try {
            var lidos = 0L
            conexao.inputStream.use { entrada ->
                FileOutputStream(destino).use { saida ->
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val n = entrada.read(buffer)
                        if (n < 0) break
                        lidos += n
                        if (lidos > tamanho) throw IOException("${destino.name} é maior que o declarado")
                        resumo.update(buffer, 0, n)
                        saida.write(buffer, 0, n)
                    }
                }
            }
            if (lidos != tamanho) throw IOException("${destino.name} incompleto: $lidos de $tamanho bytes")
            val sha256 = resumo.digest().joinToString("") { "%02x".format(it) }
            if (sha256 != sha256Esperado) throw IOException("${destino.name} corrompido (SHA-256 diferente)")
        } finally {
            conexao.disconnect()
        }
    }

    /** Lê no máximo [limite] bytes; acima disso a resposta é recusada. */
    private fun java.io.InputStream.readNBytesLimitado(limite: Int): ByteArray {
        val saida = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val n = read(buffer)
            if (n < 0) break
            if (saida.size() + n > limite) throw IOException("Resposta maior que o limite de $limite bytes")
            saida.write(buffer, 0, n)
        }
        return saida.toByteArray()
    }

    private fun montarSaida(estado: String, detalhe: String): Data =
        Data.Builder().putString(SAIDA_ESTADO, estado).putString(SAIDA_DETALHE, detalhe).build()

    companion object {
        private const val TAG = "Sintonia"

        /**
         * Endereço do GitHub Pages que publica a interface (workflow `atualizar-interface.yml`).
         * Se o repositório ou o usuário do GitHub mudar, é aqui que se troca.
         */
        const val URL_BASE = "https://terciojorge.github.io/sintonia/"

        private const val NOME_TRABALHO_PERIODICO = "atualizacao_interface"
        private const val INTERVALO_HORAS = 24L

        const val ENTRADA_MANUAL = "manual"
        const val SAIDA_ESTADO = "estado"
        const val SAIDA_DETALHE = "detalhe"

        /** Já está na versão mais nova. */
        const val ESTADO_ATUALIZADA = "ATUALIZADA"

        /** Versão nova baixada e instalada; vale na próxima abertura. */
        const val ESTADO_INSTALADA = "INSTALADA"

        /** Há vídeo reproduzindo; nada foi baixado. */
        const val ESTADO_ADIADA = "ADIADA"
        const val ESTADO_ERRO = "ERRO"

        private const val MAX_TENTATIVAS = 5
        private const val MAX_ARQUIVOS = 200
        private const val MAX_BYTES_ARQUIVO = 20L * 1024 * 1024
        private const val MAX_BYTES_TOTAL = 60L * 1024 * 1024
        private const val MAX_BYTES_JSON = 256 * 1024
        private const val TEMPO_CONEXAO_MS = 15_000
        private const val TEMPO_LEITURA_MS = 30_000

        private val REGEX_VERSAO = Regex("[A-Za-z0-9._-]{1,64}")
        private val REGEX_CAMINHO = Regex("[A-Za-z0-9_][A-Za-z0-9_./-]{0,150}")

        private fun restricoes() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        /**
         * Agenda a verificação periódica (a cada 24 h, só com rede). Chamar de novo é seguro:
         * o agendamento existente é mantido.
         */
        fun agendar(contexto: Context) {
            val pedido = PeriodicWorkRequest.Builder(
                AtualizacaoInterfaceWorker::class.java, INTERVALO_HORAS, TimeUnit.HOURS
            )
                .setConstraints(restricoes())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(contexto).enqueueUniquePeriodicWork(
                NOME_TRABALHO_PERIODICO, ExistingPeriodicWorkPolicy.KEEP, pedido
            )
        }

        /**
         * Pedido avulso, para o botão "Verificar Atualização" dos Ajustes. Sem restrição de rede:
         * sem internet ele falha na hora e a interface mostra o erro, em vez de esperar sem fim.
         */
        fun criarPedidoManual(): OneTimeWorkRequest =
            OneTimeWorkRequest.Builder(AtualizacaoInterfaceWorker::class.java)
                .setInputData(Data.Builder().putBoolean(ENTRADA_MANUAL, true).build())
                .build()
    }
}
