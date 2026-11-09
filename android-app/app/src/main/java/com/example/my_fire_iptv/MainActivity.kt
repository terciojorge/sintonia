package com.example.my_fire_iptv

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Observer
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException

/**
 * Tela única do Sintonia para Fire TV.
 *
 * Estrutura em camadas:
 *  - [PlayerView] (ExoPlayer/Media3) no fundo, responsável por decodificar e desenhar o vídeo;
 *  - [WebView] transparente por cima, com a interface web. Ela vem da cópia baixada em
 *    `filesDir/app/` (atualização OTA, ver [AtualizacaoInterfaceWorker]) quando válida; senão, ou se a
 *    cópia baixada falhar ao carregar, da interface empacotada em `assets/app/`.
 *
 * O JavaScript controla o vídeo pelo [SintoniaBridge] e recebe os estados do player
 * pela função global `window.sintoniaStatusVideo(status, detalhe)`.
 */
@OptIn(UnstableApi::class) // exigido pelo compilador Kotlin
@androidx.annotation.OptIn(UnstableApi::class) // exigido pelo lint do Android (Media3)
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var playerView: PlayerView
    private lateinit var exoPlayer: ExoPlayer
    private lateinit var servidor: ServidorSintonia

    private val handlerPrincipal = Handler(Looper.getMainLooper())

    /** Indica se a página terminou de carregar (antes disso o JavaScript ainda não está pronto). */
    @Volatile
    private var paginaCarregada = false

    // Valores em cache para as consultas rápidas do JavaScript. O ExoPlayer só pode ser acessado
    // pela thread principal, mas o JavaScript chama a ponte em outra thread; por isso a thread
    // principal atualiza estes campos e a ponte apenas os lê.
    @Volatile
    private var posicaoAtualMs: Long = 0L

    /** Duração total em ms; `-1` quando desconhecida ou quando o conteúdo é ao vivo. */
    @Volatile
    private var duracaoTotalMs: Long = -1L

    @Volatile
    private var larguraVideoPx: Int = 0

    /** Indica se o servidor de pareamento (porta 8080) subiu com sucesso. */
    @Volatile
    private var servidorAtivo = false

    /**
     * Id do lembrete cuja notificação abriu o app, ainda não entregue à interface.
     * A interface o busca ao iniciar ([SintoniaBridge.obterLembreteDeAbertura]) ou o recebe
     * direto quando o app já estava aberto ([onNewIntent]).
     */
    @Volatile
    private var lembreteDeAbertura: String? = null

    /** Já pedimos a permissão de notificações nesta sessão? (evita insistir a cada lembrete) */
    private var permissaoNotificacaoPedida = false

    private val pedirPermissaoNotificacao =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Sem ação: se for negada, o lembrete é agendado mesmo assim e o LembreteReceiver avisa que não pode exibir.
        }

    /** Diálogo de digitação aberto no momento (só um por vez); `null` quando não há nenhum. */
    private var dialogoTeclado: AlertDialog? = null

    /** A interface web já avisou, por [SintoniaBridge.interfaceCarregada], que iniciou de verdade? */
    @Volatile
    private var interfaceSinalizou = false

    /** Imagem de abertura sobre a WebView; some em `onPageFinished`, quando o HTML termina de carregar. */
    private lateinit var splashScreen: ImageView

    /** Reserva: se a página nunca terminar de carregar, a imagem de abertura sai sozinha para não prender o usuário. */
    private val removerSplashPorTempo = Runnable { esconderSplash() }

    /** Confere, um tempo depois do carregamento, se a interface baixada realmente iniciou. */
    private val vigiaDaInterface = Runnable {
        if (!interfaceSinalizou && estaNaInterfaceBaixada()) {
            voltarParaInterfaceEmpacotada("a interface baixada abriu mas não sinalizou que iniciou")
        }
    }

    /** Último status enviado ao JavaScript (evita repetir o mesmo estado). */
    private var ultimoStatus: String? = null

    /** Atualiza periodicamente posição e duração em cache. */
    private val atualizadorDePosicao = object : Runnable {
        override fun run() {
            atualizarCacheDoPlayer()
            handlerPrincipal.postDelayed(this, INTERVALO_POSICAO_MS)
        }
    }

    /** Observa o ExoPlayer e informa a interface web sobre cada mudança de estado. */
    private val ouvinteDoPlayer = object : Player.Listener {
        override fun onPlaybackStateChanged(estado: Int) {
            atualizarEstadoDeReproducao()
            atualizarCacheDoPlayer()
            notificarStatus()
        }

        override fun onPlayWhenReadyChanged(reproduzirQuandoPronto: Boolean, motivo: Int) {
            atualizarEstadoDeReproducao()
            notificarStatus()
        }

        override fun onVideoSizeChanged(tamanho: VideoSize) {
            larguraVideoPx = tamanho.width
        }

        override fun onPlayerError(erro: PlaybackException) {
            // Em transmissões ao vivo, ficar para trás da janela do HLS é recuperável: reposiciona e segue.
            if (erro.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                Log.w(TAG, "Player ficou para trás da janela ao vivo; reposicionando.")
                exoPlayer.seekToDefaultPosition()
                exoPlayer.prepare()
                return
            }
            Log.e(TAG, "Erro de reprodução: ${erro.errorCodeName}", erro)
            atualizarEstadoDeReproducao()
            ultimoStatus = STATUS_ERRO
            enviarStatusParaWeb(STATUS_ERRO, erro.errorCodeName)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // Mantém a tela ligada enquanto o app está visível: sem isso a Fire TV ativa o protetor de tela
        // no meio de um filme. O sistema solta o bloqueio sozinho ao sair do app.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        entrarEmTelaCheia()

        playerView = findViewById(R.id.playerView)
        webView = findViewById(R.id.webview)
        splashScreen = findViewById(R.id.splashScreen)
        handlerPrincipal.postDelayed(removerSplashPorTempo, TEMPO_MAXIMO_SPLASH_MS)
        lembreteDeAbertura = intent?.getStringExtra(AgendadorLembretes.EXTRA_ID)

        // Uma interface baixada por um APK anterior não pode esconder a que veio neste APK.
        GerenciadorInterface.descartarSeApkMudou(this)

        // Permite inspecionar a interface pelo Chrome (chrome://inspect), mas só em builds de debug:
        // num APK de release a ponte nativa não pode ficar exposta à depuração por USB.
        WebView.setWebContentsDebuggingEnabled(
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        )

        configurarPlayer()
        configurarWebView(webView)
        // O controle remoto só chega à interface se o WebView tiver o foco.
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.requestFocus()
        iniciarServidor()

        // Em versões recentes do Android o botão Voltar pode chegar pelo dispatcher
        // em vez de KEYCODE_BACK; os dois caminhos usam a mesma lógica.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                tratarVoltar()
            }
        })

        if (savedInstanceState == null) {
            carregarInterface()
        } else {
            webView.restoreState(savedInstanceState)
        }

        // Verificação periódica (24 h) da interface nova no GitHub Pages; já agendada = mantida.
        AtualizacaoInterfaceWorker.agendar(applicationContext)
    }

    // ------------------------------------------------------------------------------------------
    // Interface web: cópia baixada (OTA) com reserva empacotada no APK
    // ------------------------------------------------------------------------------------------

    /** Tira a imagem de abertura: fade-out e, no fim, GONE (assim ela não bloqueia os cliques do D-pad). */
    private fun esconderSplash() {
        handlerPrincipal.removeCallbacks(removerSplashPorTempo)
        if (!::splashScreen.isInitialized || splashScreen.visibility != View.VISIBLE) return
        splashScreen.animate()
            .alpha(0f)
            .setDuration(DURACAO_FADE_SPLASH_MS)
            .withEndAction { splashScreen.visibility = View.GONE }
            .start()
    }

    /** Abre a interface baixada, se válida; senão a empacotada no APK. */
    private fun carregarInterface() {
        val url = GerenciadorInterface.urlInicial(this)
        interfaceSinalizou = false
        webView.loadUrl(url)
    }

    /** O endereço é de um arquivo da interface baixada (`filesDir/app/`)? */
    private fun ehInterfaceBaixada(url: String?): Boolean =
        url != null && url.startsWith(GerenciadorInterface.prefixoOta(this))

    /** O WebView está agora exibindo a interface baixada? */
    private fun estaNaInterfaceBaixada(): Boolean = ehInterfaceBaixada(webView.url)

    /**
     * Reserva automática: apaga a interface baixada (e lembra que essa versão falhou)
     * e abre a empacotada no APK.
     */
    private fun voltarParaInterfaceEmpacotada(motivo: String) {
        Log.e(TAG, "Interface baixada falhou ($motivo); voltando para a empacotada no APK.")
        handlerPrincipal.removeCallbacks(vigiaDaInterface)
        GerenciadorInterface.descartar(this, motivo, recusar = true)
        interfaceSinalizou = false
        webView.loadUrl(GerenciadorInterface.URL_ASSETS)
    }

    /** Mantém [EstadoReproducao] em dia: o Worker só baixa a interface com o vídeo parado. */
    private fun atualizarEstadoDeReproducao() {
        EstadoReproducao.reproduzindo = exoPlayer.playWhenReady &&
            (exoPlayer.playbackState == Player.STATE_BUFFERING || exoPlayer.playbackState == Player.STATE_READY)
    }

    /**
     * Executa uma verificação imediata (botão dos Ajustes) e devolve o resultado à interface em
     * `window.sintoniaResultadoAtualizacao(estado, detalhe)`.
     */
    private fun verificarAtualizacaoAgora() {
        // OneTimeWorkRequest com manual=true: roda na hora e devolve o resultado à tela (ver criarPedidoManual).
        val pedido = AtualizacaoInterfaceWorker.criarPedidoManual()
        val trabalhos = WorkManager.getInstance(applicationContext)
        trabalhos.enqueue(pedido)
        val dados = trabalhos.getWorkInfoByIdLiveData(pedido.id)
        dados.observe(this, object : Observer<WorkInfo?> {
            override fun onChanged(value: WorkInfo?) {
                if (value == null || !value.state.isFinished) return
                dados.removeObserver(this)
                val estado: String
                val detalhe: String
                if (value.state == WorkInfo.State.SUCCEEDED) {
                    estado = value.outputData.getString(AtualizacaoInterfaceWorker.SAIDA_ESTADO).orEmpty()
                    detalhe = value.outputData.getString(AtualizacaoInterfaceWorker.SAIDA_DETALHE).orEmpty()
                } else {
                    estado = AtualizacaoInterfaceWorker.ESTADO_ERRO
                    detalhe = "a verificação não foi concluída"
                }
                if (paginaCarregada) {
                    webView.evaluateJavascript(
                        "if (window.sintoniaResultadoAtualizacao) " +
                            "window.sintoniaResultadoAtualizacao(${literalJs(estado)}, ${literalJs(detalhe)});",
                        null
                    )
                }
            }
        })
    }

    // ------------------------------------------------------------------------------------------
    // Player de vídeo (Media3 / ExoPlayer)
    // ------------------------------------------------------------------------------------------

    /** Cria o ExoPlayer e o vincula ao PlayerView, sem os controles nativos. */
    private fun configurarPlayer() {
        // Fontes de IPTV costumam redirecionar entre http e https; o padrão do ExoPlayer bloquearia isso.
        val fabricaHttp = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setUserAgent(USER_AGENT_PLAYER)
            .setConnectTimeoutMs(TEMPO_LIMITE_REDE_MS)
            .setReadTimeoutMs(TEMPO_LIMITE_REDE_MS)

        exoPlayer = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(fabricaHttp))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true
            )
            .build()
        exoPlayer.addListener(ouvinteDoPlayer)

        playerView.useController = false // a interface web desenha a própria barra de tempo
        playerView.player = exoPlayer
    }

    /** Inicia (ou troca) a reprodução. Deve ser chamado na thread principal. */
    private fun iniciarReproducao(url: String) {
        ultimoStatus = null
        posicaoAtualMs = 0L
        duracaoTotalMs = -1L
        larguraVideoPx = 0

        val item = MediaItem.Builder().setUri(url).apply {
            // Endereços HLS sem extensão .m3u8 (ex.: "output=hls") precisam do tipo informado.
            if (REGEX_HLS.containsMatchIn(url)) setMimeType(MimeTypes.APPLICATION_M3U8)
        }.build()

        exoPlayer.setMediaItem(item)
        exoPlayer.prepare()
        exoPlayer.playWhenReady = true
        atualizarEstadoDeReproducao()
        notificarStatus()
    }

    /** Interrompe e esvazia o player. Deve ser chamado na thread principal. */
    private fun pararReproducao() {
        exoPlayer.stop()
        exoPlayer.clearMediaItems()
        atualizarEstadoDeReproducao()
        ultimoStatus = null
        posicaoAtualMs = 0L
        duracaoTotalMs = -1L
        larguraVideoPx = 0
    }

    /** Copia posição, duração e largura do player para os campos de consulta rápida. */
    private fun atualizarCacheDoPlayer() {
        if (exoPlayer.playbackState == Player.STATE_IDLE) return
        posicaoAtualMs = exoPlayer.currentPosition.coerceAtLeast(0L)
        val duracao = exoPlayer.duration
        duracaoTotalMs =
            if (duracao == C.TIME_UNSET || exoPlayer.isCurrentMediaItemLive) -1L else duracao
        larguraVideoPx = exoPlayer.videoSize.width
    }

    /** Traduz o estado atual do ExoPlayer para o status enviado à interface web. */
    private fun calcularStatus(): String? = when (exoPlayer.playbackState) {
        Player.STATE_BUFFERING -> STATUS_CARREGANDO
        Player.STATE_READY ->
            if (exoPlayer.playWhenReady) STATUS_REPRODUZINDO else STATUS_PAUSADO
        Player.STATE_ENDED -> STATUS_CONCLUIDO
        else -> null
    }

    /** Envia o status atual à interface web, apenas se ele mudou. */
    private fun notificarStatus() {
        val status = calcularStatus() ?: return
        if (status == ultimoStatus) return
        ultimoStatus = status
        enviarStatusParaWeb(status, null)
    }

    /** Chama `window.sintoniaStatusVideo(status, detalhe)` no WebView. */
    private fun enviarStatusParaWeb(status: String, detalhe: String?) {
        if (!paginaCarregada) return
        val argumentoDetalhe = if (detalhe != null) ", ${JSONObject.quote(detalhe)}" else ""
        val script =
            "if (window.sintoniaStatusVideo) window.sintoniaStatusVideo('$status'$argumentoDetalhe);"
        webView.evaluateJavascript(script, null)
    }

    /**
     * Reposiciona o PlayerView dentro da tela. Os valores são frações (0 a 1) da largura/altura,
     * assim não dependem da escala do WebView. Usado para exibir o vídeo na janela pequena
     * ("mini") da tela Ao Vivo. Deve ser chamado na thread principal.
     */
    private fun posicionarVideo(esquerda: Double, topo: Double, largura: Double, altura: Double) {
        val pai = playerView.parent as? View ?: return
        if (pai.width <= 0 || pai.height <= 0) return

        val parametros = FrameLayout.LayoutParams(
            (largura * pai.width).toInt().coerceAtLeast(1),
            (altura * pai.height).toInt().coerceAtLeast(1)
        ).apply {
            leftMargin = (esquerda * pai.width).toInt()
            topMargin = (topo * pai.height).toInt()
        }
        playerView.layoutParams = parametros
    }

    // ------------------------------------------------------------------------------------------
    // Digitação: diálogo nativo com teclado do Fire TV
    // ------------------------------------------------------------------------------------------

    /**
     * Abre um diálogo nativo com um [EditText] e força o teclado do Fire TV. Os campos de texto do
     * WebView não abrem o teclado de forma confiável com o controle remoto; por isso a interface
     * delega a digitação para cá.
     *
     * Ao confirmar (botão OK ou tecla "concluído" do teclado) o texto volta à interface em
     * `window.sintoniaTextoDigitado(id, texto)`. Se o usuário cancelar (Voltar ou Cancelar), o
     * JavaScript recebe `null` no lugar do texto. Deve ser chamado na thread principal.
     *
     * @param valorAtual texto que o campo já tem (aparece preenchido no diálogo)
     * @param idDestino `id` do elemento HTML que receberá o texto
     * @param titulo título do diálogo (ex.: a dica do campo)
     * @param senha `true` para ocultar o que é digitado (campos de senha e chaves de API)
     */
    private fun mostrarDialogoTeclado(valorAtual: String, idDestino: String, titulo: String, senha: Boolean) {
        if (isFinishing || isDestroyed) return
        // Um segundo OK enquanto o diálogo já está aberto não deve empilhar outro.
        if (dialogoTeclado?.isShowing == true) return

        val campo = EditText(this).apply {
            setText(valorAtual)
            setSelection(text.length)
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_DONE
            inputType = InputType.TYPE_CLASS_TEXT or
                if (senha) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        val margem = (24 * resources.displayMetrics.density).toInt()
        val conteiner = FrameLayout(this).apply {
            setPadding(margem, margem / 2, margem, 0)
            addView(
                campo,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            )
        }

        var confirmado = false
        val dialogo = AlertDialog.Builder(this)
            .setTitle(titulo)
            .setView(conteiner)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                confirmado = true
                enviarTextoDigitado(idDestino, campo.text.toString())
            }
            .setNegativeButton(android.R.string.cancel, null)
            .create()

        // "Concluído" no teclado equivale a clicar em OK.
        campo.setOnEditorActionListener { _, acao, evento ->
            val enter = evento != null && evento.keyCode == KeyEvent.KEYCODE_ENTER && evento.action == KeyEvent.ACTION_DOWN
            if (acao == EditorInfo.IME_ACTION_DONE || enter) {
                dialogo.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                true
            } else {
                false
            }
        }
        // Qualquer outra forma de fechar (Voltar, Cancelar, tocar fora) é cancelamento.
        dialogo.setOnDismissListener {
            if (dialogoTeclado === dialogo) dialogoTeclado = null
            if (!confirmado) enviarTextoDigitado(idDestino, null)
        }
        dialogo.window?.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
        )

        dialogoTeclado = dialogo
        dialogo.show()
        campo.requestFocus()
        // Reforço: alguns Fire OS só abrem o teclado quando o pedido vem depois de o diálogo aparecer.
        campo.post {
            getSystemService(InputMethodManager::class.java)?.showSoftInput(campo, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    /**
     * Devolve o resultado da digitação à interface (`window.sintoniaTextoDigitado(id, texto)`)
     * e o foco ao WebView. [texto] `null` significa que o usuário cancelou.
     */
    private fun enviarTextoDigitado(id: String, texto: String?) {
        webView.requestFocus()
        if (!paginaCarregada) return
        val argumentoTexto = if (texto == null) "null" else literalJs(texto)
        webView.evaluateJavascript(
            "if (window.sintoniaTextoDigitado) window.sintoniaTextoDigitado(${literalJs(id)}, $argumentoTexto);",
            null
        )
    }

    // ------------------------------------------------------------------------------------------
    // Servidor de pareamento (NanoHTTPD)
    // ------------------------------------------------------------------------------------------

    /** Sobe o servidor HTTP local que recebe a lista enviada pelo celular. Encerrado no [onDestroy]. */
    private fun iniciarServidor() {
        servidor = ServidorSintonia(::entregarListaParaWeb)
        try {
            servidor.start(NanoHTTPD.SOCKET_READ_TIMEOUT, /* daemon = */ true)
            servidorAtivo = true
        } catch (e: IOException) {
            servidorAtivo = false
            Log.e(TAG, "Não foi possível iniciar o servidor de pareamento na porta ${ServidorSintonia.PORTA}", e)
        }
    }

    /**
     * Entrega a lista recebida do celular à interface web (`window.sintoniaReceberLista`),
     * executando o script na thread principal. Chamado pela thread do servidor.
     *
     * @return `false` se a interface ainda não está pronta para receber.
     */
    private fun entregarListaParaWeb(nome: String, url: String): Boolean {
        if (!paginaCarregada) return false
        val script = "if (window.sintoniaReceberLista) window.sintoniaReceberLista(${literalJs(nome)}, ${literalJs(url)});"
        runOnUiThread { webView.evaluateJavascript(script, null) }
        return true
    }

    /** Converte um texto em literal de string JavaScript, com aspas e escapes. */
    private fun literalJs(texto: String): String = JSONObject.quote(texto)
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")

    // ------------------------------------------------------------------------------------------
    // WebView
    // ------------------------------------------------------------------------------------------

    /** Configura o WebView: JavaScript, DOM Storage, mídia sem gesto e a ponte nativa. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun configurarWebView(view: WebView) {
        view.settings.apply {
            // Requisitos da interface web
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false

            // A interface foi desenhada para 1920x1080 (meta viewport): ajusta à tela da TV, sem zoom.
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false

            // Arquivos locais dos assets; o conteúdo vem do próprio APK.
            allowFileAccess = true
            allowContentAccess = false
            // A interface (origem file://) consome APIs e listas IPTV remotas; sem isso o CORS bloquearia.
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = true
            // Fluxos IPTV costumam ser http (o manifesto já permite tráfego sem criptografia).
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // Fundo totalmente transparente: o vídeo nativo aparece por trás da interface web.
        view.setBackgroundColor(Color.TRANSPARENT)
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.overScrollMode = View.OVER_SCROLL_NEVER

        view.addJavascriptInterface(SintoniaBridge(), NOME_PONTE_JS)

        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(mensagem: ConsoleMessage): Boolean {
                // Só erros e avisos do JavaScript chegam ao Logcat; o console.log comum é descartado.
                val origem = "[JS] ${mensagem.message()} (${mensagem.sourceId()}:${mensagem.lineNumber()})"
                when (mensagem.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, origem)
                    ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, origem)
                    else -> Unit
                }
                return true
            }
        }

        view.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                // Página (re)carregando: o vídeo anterior não pertence mais a nenhuma interface.
                paginaCarregada = false
                interfaceSinalizou = false
                handlerPrincipal.removeCallbacks(vigiaDaInterface)
                pararReproducao()
                posicionarVideo(0.0, 0.0, 1.0, 1.0)
            }

            override fun onPageFinished(view: WebView, url: String) {
                paginaCarregada = true
                view.requestFocus()
                // O HTML terminou de carregar: a imagem de abertura sai (fade-out e depois GONE, para não bloquear o D-pad).
                esconderSplash()
                // Interface baixada: se em alguns segundos o JavaScript não avisar que iniciou, volta para a do APK.
                if (ehInterfaceBaixada(url) && !interfaceSinalizou) {
                    handlerPrincipal.postDelayed(vigiaDaInterface, TEMPO_VIGIA_INTERFACE_MS)
                }
            }

            // Arquivo da interface baixada ausente ou ilegível: reserva automática.
            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, erro: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame && ehInterfaceBaixada(request.url.toString())) {
                    voltarParaInterfaceEmpacotada("erro ${erro.errorCode} ao abrir ${request.url}: ${erro.description}")
                }
            }

            // Só permite navegar dentro da interface (baixada ou empacotada); links externos são bloqueados.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val endereco = request.url.toString()
                val permitido = endereco.startsWith(GerenciadorInterface.PREFIXO_ASSETS) || ehInterfaceBaixada(endereco)
                if (!permitido) {
                    Log.w(TAG, "Navegação externa bloqueada.") // o endereço fica fora do log: pode ter dados do usuário
                }
                return !permitido
            }
        }

        view.requestFocus()
    }

    /** Oculta barras do sistema para a interface ocupar a tela inteira. */
    private fun entrarEmTelaCheia() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ------------------------------------------------------------------------------------------
    // Teclas do controle remoto
    // ------------------------------------------------------------------------------------------

    /**
     * Intercepta os botões físicos do controle do Fire TV e os repassa ao WebView por JavaScript.
     * Teclas não mapeadas (volume, Home etc.) seguem o fluxo normal do sistema.
     */
    @SuppressLint("GestureBackNavigation") // o Voltar do controle remoto chega como tecla; o gesto usa o OnBackPressedCallback
    override fun dispatchKeyEvent(evento: KeyEvent): Boolean {
        val codigoNativo = evento.keyCode

        if (codigoNativo == KeyEvent.KEYCODE_BACK) {
            // O Voltar age uma única vez por pressionamento (ignora repetição ao segurar).
            if (evento.action == KeyEvent.ACTION_DOWN && evento.repeatCount == 0) {
                tratarVoltar()
            }
            return true
        }

        val codigoJs = CODIGOS_TECLAS[codigoNativo] ?: return super.dispatchKeyEvent(evento)

        // Sem a página pronta não há quem receba a tecla; consome para evitar efeitos colaterais.
        if (!paginaCarregada) return true

        when (evento.action) {
            KeyEvent.ACTION_DOWN -> enviarTeclaParaWeb(codigoJs, "keydown", evento.repeatCount > 0)
            KeyEvent.ACTION_UP -> enviarTeclaParaWeb(codigoJs, "keyup", false)
        }
        // Consumida: a tecla já foi entregue ao JavaScript e não deve seguir para o sistema.
        return true
    }

    /** Dispara um evento de teclado na interface web (função `window.sintoniaTecla` do app.js). */
    private fun enviarTeclaParaWeb(codigoJs: Int, tipo: String, repeticao: Boolean) {
        val script = "if (window.sintoniaTecla) window.sintoniaTecla($codigoJs, '$tipo', $repeticao);"
        webView.evaluateJavascript(script, null)
    }

    // ------------------------------------------------------------------------------------------
    // Botão Voltar
    // ------------------------------------------------------------------------------------------

    /**
     * Pede à interface web para voltar uma tela (`window.sintoniaVoltar`).
     * O app só fecha se a interface responder que já está na tela principal
     * (retorno `false`) ou se ela ainda não está disponível.
     */
    private fun tratarVoltar() {
        if (!paginaCarregada) {
            finish()
            return
        }

        val script = "(typeof window.sintoniaVoltar === 'function') ? String(window.sintoniaVoltar()) : 'ausente'"
        webView.evaluateJavascript(script) { resultado ->
            // evaluateJavascript devolve o texto em JSON, ex.: "\"true\"".
            when (resultado?.trim('"')) {
                "true" -> Unit // a interface tratou o Voltar (voltou uma tela, fechou um painel etc.)
                else -> {
                    finish()
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------------------------------

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    /** O app já estava aberto e o usuário tocou na notificação de um lembrete. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val id = intent.getStringExtra(AgendadorLembretes.EXTRA_ID) ?: return
        if (paginaCarregada) {
            lembreteDeAbertura = null
            webView.evaluateJavascript(
                "if (window.sintoniaAbrirLembrete) window.sintoniaAbrirLembrete(${literalJs(id)});", null
            )
        } else {
            lembreteDeAbertura = id // a interface busca ao terminar de iniciar
        }
    }

    /** Pede a permissão de notificações (Android 13+) na primeira vez que um lembrete é agendado. */
    private fun garantirPermissaoNotificacao() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || permissaoNotificacaoPedida) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        permissaoNotificacaoPedida = true
        pedirPermissaoNotificacao.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onStart() {
        super.onStart()
        handlerPrincipal.post(atualizadorDePosicao)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onStop() {
        // Ao sair do app (ex.: botão Home) o vídeo é pausado; a interface é avisada pelo ouvinte.
        handlerPrincipal.removeCallbacks(atualizadorDePosicao)
        exoPlayer.pause()
        super.onStop()
    }

    override fun onDestroy() {
        // Fecha o diálogo de digitação sem avisar a interface (ela está sendo destruída junto).
        dialogoTeclado?.setOnDismissListener(null)
        dialogoTeclado?.dismiss()
        dialogoTeclado = null
        handlerPrincipal.removeCallbacks(removerSplashPorTempo)
        EstadoReproducao.reproduzindo = false
        servidor.stop()
        handlerPrincipal.removeCallbacksAndMessages(null)
        exoPlayer.removeListener(ouvinteDoPlayer)
        playerView.player = null
        exoPlayer.release()

        // Apaga o cache de rede (capas do TMDB/OMDb etc.) ao fechar o app: o armazenamento da Fire TV é pequeno.
        // Dados do app (localStorage, favoritos, lista) não fazem parte desse cache e são mantidos.
        webView.clearCache(true)

        // Libera o WebView para evitar vazamento de memória.
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.removeJavascriptInterface(NOME_PONTE_JS)
        webView.destroy()
        super.onDestroy()
    }

    /**
     * O Fire OS avisa quando a memória está acabando. Em nível crítico ou baixo (com o app em primeiro plano)
     * o cache do WebView é limpo na hora, sem fechar o app; as capas já na tela continuam e as demais são baixadas de novo.
     */
    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
        ) {
            if (::webView.isInitialized) {
                Log.w(TAG, "Pouca memória (nível $level); limpando o cache do WebView.")
                webView.clearCache(true)
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Ponte JavaScript -> Android
    // ------------------------------------------------------------------------------------------

    /**
     * Substitui o antigo `PalmServiceBridge` do webOS. Fica disponível no JavaScript como
     * `window.SintoniaBridge`. Os métodos são chamados em uma thread do WebView (não a principal),
     * por isso qualquer acesso ao ExoPlayer ou à interface passa por [runOnUiThread];
     * as consultas apenas leem valores em cache.
     */
    inner class SintoniaBridge {

        // ---- Informações gerais ----

        /** Informa a plataforma ao JavaScript (permite diferenciar de webOS e navegador). */
        @JavascriptInterface
        fun plataforma(): String = "android-firetv"

        /** Versão do aplicativo (`versionName`). */
        @JavascriptInterface
        fun versaoApp(): String = try {
            packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
        } catch (e: Exception) {
            Log.w(TAG, "Não foi possível obter a versão do app", e)
            ""
        }

        /** Versão da interface em uso: hash curto da cópia baixada, ou "do app" se for a do APK. */
        @JavascriptInterface
        fun obterVersaoInterface(): String = GerenciadorInterface.versaoParaExibir(applicationContext)

        /**
         * A interface avisa que iniciou de verdade. Sem esse aviso a cópia baixada é considerada
         * defeituosa e o app volta para a empacotada ([vigiaDaInterface]).
         */
        @JavascriptInterface
        fun interfaceCarregada() {
            interfaceSinalizou = true
            handlerPrincipal.removeCallbacks(vigiaDaInterface)
        }

        /**
         * Verifica agora se há interface nova. O resultado volta em
         * `window.sintoniaResultadoAtualizacao(estado, detalhe)`.
         */
        @JavascriptInterface
        fun verificarAtualizacaoInterface() {
            runOnUiThread { verificarAtualizacaoAgora() }
        }

        /**
         * Abre o diálogo nativo de digitação (com o teclado do Fire TV) para um campo da interface.
         * O texto digitado volta em `window.sintoniaTextoDigitado(idElementoDestino, texto)`;
         * `texto` é `null` se o usuário cancelar.
         */
        @JavascriptInterface
        fun abrirTeclado(valorAtual: String?, idElementoDestino: String?, titulo: String?, senha: Boolean) {
            if (idElementoDestino.isNullOrBlank()) {
                Log.w(TAG, "abrirTeclado() chamado sem id do campo; ignorado.")
                return
            }
            runOnUiThread {
                mostrarDialogoTeclado(
                    valorAtual.orEmpty(), idElementoDestino, titulo.orEmpty().ifBlank { "Digite o texto" }, senha
                )
            }
        }

        /** Recarrega a interface (usa a versão baixada mais recente), por exemplo após uma atualização. */
        @JavascriptInterface
        fun reiniciarInterface() {
            runOnUiThread {
                carregarInterface()
            }
        }

        /** Fecha o aplicativo (a interface confirma que não há mais para onde voltar). */
        @JavascriptInterface
        fun sairDoApp() {
            runOnUiThread { finish() }
        }

        // ---- Pareamento de listas pelo celular ----

        /** Endereço IPv4 local da TV (ex.: 192.168.1.10), ou texto vazio se estiver sem rede. */
        @JavascriptInterface
        fun obterIpLocal(): String = ServidorSintonia.obterIpLocal()

        /** Porta do servidor de pareamento. */
        @JavascriptInterface
        fun obterPortaServidor(): Int = ServidorSintonia.PORTA

        /** `true` se o servidor de pareamento subiu com sucesso. */
        @JavascriptInterface
        fun servidorAtivo(): Boolean = servidorAtivo

        /** Abre um pareamento e devolve o token que deve ir no QR Code (`?t=...`). */
        @JavascriptInterface
        fun obterTokenPareamento(): String = servidor.iniciarPareamento()

        /** Encerra o pareamento ao fechar a tela do QR Code. */
        @JavascriptInterface
        fun encerrarPareamento() {
            servidor.encerrarPareamento()
        }

        // ---- Lembretes de jogos (notificações nativas) ----

        /**
         * Agenda um lembrete: no instante [horarioMs] (epoch, em milissegundos) o Android mostra
         * uma notificação com o [titulo], mesmo com o app fechado. Reagendar o mesmo [id] substitui o anterior.
         */
        @JavascriptInterface
        fun agendarLembrete(id: String?, titulo: String?, horarioMs: Long) {
            if (id.isNullOrBlank()) {
                Log.w(TAG, "agendarLembrete() chamado sem id; ignorado.")
                return
            }
            runOnUiThread { garantirPermissaoNotificacao() }
            AgendadorLembretes.agendar(applicationContext, id, titulo.orEmpty(), horarioMs)
        }

        /** Cancela um lembrete agendado. */
        @JavascriptInterface
        fun cancelarLembrete(id: String?) {
            if (id.isNullOrBlank()) return
            AgendadorLembretes.cancelar(applicationContext, id)
        }

        /**
         * Id do lembrete cuja notificação abriu o app (texto vazio se não foi por notificação).
         * Cada id é entregue uma única vez.
         */
        @JavascriptInterface
        fun obterLembreteDeAbertura(): String {
            val id = lembreteDeAbertura.orEmpty()
            lembreteDeAbertura = null
            return id
        }

        // ---- Controle do vídeo nativo ----

        /** Carrega o endereço (HLS, TS, MP4 etc.) e começa a reproduzir. */
        @JavascriptInterface
        fun reproduzir(url: String?) {
            if (url.isNullOrBlank()) {
                Log.w(TAG, "reproduzir() chamado sem endereço; ignorado.")
                return
            }
            runOnUiThread { iniciarReproducao(url) }
        }

        /** Pausa a reprodução. */
        @JavascriptInterface
        fun pausar() {
            runOnUiThread { exoPlayer.pause() }
        }

        /** Retoma a reprodução pausada. */
        @JavascriptInterface
        fun retomar() {
            runOnUiThread { exoPlayer.play() }
        }

        /** Para a reprodução e libera o conteúdo atual. */
        @JavascriptInterface
        fun parar() {
            runOnUiThread { pararReproducao() }
        }

        /** Vai para a posição indicada, em milissegundos. */
        @JavascriptInterface
        fun buscar(posicaoMs: Long) {
            val destino = posicaoMs.coerceAtLeast(0L)
            posicaoAtualMs = destino // a próxima consulta já enxerga o destino
            runOnUiThread { exoPlayer.seekTo(destino) }
        }

        /** Posição atual em milissegundos (valor em cache, atualizado a cada ~250 ms). */
        @JavascriptInterface
        fun obterPosicaoAtual(): Long = posicaoAtualMs

        /** Duração total em milissegundos; `-1` se desconhecida ou se for transmissão ao vivo. */
        @JavascriptInterface
        fun obterDuracaoTotal(): Long = duracaoTotalMs

        /** Largura do vídeo em pixels; `0` enquanto nenhuma imagem foi decodificada. */
        @JavascriptInterface
        fun obterLarguraVideo(): Int = larguraVideoPx

        /**
         * Define a área da tela onde o vídeo é exibido, em frações (0 a 1) da tela.
         * Tela cheia: `(0, 0, 1, 1)`. Janela pequena da tela Ao Vivo: o retângulo dela.
         */
        @JavascriptInterface
        fun definirAreaVideo(esquerda: Double, topo: Double, largura: Double, altura: Double) {
            runOnUiThread { posicionarVideo(esquerda, topo, largura, altura) }
        }
    }

    private companion object {
        const val TAG = "Sintonia"

        /** Nome do objeto exposto ao JavaScript (`window.SintoniaBridge`). */
        const val NOME_PONTE_JS = "SintoniaBridge"

        /** Tempo que a interface baixada tem, após carregar, para sinalizar que iniciou. */
        const val TEMPO_VIGIA_INTERFACE_MS = 10_000L

        /** Tempo máximo da imagem de abertura (maior que a vigia da interface, que pode recarregar a empacotada). */
        const val TEMPO_MAXIMO_SPLASH_MS = 20_000L
        const val DURACAO_FADE_SPLASH_MS = 500L

        // Status enviados à interface web em `window.sintoniaStatusVideo`.
        const val STATUS_CARREGANDO = "BUFFERING"
        const val STATUS_REPRODUZINDO = "PLAYING"
        const val STATUS_PAUSADO = "PAUSED"
        const val STATUS_ERRO = "ERROR"
        const val STATUS_CONCLUIDO = "ENDED"

        const val INTERVALO_POSICAO_MS = 250L
        const val TEMPO_LIMITE_REDE_MS = 15_000
        const val USER_AGENT_PLAYER = "Sintonia/1.0 (Fire TV)"

        /** Endereços HLS que não terminam em .m3u8 (mesma regra do app.js). */
        val REGEX_HLS = Regex("""\.m3u8(\?|$)|output=hls|/hls(\?|$)""", RegexOption.IGNORE_CASE)

        /**
         * Tecla física do Android -> `keyCode` esperado pela interface web
         * (mesma tabela `K` do app.js, herdada do webOS).
         */
        val CODIGOS_TECLAS: Map<Int, Int> = mapOf(
            KeyEvent.KEYCODE_DPAD_LEFT to 37,
            KeyEvent.KEYCODE_DPAD_UP to 38,
            KeyEvent.KEYCODE_DPAD_RIGHT to 39,
            KeyEvent.KEYCODE_DPAD_DOWN to 40,
            KeyEvent.KEYCODE_DPAD_CENTER to 13,
            KeyEvent.KEYCODE_ENTER to 13,
            KeyEvent.KEYCODE_NUMPAD_ENTER to 13,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to 10252,
            KeyEvent.KEYCODE_MEDIA_PLAY to 415,
            KeyEvent.KEYCODE_MEDIA_PAUSE to 19,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to 417,
            KeyEvent.KEYCODE_MEDIA_REWIND to 412,
        )
    }
}
