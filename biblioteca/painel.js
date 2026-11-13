// VbMx — biblioteca por pastas (VB-07): a parte de NAVEGADOR. Painel (adicionar/remover pasta,
// progresso, cancelar), decodificação do áudio, Web Worker com Essentia.js 0.1.3 (CDN jsDelivr) e
// armazém IndexedDB. Toda a lógica testável mora em biblioteca.js; aqui só há cola com o DOM.
// Sem build: <script src="../analise/camelot.js"> + <script src="../biblioteca/biblioteca.js"> +
// este arquivo. Uso: VbMxPainel.iniciar({ montarEm: elemento, aoMudar: faixas => … }).
(function () {
  'use strict';
  const B = window.VbMxBiblioteca;
  const TAXA = 44100, JANELA_S = 90, MAX_S = 480; // JANELA_S: trecho do meio só para o tom; o BPM olha a faixa inteira (até MAX_S, centrada)
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
    onmessage = async (e) => {
      const { id, pcm, base, janela } = e.data;
      try {
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
        let graves = null;
        try { graves = envelopeGrave(pcm, 44100); } catch (_) { graves = null; } // sem envelope: grade só dos ticks
        let fluxo = null;
        try { fluxo = fluxoAmplo(pcm, 44100); } catch (_) { fluxo = null; } // sem fluxo: o refino por batida só usa os graves
        const saida = { id, candidatos, graves, fluxo, nota: k.key, escala: k.scale, forca: Math.round(k.strength * 100) / 100 };
        apagar(vetor, vmeio);
        postMessage(saida, (graves ? [graves.valores.buffer].concat(graves.sinal ? [graves.sinal.buffer] : []) : []).concat(fluxo ? [fluxo.valores.buffer] : []));
      } catch (err) { postMessage({ id, erro: String((err && err.message) || err) }); }
    };
  }

  function criarAnalisador() {
    let worker = null, ctx = null, seq = 0;
    const pendentes = new Map();
    function garante() {
      if (worker) return worker;
      const url = URL.createObjectURL(new Blob(['(' + corpoDoWorker.toString() + ')(' + window.VbMxBpm.envelopeGrave.toString() + ',' + window.VbMxBpm.fluxoAmplo.toString() + ')'], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => { const p = pendentes.get(e.data.id); if (p) { pendentes.delete(e.data.id); p(e.data); } };
      const falhaGeral = (msg) => { for (const p of pendentes.values()) p({ erro: msg }); pendentes.clear(); };
      worker.onerror = (e) => falhaGeral((e && e.message) || 'falha no worker (sem internet para o CDN do Essentia?)');
      worker.onmessageerror = () => falhaGeral('mensagem do worker ilegível');
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
      const w = garante(), id = ++seq;
      const r = await new Promise((ok) => { pendentes.set(id, ok); w.postMessage({ id, pcm, base: CDN, janela: JANELA_S }, [pcm.buffer]); });
      if (r.erro) throw new Error(r.erro);
      // oitava por consenso, ticks da faixa inteira, ataque do bumbo no envelope, 1 do compasso, um BPM só
      const a = window.VbMxBpm.resolver(r.candidatos, inicio, null, r.graves, r.fluxo);
      if (!a) throw new Error('BPM não detectado');
      return { bpm: a.bpm, camelot: window.Camelot.paraCamelot(r.nota, r.escala), forca: r.forca, grade: a.grade, ritmo: a.ritmo || null, duracao };
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
  const LEMBRA_SO_COM_PICKER = ' Esta pasta não será lembrada na próxima recarga: este caminho de seleção não dá ao navegador um acesso que possa ser guardado.';

  function iniciar({ montarEm, aoMudar, preferencia, aoDesenhar }) {
    const pastas = []; // { chave, nome, handle?, itens, resultados:[{item,resultado}], lembrada?, erro? }
    const cache = criarCacheDoNavegador();
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
      const nota = (p) => (p.erro ? `<span class="n" title="${esc(p.erro)}">${esc(p.erro)}</span>` : p.lembrada ? '<span class="n">lembrada — clique para reabrir</span>' : `<span class="n">${p.itens.length}</span>`);
      montarEm.innerHTML = `
        <div class="pastas-cab">
          <button type="button" class="botao-pasta" id="add-pasta" ${ocupado ? 'disabled' : ''}>${caminho === 'faixas' ? 'Adicionar faixas' : 'Adicionar pasta'}</button>
          ${aReabrir() ? `<button type="button" class="botao-pasta" id="reabrir-pastas" ${ocupado ? 'disabled' : ''}>Reabrir pastas</button>` : ''}
          ${caminho === 'faixas'
            ? '<input type="file" id="add-pasta-input" multiple accept="audio/*,.mp3,.wav,.aif,.aiff" hidden>'
            : '<input type="file" id="add-pasta-input" webkitdirectory multiple hidden>'}
          ${ocupado ? '<button type="button" class="botao-pasta" id="cancelar-analise">Cancelar</button>' : ''}
          <span class="pastas-estado" role="status">${esc(aviso || (progresso ? `Analisando ${progresso.feitas}/${progresso.total}${progresso.doCache ? ` · ${progresso.doCache} do cache` : ''}${progresso.atual ? ' · ' + progresso.atual.split('/').pop() : ''}` : (pastas.length ? `${total} arquivo(s) de áudio em ${pastas.length} pasta(s)` : (caminho === 'faixas' ? 'Nenhuma faixa: usando faixas de exemplo.' : 'Nenhuma pasta: usando faixas de exemplo.'))))}</span>
        </div>
        ${pastas.length ? `<ul class="pastas-lista">${pastas.map((p, i) => `<li><span>${esc(p.nome)}</span>${nota(p)}<button type="button" data-remover="${i}" aria-label="Remover a pasta ${esc(p.nome)}" ${ocupado ? 'disabled' : ''}>×</button></li>`).join('')}</ul>` : ''}`;
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
        aviso = p ? `Pasta "${p.nome}" removida${p.handle ? ' e esquecida' : ''}.` : ''; desenhar(); aoMudar(faixas());
      }));
    }
    // Todo caminho termina com uma frase em `aviso` (ou com o progresso na tela): a página nunca fica muda.
    async function escolher() {
      if (ocupado) return;
      if (caminho !== 'diretorio') {
        aviso = caminho === 'faixas' ? 'Abrindo o seletor de faixas…' : 'Abrindo o seletor de pastas…'; desenhar();
        montarEm.querySelector('#add-pasta-input').click(); return;
      }
      aviso = 'Abrindo o seletor de pastas…'; desenhar();
      let handle;
      try { handle = await window.showDirectoryPicker({ mode: 'read' }); }
      catch (e) {
        aviso = e && e.name === 'AbortError' ? 'Nenhuma pasta escolhida.' : `Não foi possível abrir o seletor (${(e && e.name) || 'erro'}: ${(e && e.message) || e}). Tente de novo ou use um Chrome recente.`;
        desenhar(); return;
      }
      aviso = `Varrendo "${handle.name}"…`; desenhar();
      try {
        const itens = await B.varrerDiretorio(handle, { aoAchar: (n) => { aviso = `Varrendo "${handle.name}"… ${n} faixa(s) encontrada(s)`; const e = montarEm.querySelector('.pastas-estado'); if (e) e.textContent = aviso; else desenhar(); } });
        const igual = await B.acharIgual(pastas, handle); // mesma pasta do disco: substitui, não duplica
        await adicionar({ nome: igual ? igual.nome : handle.name, chave: igual && igual.chave, itens, handle });
      } catch (e) { aviso = `Não foi possível ler a pasta "${handle.name}": ${(e && e.message) || e}`; desenhar(); }
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
      if (!pasta) { aviso = caminho === 'faixas' ? 'Nenhuma faixa escolhida.' : 'Nenhuma pasta escolhida.'; desenhar(); return; }
      if (ocupado) { aviso = 'Espere a análise em curso terminar (ou cancele) antes de adicionar outra pasta.'; desenhar(); return; }
      if (!pasta.itens.length) { aviso = caminho === 'faixas' ? 'Nenhum MP3/WAV/AIFF entre os arquivos escolhidos.' : `Nenhum MP3/WAV/AIFF em "${pasta.nome}".`; desenhar(); return; }
      pasta.resultados = [];
      const anterior = pastas.find((p) => p.nome === pasta.nome);
      pasta.chave = pasta.chave || (pasta.handle ? (anterior && anterior.chave) || novaChave() : undefined);
      const substituiu = B.colocarPasta(pastas, pasta); // mesma pasta de novo: substitui e reanalisa o que faltou
      let lembrou = '';
      if (pasta.handle) {
        const gravou = await memoria.gravar({ chave: pasta.chave, nome: pasta.nome, handle: pasta.handle });
        if (!gravou) lembrou = ' Não consegui guardar esta pasta para a próxima recarga (IndexedDB indisponível).';
      } else lembrou = LEMBRA_SO_COM_PICKER;
      aviso = `${pasta.itens.length} faixa(s) encontrada(s) em "${pasta.nome}"${substituiu ? ' (pasta já listada: reanalisando o que não tinha resultado)' : ''}. Preparando o analisador…`;
      ocupado = true; controle = B.criarControle(); analisador = analisador || criarAnalisador(); desenhar();
      try {
        const r = await analisarPasta(pasta);
        aviso = B.resumoFila(r, pasta.itens.length) + lembrou;
      } catch (e) { aviso = 'Falha na análise: ' + ((e && e.message) || e) + lembrou; }
      ocupado = false; progresso = null; desenhar(); aoMudar(faixas());
    }

    // Reabre uma pasta lembrada: permissão (pedida só se `pedir`, ou seja, dentro de um gesto),
    // varredura e análise. Devolve null se deu certo, ou o motivo da falha.
    async function reabrirUma(p, estado) {
      try {
        if (estado !== 'granted') return 'sem permissão de leitura (o navegador não liberou a pasta)';
        p.itens = await B.varrerDiretorio(p.handle, { cancelado: () => controle && controle.cancelado });
        if (!p.itens.length) return 'nenhum MP3/WAV/AIFF encontrado';
        p.lembrada = false; p.erro = ''; p.resultados = [];
        analisador = analisador || criarAnalisador();
        await analisarPasta(p);
        return null;
      } catch (e) { return B.motivoFalha(e); }
    }
    async function reabrirLote(lista, estados) {
      ocupado = true; controle = B.criarControle(); aviso = 'Reabrindo pastas lembradas…'; desenhar();
      const falhas = [];
      for (let i = 0; i < lista.length; i++) {
        if (controle.cancelado) break;
        const p = lista[i];
        aviso = `Reabrindo "${p.nome}"…`; progresso = null; desenhar();
        const motivo = await reabrirUma(p, estados[i]);
        if (motivo) { p.erro = motivo; p.lembrada = true; falhas.push({ nome: p.nome, motivo }); }
      }
      aviso = (controle.cancelado ? 'Cancelado. ' : '') + B.fraseReabertura(lista.length, falhas);
      ocupado = false; progresso = null; desenhar(); aoMudar(faixas());
    }
    // Clique em "Reabrir pastas": UM gesto, e todos os pedidos de permissão saem juntos, de forma
    // síncrona no clique (requestPermission exige ativação do usuário).
    async function reabrirPastas() {
      if (ocupado) return;
      const lista = pastas.filter((p) => p.lembrada && p.handle);
      if (!lista.length) { aviso = 'Nenhuma pasta lembrada para reabrir.'; desenhar(); return; }
      const pedidos = lista.map((p) => Promise.resolve().then(() => p.handle.requestPermission({ mode: 'read' })).catch((e) => ({ erro: e })));
      aviso = 'Pedindo permissão ao navegador…'; desenhar();
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
      aviso = B.fraseLembradas(novas.length, plano.pendentes.length); desenhar();
      if (plano.prontas.length) {
        await reabrirLote(plano.prontas.map((i) => novas[i]), plano.prontas.map(() => 'granted'));
        if (plano.pendentes.length) aviso += ' ' + B.fraseLembradas(novas.length, plano.pendentes.length);
        desenhar();
      }
    }
    desenhar();
    carregarLembradas().catch((e) => { aviso = 'Não consegui ler as pastas lembradas: ' + ((e && e.message) || e); ocupado = false; desenhar(); });
    return { faixas, adicionar };
  }

  let ativo = null; // a instância criada por iniciar()
  const SEM_PASTAS = { nomes: [], escolha: '', ocupado: false };
  window.VbMxPainel = { iniciar,
    pastasParaFiltro: () => (ativo ? ativo.pastasParaFiltro() : SEM_PASTAS),
    escolherPasta: (nome) => { if (ativo) ativo.escolherPasta(nome); } };
})();
