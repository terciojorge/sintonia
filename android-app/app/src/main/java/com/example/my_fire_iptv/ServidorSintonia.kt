package com.example.my_fire_iptv

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Servidor HTTP local que substitui o serviço de pareamento do webOS.
 *
 * O usuário lê o QR Code na TV, abre esta página no celular (mesma rede Wi-Fi), preenche o nome e a
 * URL da lista e envia. O POST é repassado ao app por [aoReceberLista], que injeta o resultado no
 * WebView (`window.sintoniaReceberLista`).
 *
 * Segurança: o pareamento só é aceito enquanto a tela do QR Code está aberta, e só para quem trouxe
 * o token que está no QR Code. Fora disso, qualquer acesso recebe 403.
 *
 * @param aoReceberLista chamado (em thread do servidor) com o nome e a URL já validados;
 *   devolve `true` se conseguiu entregar a lista à interface.
 */
class ServidorSintonia(
    private val aoReceberLista: (nome: String, url: String) -> Boolean
) : NanoHTTPD(PORTA) {

    /** Token do pareamento em andamento; `null` quando a tela do QR Code está fechada. */
    @Volatile
    private var token: String? = null

    /** Abre um novo pareamento e devolve o token que deve ir no QR Code (invalida o anterior). */
    fun iniciarPareamento(): String {
        val bytes = ByteArray(8).also { SecureRandom().nextBytes(it) }
        val novo = bytes.joinToString("") { "%02x".format(it) }
        token = novo
        Log.i(TAG, "Pareamento aberto: servidor aguardando o celular.")
        return novo
    }

    /** Encerra o pareamento: a partir daqui nenhuma requisição é aceita. */
    fun encerrarPareamento() {
        if (token != null) Log.i(TAG, "Pareamento encerrado.")
        token = null
    }

    override fun serve(sessao: IHTTPSession): Response {
        return try {
            when {
                sessao.uri != "/" -> resposta(Response.Status.NOT_FOUND, paginaMensagem("Página não encontrada.", erro = true))
                sessao.method == Method.GET -> atenderFormulario(sessao)
                sessao.method == Method.POST -> atenderEnvio(sessao)
                else -> resposta(Response.Status.METHOD_NOT_ALLOWED, paginaMensagem("Método não permitido.", erro = true))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao atender requisição do celular", e)
            resposta(Response.Status.INTERNAL_ERROR, paginaMensagem("Erro interno na TV. Tente de novo.", erro = true))
        }
    }

    /** GET /: devolve o formulário (somente com o token correto do QR Code). */
    private fun atenderFormulario(sessao: IHTTPSession): Response {
        val tokenRecebido = sessao.parameters["t"]?.firstOrNull()
        if (!tokenValido(tokenRecebido)) return recusarSemToken()
        Log.i(TAG, "Celular abriu a página de pareamento.")
        return resposta(Response.Status.OK, PAGINA_FORMULARIO.replace("{{TOKEN}}", tokenRecebido.orEmpty()))
    }

    /** POST /: valida o formulário e entrega a lista à interface web. */
    private fun atenderEnvio(sessao: IHTTPSession): Response {
        val tamanho = sessao.headers["content-length"]?.toLongOrNull() ?: 0L
        if (tamanho > LIMITE_CORPO_BYTES) {
            return resposta(Response.Status.BAD_REQUEST, paginaMensagem("Dados grandes demais.", erro = true))
        }

        // O corpo do formulário só fica disponível em `parameters` depois de parseBody.
        sessao.parseBody(HashMap())
        val campos = sessao.parameters

        if (!tokenValido(campos["t"]?.firstOrNull())) return recusarSemToken()

        val nome = campos["nome"]?.firstOrNull().orEmpty().trim()
        val url = campos["url"]?.firstOrNull().orEmpty().trim()

        if (nome.isEmpty() || nome.length > TAMANHO_MAXIMO_NOME) {
            return resposta(Response.Status.BAD_REQUEST, paginaMensagem("Informe o nome da lista (até $TAMANHO_MAXIMO_NOME letras).", erro = true))
        }
        if (!REGEX_URL.matches(url) || url.length > TAMANHO_MAXIMO_URL) {
            return resposta(Response.Status.BAD_REQUEST, paginaMensagem("Informe uma URL válida, começando com http:// ou https://.", erro = true))
        }

        Log.i(TAG, "Lista recebida do celular: \"$nome\"")
        // A URL pode conter usuário e senha do provedor: nunca vai para o log.
        if (!aoReceberLista(nome, url)) {
            return resposta(Response.Status.SERVICE_UNAVAILABLE, paginaMensagem("A TV ainda não está pronta. Tente de novo em instantes.", erro = true))
        }
        return resposta(Response.Status.OK, paginaMensagem("Lista \"${escaparHtml(nome)}\" enviada! Pode olhar para a TV.", erro = false))
    }

    private fun recusarSemToken(): Response {
        Log.w(TAG, "Requisição recusada: pareamento fechado ou token inválido.")
        return resposta(Response.Status.FORBIDDEN, paginaMensagem("Leia o QR Code da TV de novo.", erro = true))
    }

    /** Compara o token recebido com o atual, em tempo constante. */
    private fun tokenValido(recebido: String?): Boolean {
        val atual = token ?: return false
        if (recebido == null) return false
        return MessageDigest.isEqual(atual.toByteArray(), recebido.toByteArray())
    }

    private fun resposta(status: Response.IStatus, html: String): Response =
        newFixedLengthResponse(status, "text/html; charset=utf-8", html).apply {
            addHeader("Cache-Control", "no-store")
        }

    companion object {
        private const val TAG = "Sintonia"

        /** Porta do servidor de pareamento. */
        const val PORTA = 8080

        private const val LIMITE_CORPO_BYTES = 8192L
        private const val TAMANHO_MAXIMO_NOME = 40
        private const val TAMANHO_MAXIMO_URL = 2000
        private val REGEX_URL = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)

        /**
         * Endereço IPv4 da rede local da TV (ex.: 192.168.1.10), ou `""` se não houver rede.
         * Dá preferência a endereços privados (Wi-Fi/Ethernet) e ignora loopback e link-local.
         */
        fun obterIpLocal(): String {
            return try {
                val enderecos = NetworkInterface.getNetworkInterfaces().toList()
                    .filter { it.isUp && !it.isLoopback }
                    .flatMap { it.inetAddresses.toList() }
                    .filterIsInstance<Inet4Address>()
                    .filter { !it.isLoopbackAddress && !it.isLinkLocalAddress }
                (enderecos.firstOrNull { it.isSiteLocalAddress } ?: enderecos.firstOrNull())
                    ?.hostAddress.orEmpty()
            } catch (e: Exception) {
                Log.e(TAG, "Não foi possível ler as interfaces de rede", e)
                ""
            }
        }

        /** Escapa texto do usuário antes de colocá-lo em HTML. */
        private fun escaparHtml(texto: String): String = texto
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&#39;")

        private fun paginaMensagem(mensagem: String, erro: Boolean): String {
            val cor = if (erro) "#ff453a" else "#30d158"
            return """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sintonia</title>
<style>$ESTILO</style></head><body><h1>Sintonia</h1>
<p class="msg" role="status" style="color:$cor">$mensagem</p></body></html>"""
        }

        private const val ESTILO =
            "body{margin:0;background:#000;color:#f2f2f7;font:18px/1.4 system-ui,Arial,sans-serif;padding:24px 16px;max-width:560px;margin:auto}" +
                "h1{font-size:28px;margin:0 0 8px}p{color:#aeaeb2;margin:0 0 20px}.msg{font-weight:700;font-size:20px}" +
                "label{display:block;margin:16px 0 6px;font-weight:600}" +
                "input{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #3a3a40;background:#16161b;color:#fff;font-size:16px}" +
                "button{width:100%;margin-top:24px;padding:16px;border:0;border-radius:14px;background:#0a84ff;color:#fff;font-size:18px;font-weight:700}"

        /** Página do formulário. `{{TOKEN}}` é trocado pelo token do QR Code. */
        private val PAGINA_FORMULARIO = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sintonia</title>
<style>$ESTILO</style></head><body>
<h1>Sintonia</h1>
<p>Dê um nome à lista e cole o link que o provedor enviou.</p>
<form method="post" action="/">
<input type="hidden" name="t" value="{{TOKEN}}">
<label for="nome">Nome da Lista</label>
<input id="nome" name="nome" type="text" required maxlength="40" autocomplete="off">
<label for="url">URL da Lista</label>
<input id="url" name="url" type="url" required inputmode="url" autocomplete="off" autocapitalize="off" placeholder="http://...">
<button type="submit">Enviar para a TV</button>
</form></body></html>"""
    }
}
