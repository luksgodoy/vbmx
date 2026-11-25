// VbMx — biblioteca por pastas (VB-07): a parte de NAVEGADOR. Painel (adicionar/remover pasta,
// progresso, cancelar), decodificação do áudio, Web Worker com Essentia.js 0.1.3 (CDN jsDelivr) e
// armazém IndexedDB. Toda a lógica testável mora em biblioteca.js; aqui só há cola com o DOM.
// Sem build: <script src="../analise/camelot.js"> + <script src="../biblioteca/biblioteca.js"> +
// este arquivo. Uso: VbMxPainel.iniciar({ montarEm: elemento, aoMudar: faixas => … }).
(function () {
  'use strict';
  const B = window.VbMxBiblioteca;
  // texto pelo idioma (interface/js/i18n.js; o Profissional só carrega o pt-BR). A frase já exibida só troca no evento seguinte;
  // as frases de biblioteca/biblioteca.js (resumoFila, fraseReabertura…) saem em pt-BR e são traduzidas aqui por trm (interface/js/msg-motor.js).
  const tr = (chave, params) => (window.VbMxI18n ? window.VbMxI18n.t(chave, params) : chave);
  const trm = (s) => (window.VbMxMsg ? window.VbMxMsg.traduzir(s) : s);
  const TAXA = 44100, JANELA_S = 90, JANELA_TOM_S = 120, MAX_S = 480; // JANELA_S: trecho do meio só para o tom; o BPM olha a faixa inteira (até MAX_S, centrada)
  // Chave do motor (padrão 'proprio', chroma 'misto' num trecho de JANELA_TOM_S; BPM e tom só do próprio, sem reserva no Essentia nem fonte externa; ?motor=essentia volta ao Essentia, ?chroma=v1 ao chroma antigo, ?chroma=v2 ao anterior): iniciar({ motor: 'proprio', comparar: true }) ou ?motor=proprio&comparar=1 na URL.
  // Os scripts próprios vão por URL absoluta (o Worker de Blob não resolve caminho relativo), irmãos deste arquivo.
  const DOC = typeof document !== 'undefined' ? document : null;
  const AQUI = (DOC && DOC.currentScript && DOC.currentScript.src) || '';
  const BASE_DOC = (DOC && DOC.baseURI) || 'http://localhost/';
  const urlDe = (rel) => new URL(rel, AQUI || BASE_DOC).href;
  const LIBS_PROPRIAS = () => ['../analise/camelot.js', 'dsp.js', 'chroma2.js', 'tom.js', 'ritmo.js', 'motor.js'].map(urlDe); // motor.js por último (o worker o lê assim)
  const CDN = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/';

  // Corpo do worker: vira Blob (um Worker de arquivo local não abre em file://). Recebe PCM mono
  // 44,1 kHz da faixa (até MAX_S) e devolve os CANDIDATOS de BPM (multifeature e degara com ticks,
  // Percival numa janela do meio), o ENVELOPE DE GRAVES (~1 ms por valor, para a grade achar o
  // ataque do bumbo) e o tom; a escolha da oitava, o ajuste dos ticks e do bumbo, o 1 do compasso e
  // a conversão para Camelot e para grade ficam na página (bpm.js, biblioteca.js).
  // `envelopeGrave` chega como argumento: é o texto de VbMxBpm.envelopeGrave (uma fonte só).
  function corpoDoWorker(envelopeGrave, fluxoAmplo) {
    let pronto = null, essentia = null;
    function iniciar(base) {
      if (!pronto) pronto = (async () => {
        // a build .web.js do Essentia presume a página (document.currentScript); no Worker ela
        // quebra com "document is not defined" sem este documento mínimo, que também fixa onde achar o .wasm
        self.document = { currentScript: { src: base + 'essentia-wasm.web.js' }, title: '' };
        importScripts(base + 'essentia-wasm.web.js', base + 'essentia.js-core.js');
        const wasm = typeof EssentiaWASM === 'function' ? await EssentiaWASM() : await EssentiaWASM;
        essentia = new Essentia(wasm);
      })();
      return pronto;
    }
    // Essentia: o caminho de sempre. Devolve o formato do painel (sem `motor`).
    async function viaEssentia(pcm, janela, base) {
      await iniciar(base);
      const apagar = (...os) => { for (const o of os) try { o && o.delete && o.delete(); } catch (_) {} };
      const ticksDe = (r) => { try { return Array.from(essentia.vectorToArray(r.ticks)); } catch (_) { return []; } }; // sem ticks a faixa segue sem grade
      const vetor = essentia.arrayToVector(pcm);
      const candidatos = [];
      for (const metodo of ['multifeature', 'degara']) {
        try {
          const r = essentia.RhythmExtractor2013(vetor, 208, metodo, 40);
          candidatos.push({ nome: metodo, bpm: r.bpm, ticks: ticksDe(r) });
          apagar(r.ticks, r.estimates, r.bpmIntervals, r.confidence);
        } catch (_) { /* um estimador que falha não derruba a faixa */ }
      }
      // trecho do meio (JANELA_S) para o tom e para o Percival, que é mais lento e rende pouco além disso
      const n = Math.min(pcm.length, Math.floor(janela * 44100)), ini = Math.floor((pcm.length - n) / 2);
      const meio = pcm.subarray(ini, ini + n), vmeio = essentia.arrayToVector(meio);
      try { const p = essentia.PercivalBpmEstimator(vmeio); candidatos.push({ nome: 'percival', bpm: p.bpm }); } catch (_) {}
      const k = essentia.KeyExtractor(vmeio);
      apagar(vetor, vmeio);
      return { candidatos, nota: k.key, escala: k.scale, forca: Math.round(k.strength * 100) / 100 };
    }
    // Motor próprio (tom.js + ritmo.js): só carrega os scripts se a chave pedir (padrão Essentia não toca nisto).
    let propriosCarregados = false;
    function viaProprio(pcm, janela, libs, chroma, janelaTom) {
      if (!propriosCarregados) { importScripts.apply(self, libs); propriosCarregados = true; }
      const seg = chroma === 'misto' ? janelaTom : janela; // o tom 'misto' olha um trecho mais longo
      const n = Math.min(pcm.length, Math.floor(seg * 44100)), ini = Math.floor((pcm.length - n) / 2);
      const opcoes = chroma === 'misto' ? { chroma: 'misto' } : chroma === 'v2' ? { chroma: 'v2', chroma2: { nH: 6, s: 0.8 } } : undefined;
      const tom = self.VbMxTom.analisarTom(pcm.subarray(ini, ini + n), 44100, opcoes);
      const ritmo = self.VbMxRitmo.analisarRitmo(pcm, 44100);
      return self.VbMxMotorAnalise.mapearProprio(tom, ritmo);
    }
    onmessage = async (e) => {
      const { id, pcm, base, janela, motor, comparar, libs, chroma, janelaTom } = e.data;
      try {
        // envelopes antes: o Essentia pode consumir o PCM por cópia, estes só leem
        let graves = null;
        try { graves = envelopeGrave(pcm, 44100); } catch (_) { graves = null; } // sem envelope: grade só dos ticks
        let fluxo = null;
        try { fluxo = fluxoAmplo(pcm, 44100); } catch (_) { fluxo = null; } // sem fluxo: o refino por batida só usa os graves
        let r;
        if (motor !== 'proprio' && !comparar) r = Object.assign(await viaEssentia(pcm, janela, base), { motor: 'essentia' }); // padrão: como sempre foi
        else if (!comparar) {
          // só o próprio: sem reserva no Essentia; faixa que ele não resolve fica marcada com erro
          r = Object.assign(viaProprio(pcm, janela, libs, chroma, janelaTom), { motor: 'proprio' });
          if (!r.candidatos || !r.candidatos.length) { postMessage({ id, semBpm: true, erro: 'sem-bpm' }); return; }
        } else {
          importScripts.apply(self, [libs[libs.length - 1]]); // motor.js (último da lista) traz decidir()
          r = await self.VbMxMotorAnalise.decidir({ motor, comparar, essentia: () => viaEssentia(pcm, janela, base), proprio: () => viaProprio(pcm, janela, libs, chroma, janelaTom) });
        }
        const saida = { id, candidatos: r.candidatos, graves, fluxo, nota: r.nota, escala: r.escala, forca: r.forca, motor: r.motor };
        if (r.fallback) saida.fallback = r.fallback;
        if (r.comparacao) saida.comparacao = r.comparacao;
        postMessage(saida, (graves ? [graves.valores.buffer].concat(graves.sinal ? [graves.sinal.buffer] : []) : []).concat(fluxo ? [fluxo.valores.buffer] : []));
      } catch (err) { postMessage({ id, erro: String((err && err.message) || err) }); }
    };
  }

  // [título, artista] para o songbpm, a partir só do NOME do arquivo (sem pastas)
  const ordemTA = (nome) => { const t = B.tituloArtista(nome); return [t.titulo, t.artista]; };

  function criarAnalisador(cfg) {
    let worker = null, ctx = null, seq = 0;
    const pendentes = new Map();
    function garante() {
      if (worker) return worker;
      const url = URL.createObjectURL(new Blob(['(' + corpoDoWorker.toString() + ')(' + window.VbMxBpm.envelopeGrave.toString() + ',' + window.VbMxBpm.fluxoAmplo.toString() + ')'], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => { const p = pendentes.get(e.data.id); if (p) { pendentes.delete(e.data.id); p(e.data); } };
      const falhaGeral = (msg) => { for (const p of pendentes.values()) p({ erro: msg }); pendentes.clear(); };
      worker.onerror = (e) => falhaGeral((e && e.message) || tr('pastas.erro-worker'));
      worker.onmessageerror = () => falhaGeral(tr('pastas.erro-mensagem'));
      return worker;
    }
    async function decodificar(arquivo) {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TAXA });
      const buf = await ctx.decodeAudioData(await arquivo.arrayBuffer());
      const n = Math.min(buf.length, MAX_S * TAXA), ini = Math.max(0, Math.floor((buf.length - n) / 2));
      const mono = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) mono[i] += d[ini + i] / buf.numberOfChannels;
      }
      return { mono, inicio: ini / TAXA, duracao: buf.duration }; // `inicio`: onde a janela começa na faixa (0 se a faixa cabe em MAX_S; ticks são relativos a ela)
    }
    async function analisar(item) {
      const arquivo = await item.obter();
      const { mono: pcm, inicio, duracao } = await decodificar(arquivo);
      // songbpm primeiro (só título/artista, nunca caminho; desligado sem ?songbpm=); em paralelo ao motor próprio, que segue dando a grade (o songbpm não dá fase)
      const sbP = cfg.songbpm && window.VbMxSongbpm ? window.VbMxSongbpm.consultar(...ordemTA(item.nome), { url: cfg.songbpm }).catch(() => null) : Promise.resolve(null);
      const tbP = cfg.tunebat && window.VbMxTunebat ? window.VbMxTunebat.consultar(...ordemTA(item.nome), { url: cfg.tunebat }).catch(() => null) : Promise.resolve(null);
      const w = garante(), id = ++seq;
      const r = await new Promise((ok) => { pendentes.set(id, ok); w.postMessage({ id, pcm, base: CDN, janela: JANELA_S, janelaTom: JANELA_TOM_S, motor: cfg.motor, comparar: cfg.comparar, chroma: cfg.chroma, libs: cfg.motor === 'proprio' || cfg.comparar ? LIBS_PROPRIAS() : null }, [pcm.buffer]); });
      if (r.erro) throw new Error(r.semBpm ? tr('pastas.sem-bpm') : r.erro);
      // oitava por consenso, ticks da faixa inteira, ataque do bumbo no envelope, 1 do compasso, um BPM só
      const a = window.VbMxBpm.resolver(r.candidatos, inicio, null, r.graves, r.fluxo);
      if (!a) throw new Error(tr('pastas.sem-bpm'));
      const saida = { bpm: a.bpm, camelot: window.Camelot.paraCamelot(r.nota, r.escala), forca: r.forca, grade: a.grade, ritmo: a.ritmo || null, duracao, fonte: r.motor || 'proprio' };
      const [tbR, sbR] = await Promise.all([tbP, sbP]); // falha/ausência = null: cai para o próximo (tunebat > songbpm > próprio)
      const sb = window.VbMxMotorAnalise ? window.VbMxMotorAnalise.combinarExterno(tbR, sbR, Object.assign({ bpm: saida.bpm }, r), saida.bpm) : { fonte: 'proprio' };
      if (sb.fonte !== 'proprio') { // BPM e tom do externo; a grade continua a do motor próprio (avisa se os dois BPM discordam)
        const camProprio = saida.camelot;
        saida.camelot = window.Camelot.paraCamelot(sb.nota, sb.escala);
        if (sb.bpmProprio != null || camProprio !== saida.camelot) { saida.bpmProprio = saida.bpm; saida.camelotProprio = camProprio; }
        saida.bpm = sb.bpm; saida.fonte = sb.fonte; saida.modoDesconhecido = sb.modoDesconhecido;
        if (sb.gradeDiverge) saida.gradeDiverge = true;
      }
      if (r.comparacao) saida.comparacao = r.comparacao; // só com `comparar`: o outro motor, ao lado; não mexe no resultado oficial
      return saida;
    }
    return { analisar, fechar() { try { worker && worker.terminate(); } catch (_) {} try { ctx && ctx.close(); } catch (_) {} worker = ctx = null; } };
  }

  function criarCacheDoNavegador() {
    let armazem = null;
    try { armazem = window.indexedDB ? B.armazemIndexedDB(window.indexedDB) : null; } catch (_) { armazem = null; }
    return B.criarCache(armazem); // sem IndexedDB (ou com erro) a página funciona sem cache
  }

  // Banco próprio e versionado para os handles das pastas (separado do cache de análise).
  function criarMemoriaDoNavegador() {
    let armazem = null;
    try { armazem = window.indexedDB ? B.armazemIndexedDB(window.indexedDB, B.BANCO_PASTAS, 'pastas') : null; } catch (_) { armazem = null; }
    return B.criarMemoriaPastas(armazem);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const novaChave = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // Ambiente lido do navegador; a escolha em si mora em biblioteca.js (testada em Node).
  const ambiente = () => ({ temPicker: typeof window.showDirectoryPicker === 'function', userAgent: navigator.userAgent, plataforma: navigator.platform, toques: navigator.maxTouchPoints });
  const lembraSoComPicker = () => tr('pastas.nao-lembra');

  function iniciar({ montarEm, aoMudar, preferencia, aoDesenhar, motor, comparar }) {
    const url = typeof URLSearchParams === 'function' ? new URLSearchParams((window.location && window.location.search) || '') : { get: () => null };
    // ?zerar=1: esquece as pastas lembradas e todas as análises guardadas (os dois bancos desta biblioteca) e recarrega limpo
    if (url.get('zerar') === '1' && window.indexedDB && window.location) {
      const apagar = (nome) => new Promise((ok) => { const r = window.indexedDB.deleteDatabase(nome); r.onsuccess = r.onerror = r.onblocked = () => ok(); });
      Promise.all([apagar('vbmx-biblioteca'), apagar(B.BANCO_PASTAS)]).then(() => { const u = new URL(window.location.href); u.searchParams.delete('zerar'); window.location.replace(u.toString()); });
      return;
    }
    // BPM e tom vêm do motor próprio. Fonte externa só quando pedida na URL (?tunebat=<url> ou ?songbpm=<url>).
    const externo = (nome) => (url.get(nome) === 'off' ? null : (url.get(nome) || null));
    const cfg = { tunebat: externo('tunebat'), songbpm: externo('songbpm'), motor: motor || url.get('motor') || 'proprio', comparar: comparar != null ? !!comparar : url.get('comparar') === '1', chroma: url.get('chroma') || 'misto' };
    const pastas = []; // { chave, nome, handle?, itens, resultados:[{item,resultado}], lembrada?, erro? }
    // só o próprio: análise guardada de outra fonte (Essentia, Tunebat, songbpm) ou sem fonte anotada não vale e a faixa é refeita
    const guardado = criarCacheDoNavegador();
    const soProprio = cfg.motor === 'proprio' && !cfg.comparar && !cfg.tunebat && !cfg.songbpm;
    const cache = !soProprio ? guardado : { get ativo() { return guardado.ativo; }, gravar: guardado.gravar,
      ler: async (...chave) => { const r = await guardado.ler(...chave); return r && r.fonte !== 'proprio' ? null : r; } };
    const memoria = criarMemoriaDoNavegador();
    const caminho = B.escolherCaminho(ambiente()); // 'diretorio' | 'pasta' | 'faixas'
    let analisador = null, controle = null, ocupado = false, progresso = null, aviso = '';

    // Pasta escolhida no dropdown (preferência `biblio.pasta-filtro`, nome da pasta; '' = todas). Sem `preferencia`, só em memória.
    let escolhaMem = '';
    const lerEscolha = () => { try { return preferencia ? String(preferencia.ler() || '') : escolhaMem; } catch (_) { return ''; } };
    const gravarEscolha = (v) => { escolhaMem = v; try { if (preferencia) preferencia.gravar(v); } catch (_) { /* preferência indisponível: vale só nesta sessão */ } };
    function faixas() { return B.faixasDasPastas(pastas, lerEscolha()); }
    const aReabrir = () => pastas.filter((p) => p.lembrada && !p.erro).length;
    // API para a barra da biblioteca (interface/js/biblio.js): nomes + escolha atual, e a troca de pasta.
    const pastasParaFiltro = () => ({ nomes: pastas.map((p) => p.nome), escolha: B.pastaEfetiva(pastas, lerEscolha()), ocupado });
    function escolherPasta(nome) { gravarEscolha(String(nome || '')); desenhar(); aoMudar(faixas()); }
    ativo = { pastasParaFiltro, escolherPasta };
    let assinatura = '';
    function desenhar() {
      // a barra da biblioteca só se redesenha quando muda o que ela mostra (pastas, escolha, ocupado)
      const sig = JSON.stringify(pastasParaFiltro());
      if (sig !== assinatura) { assinatura = sig; if (aoDesenhar) { try { aoDesenhar(); } catch (_) { /* barra ainda não existe */ } } }
      const total = pastas.reduce((n, p) => n + p.itens.length, 0);
      const nota = (p) => (p.erro ? `<span class="n" title="${esc(p.erro)}">${esc(p.erro)}</span>` : p.lembrada ? `<span class="n">${esc(tr('pastas.lembrada'))}</span>` : `<span class="n">${p.itens.length}</span>`);
      const estado = aviso || (progresso ? tr('pastas.analisando', { feitas: progresso.feitas, total: progresso.total, cache: progresso.doCache ? tr('pastas.do-cache', { n: progresso.doCache }) : '', atual: progresso.atual ? ' · ' + progresso.atual.split('/').pop() : '' }) : (pastas.length ? tr('pastas.contagem', { total, n: pastas.length }) : tr(caminho === 'faixas' ? 'pastas.nenhuma-faixas' : 'pastas.nenhuma-pasta')));
      montarEm.innerHTML = `
        <div class="pastas-cab">
          <button type="button" class="botao-pasta" id="add-pasta" ${ocupado ? 'disabled' : ''}>${tr(caminho === 'faixas' ? 'pastas.add-faixas' : 'pastas.add-pasta')}</button>
          ${aReabrir() ? `<button type="button" class="botao-pasta" id="reabrir-pastas" ${ocupado ? 'disabled' : ''}>${tr('pastas.reabrir')}</button>` : ''}
          ${caminho === 'faixas'
            ? '<input type="file" id="add-pasta-input" multiple accept="audio/*,.mp3,.wav,.aif,.aiff" hidden>'
            : '<input type="file" id="add-pasta-input" webkitdirectory multiple hidden>'}
          ${ocupado ? `<button type="button" class="botao-pasta" id="cancelar-analise">${tr('pastas.cancelar')}</button>` : ''}
          <span class="pastas-estado" role="status">${esc(estado)}</span>
        </div>
        ${pastas.length ? `<ul class="pastas-lista">${pastas.map((p, i) => `<li><span>${esc(p.nome)}</span>${nota(p)}<button type="button" data-remover="${i}" aria-label="${esc(tr('pastas.remover', { nome: p.nome }))}" ${ocupado ? 'disabled' : ''}>×</button></li>`).join('')}</ul>` : ''}`;
      montarEm.querySelector('#add-pasta').onclick = escolher;
      montarEm.querySelector('#add-pasta-input').onchange = (e) => {
        const arquivos = Array.from(e.target.files || []);
        e.target.value = ''; // permite escolher o mesmo arquivo de novo
        if (!arquivos.length) { adicionar(null); return; }
        // mesmo fluxo da pasta: varrerLista -> adicionar -> cache (IndexedDB por nome+tamanho+data) -> análise
        const nome = caminho === 'faixas' ? B.nomeLoteFaixas(pastas) : (arquivos[0].webkitRelativePath || '').split('/')[0] || 'pasta';
        adicionar({ nome, itens: B.varrerLista(arquivos) });
      };
      const c = montarEm.querySelector('#cancelar-analise'); if (c) c.onclick = () => controle && controle.cancelar();
      const r = montarEm.querySelector('#reabrir-pastas'); if (r) r.onclick = reabrirPastas;
      montarEm.querySelectorAll('[data-remover]').forEach((b) => (b.onclick = () => {
        const [p] = pastas.splice(Number(b.dataset.remover), 1);
        if (p && p.chave) memoria.remover(p.chave); // × também esquece o handle guardado
        aviso = p ? tr(p.handle ? 'pastas.removida-esquecida' : 'pastas.removida', { nome: p.nome }) : ''; desenhar(); aoMudar(faixas());
      }));
    }
    // Todo caminho termina com uma frase em `aviso` (ou com o progresso na tela): a página nunca fica muda.
    async function escolher() {
      if (ocupado) return;
      if (caminho !== 'diretorio') {
        aviso = tr(caminho === 'faixas' ? 'pastas.abrindo-faixas' : 'pastas.abrindo-pastas'); desenhar();
        montarEm.querySelector('#add-pasta-input').click(); return;
      }
      aviso = tr('pastas.abrindo-pastas'); desenhar();
      let handle;
      try { handle = await window.showDirectoryPicker({ mode: 'read' }); }
      catch (e) {
        aviso = e && e.name === 'AbortError' ? tr('pastas.cancelou') : tr('pastas.seletor-falhou', { nome: (e && e.name) || 'erro', msg: (e && e.message) || e });
        desenhar(); return;
      }
      aviso = tr('pastas.varrendo', { nome: handle.name }); desenhar();
      try {
        const itens = await B.varrerDiretorio(handle, { aoAchar: (n) => { aviso = tr('pastas.varrendo-n', { nome: handle.name, n }); const e = montarEm.querySelector('.pastas-estado'); if (e) e.textContent = aviso; else desenhar(); } });
        const igual = await B.acharIgual(pastas, handle); // mesma pasta do disco: substitui, não duplica
        await adicionar({ nome: igual ? igual.nome : handle.name, chave: igual && igual.chave, itens, handle });
      } catch (e) { aviso = tr('pastas.leitura-falhou', { nome: handle.name, msg: (e && e.message) || e }); desenhar(); }
    }
    // Analisa os itens de uma pasta já colocada na lista; quem chama liga/desliga `ocupado`.
    async function analisarPasta(pasta) {
      const r = await B.analisarFila(pasta.itens, {
        cache, analisar: analisador.analisar, controle,
        aoProgredir: (p) => { aviso = ''; progresso = p; desenhar(); },
      });
      pasta.resultados = r.resultados;
      return r;
    }
    async function adicionar(pasta) {
      if (!pasta) { aviso = tr(caminho === 'faixas' ? 'pastas.nada-faixas' : 'pastas.cancelou'); desenhar(); return; }
      if (ocupado) { aviso = tr('pastas.espere'); desenhar(); return; }
      if (!pasta.itens.length) { aviso = caminho === 'faixas' ? tr('pastas.sem-audio-faixas') : tr('pastas.sem-audio', { nome: pasta.nome }); desenhar(); return; }
      pasta.resultados = [];
      const anterior = pastas.find((p) => p.nome === pasta.nome);
      pasta.chave = pasta.chave || (pasta.handle ? (anterior && anterior.chave) || novaChave() : undefined);
      const substituiu = B.colocarPasta(pastas, pasta); // mesma pasta de novo: substitui e reanalisa o que faltou
      let lembrou = '';
      if (pasta.handle) {
        const gravou = await memoria.gravar({ chave: pasta.chave, nome: pasta.nome, handle: pasta.handle });
        if (!gravou) lembrou = tr('pastas.sem-indexeddb');
      } else lembrou = lembraSoComPicker();
      aviso = tr('pastas.encontradas', { n: pasta.itens.length, nome: pasta.nome, repetida: substituiu ? tr('pastas.repetida') : '' });
      ocupado = true; controle = B.criarControle(); analisador = analisador || criarAnalisador(cfg); desenhar();
      try {
        const r = await analisarPasta(pasta);
        aviso = trm(B.resumoFila(r, pasta.itens.length)) + lembrou;
      } catch (e) { aviso = tr('pastas.analise-falhou', { msg: (e && e.message) || e }) + lembrou; }
      ocupado = false; progresso = null; desenhar(); aoMudar(faixas());
    }

    // Reabre uma pasta lembrada: permissão (pedida só se `pedir`, ou seja, dentro de um gesto),
    // varredura e análise. Devolve null se deu certo, ou o motivo da falha.
    async function reabrirUma(p, estado) {
      try {
        if (estado !== 'granted') return tr('pastas.sem-permissao');
        p.itens = await B.varrerDiretorio(p.handle, { cancelado: () => controle && controle.cancelado });
        if (!p.itens.length) return tr('pastas.sem-audio-curto');
        p.lembrada = false; p.erro = ''; p.resultados = [];
        analisador = analisador || criarAnalisador(cfg);
        await analisarPasta(p);
        return null;
      } catch (e) { return trm(B.motivoFalha(e)); }
    }
    async function reabrirLote(lista, estados) {
      ocupado = true; controle = B.criarControle(); aviso = tr('pastas.reabrindo-todas'); desenhar();
      const falhas = [];
      for (let i = 0; i < lista.length; i++) {
        if (controle.cancelado) break;
        const p = lista[i];
        aviso = tr('pastas.reabrindo', { nome: p.nome }); progresso = null; desenhar();
        const motivo = await reabrirUma(p, estados[i]);
        if (motivo) { p.erro = motivo; p.lembrada = true; falhas.push({ nome: p.nome, motivo }); }
      }
      aviso = (controle.cancelado ? tr('pastas.cancelado') : '') + trm(B.fraseReabertura(lista.length, falhas));
      ocupado = false; progresso = null; desenhar(); aoMudar(faixas());
    }
    // Clique em "Reabrir pastas": UM gesto, e todos os pedidos de permissão saem juntos, de forma
    // síncrona no clique (requestPermission exige ativação do usuário).
    async function reabrirPastas() {
      if (ocupado) return;
      const lista = pastas.filter((p) => p.lembrada && p.handle);
      if (!lista.length) { aviso = tr('pastas.nenhuma-lembrada'); desenhar(); return; }
      const pedidos = lista.map((p) => Promise.resolve().then(() => p.handle.requestPermission({ mode: 'read' })).catch((e) => ({ erro: e })));
      aviso = tr('pastas.pedindo'); desenhar();
      const estados = (await Promise.all(pedidos)).map((r) => (typeof r === 'string' ? r : 'erro'));
      lista.forEach((p, i) => { p.erro = ''; });
      await reabrirLote(lista, estados);
    }
    // Na carga: lê os handles guardados, mostra como "lembrada" e, se a permissão já vale, reabre sozinho.
    async function carregarLembradas() {
      let registros = [];
      try { registros = await memoria.listar(); } catch (_) { registros = []; }
      const novas = B.juntarLembradas(pastas, registros);
      if (!novas.length) return;
      pastas.push(...novas);
      const estados = [];
      for (const p of novas) {
        try { estados.push(await p.handle.queryPermission({ mode: 'read' })); } catch (_) { estados.push('prompt'); }
      }
      const plano = B.planejarReabertura(estados);
      aviso = trm(B.fraseLembradas(novas.length, plano.pendentes.length)); desenhar();
      if (plano.prontas.length) {
        await reabrirLote(plano.prontas.map((i) => novas[i]), plano.prontas.map(() => 'granted'));
        if (plano.pendentes.length) aviso += ' ' + trm(B.fraseLembradas(novas.length, plano.pendentes.length));
        desenhar();
      }
    }
    if (window.VbMxI18n) window.VbMxI18n.aoMudar(() => desenhar());   // só os rótulos fixos; a frase em `aviso` segue no idioma em que nasceu
    desenhar();
    carregarLembradas().catch((e) => { aviso = tr('pastas.lembradas-falhou', { msg: (e && e.message) || e }); ocupado = false; desenhar(); });
    return { faixas, adicionar };
  }

  let ativo = null; // a instância criada por iniciar()
  const SEM_PASTAS = { nomes: [], escolha: '', ocupado: false };
  window.VbMxPainel = { iniciar,
    pastasParaFiltro: () => (ativo ? ativo.pastasParaFiltro() : SEM_PASTAS),
    escolherPasta: (nome) => { if (ativo) ativo.escolherPasta(nome); } };
})();
