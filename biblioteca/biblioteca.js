// VbMx — biblioteca por pastas (VB-07): a parte LÓGICA, sem DOM e sem áudio.
// Varredura de nomes, título/artista do nome do arquivo, chave e cache, fila com progresso e
// cancelamento, e o mapeamento para o formato que `VbMxMotor.compativeis` lê.
// Roda no navegador (global `VbMxBiblioteca`) e no Node (`require`). A decodificação e a análise
// (Essentia.js) ficam em painel.js, injetadas aqui como função `analisar` — por isso dá para
// testar tudo em Node sem áudio real (biblioteca/testar-biblioteca.js).
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxBiblioteca = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EXTENSOES = ['mp3', 'wav', 'aiff', 'aif'];
  // Sobe quando o analisador mudar: invalida o cache velho. 2 em 2026-10-25: a versão 1 gravou
  // erro ("document is not defined" do Worker) para toda faixa, e a pasta re-adicionada vinha
  // inteira do cache sem reanalisar nada.
  // 3 em 2026-10-25 (VB-13): a análise passa a guardar a grade ({bpm, primeira}); entrada v2 não
  // tem grade e não deve ser servida como se tivesse.
  // 4 em 2026-10-25 (BPM): o BPM passa a sair da faixa inteira, por consenso de 3 estimadores com
  // oitava na faixa 70–180 e ajuste de reta nos ticks (biblioteca/bpm.js); entrada v3 tem BPM
  // de 1 casa da janela de 90 s, diferente do da grade.
  // 5 em 2026-10-26 (grade no bumbo): BPM com 6 casas (não 2), reta refeita nos ataques do bumbo
  // (envelope de graves do worker) e `primeira` = o 1 do compasso em [0, 4 períodos); entrada v4
  // tem BPM de 2 casas e âncora no tick, em [0, período), sem compasso.
  // 7 em 2026-10-27 ("bumbo com caixa"): o 1 do compasso passa a vir da ENTRADA do bumbo (intro e break) quando
  // duas entradas concordam, antes do grave mais forte (que seguia a linha de baixo e errava por 1–3 batidas);
  // entrada v6 pode ter o 1 do compasso fora do lugar.
  // 8 em 2026-11-08 (VB-68): faixa sem intro nem break acha o 1 pela troca de harmonia do baixo; a v7 tinha só o
  // grave mais forte nela.
  // 9 em 2026-11-08 (Dancin): ticks do Essentia no contratempo do bumbo a faixa inteira; a grade passa a ir para o
  // bumbo (subida no meio do tick + varredura de pitch de bumbo). A v8 deixava o 1 na caixa e o SYNC fora de fase.
  const VERSAO_ANALISE = 10;

  function extensao(nome) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(nome || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function ehAudio(nome) {
    const base = String(nome || '').split('/').pop();
    return !base.startsWith('.') && EXTENSOES.includes(extensao(base)); // ignora "._x.mp3" do macOS
  }

  // "03 - Ana Flauta - Sopro.mp3" -> { titulo: 'Sopro', artista: 'Ana Flauta' }.
  // Sem " - " no nome: título = nome inteiro, artista = ''. Tira número de faixa no começo.
  function tituloArtista(nomeArquivo) {
    let base = String(nomeArquivo || '').split('/').pop().replace(/\.[A-Za-z0-9]+$/, '');
    base = base.replace(/\s*\[[^\]]*(?:\.[a-z]{2,}|slider)[^\]]*\]\s*$/i, '').replace(/_/g, ' ').replace(/^\s*\d{1,3}\s*[-.)]\s+/, '').replace(/\s+/g, ' ').trim();
    const i = base.indexOf(' - ');
    if (i > 0 && i < base.length - 3) return { artista: base.slice(0, i).trim(), titulo: base.slice(i + 3).trim() };
    return { artista: '', titulo: base || String(nomeArquivo || '') };
  }

  const chaveCache = (caminho, tamanho, data) => `${VERSAO_ANALISE}|${caminho}|${tamanho}|${data}`;

  // ---- grade (VB-13) -----------------------------------------------------------------------
  // Grade guardada na análise: { bpm, primeira } — `primeira` = s do 1º tempo forte (1 do compasso)
  // a partir do início da faixa (0 <= primeira < 4·60/bpm; a análise sem envelope de graves não sabe
  // o compasso e fica em [0, 60/bpm)); o motor (VbMxGrade.daFaixa) completa o resto.
  const COMPASSO = 4, CASAS = 6;
  const ehNum = v => typeof v === 'number' && Number.isFinite(v);
  const gradeValida = g => !!g && ehNum(g.bpm) && g.bpm > 0 && ehNum(g.primeira) && g.primeira >= 0;
  const modulo = (a, m) => ((a % m) + m) % m;
  const arred = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

  // Converte os `ticks` do RhythmExtractor2013 (s DENTRO da janela analisada) em grade da FAIXA.
  // `inicio` = s da faixa em que a janela começa (a análise olha 90 s do meio, não o começo).
  // Ajusta uma reta tick = a + k·período aos ticks (o BPM de 1 casa, extrapolado por minutos,
  // derrapa dezenas de ms; os ticks dão o período fino) e recua a fase até a 1ª batida da faixa.
  // Devolve { bpm, primeira } ou null se não houver tick utilizável.
  function gradeDosTicks(ticks, inicio, bpm) {
    const ini = ehNum(inicio) ? inicio : 0;
    const t = Array.from(ticks || []).filter(ehNum).sort((x, y) => x - y);
    if (!t.length || !ehNum(bpm) || bpm <= 0) return null;
    const p0 = 60 / bpm;
    const k = t.map(x => Math.round((x - t[0]) / p0));
    let periodo = p0, fase = t[0];
    if (t.length >= 4 && k[k.length - 1] >= 3) {
      const n = t.length, mk = k.reduce((a, b) => a + b, 0) / n, mt = t.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sxy += (k[i] - mk) * (t[i] - mt); sxx += (k[i] - mk) ** 2; }
      const p = sxx > 0 ? sxy / sxx : p0;
      if (Math.abs(p - p0) / p0 <= 0.02) { periodo = p; fase = mt - p * mk; } // fora disso o extrator oscilou (×2, ÷2): fica o BPM
      else fase = t[0];
    }
    return { bpm: arred(60 / periodo, 3), primeira: arred(modulo(fase + ini, periodo), 4) };
  }

  // Ajustes manuais (puros; devolvem nova grade, ou a mesma se for inválida): mover a 1ª batida
  // `delta` s, dobrar/metade do BPM (a 1ª batida não muda). A volta é de um COMPASSO (4 batidas),
  // não de uma batida: dar a volta por batida trocava o 1 do compasso por outra batida.
  function moverGrade(g, delta) {
    if (!gradeValida(g) || !ehNum(delta)) return g;
    return { bpm: g.bpm, primeira: arred(modulo(g.primeira + delta, COMPASSO * 60 / g.bpm), CASAS) };
  }
  function escalarGrade(g, fator) {
    if (!gradeValida(g) || !(fator > 0)) return g;
    const bpm = arred(g.bpm * fator, CASAS), periodo = 60 / bpm;
    return { bpm, primeira: arred(modulo(g.primeira, COMPASSO * periodo), CASAS) };
  }

  // ---- varredura ---------------------------------------------------------------------------
  // `raiz` imita FileSystemDirectoryHandle: { name, entries(): async iterável de [nome, handle] };
  // handle.kind é 'file' (com getFile()) ou 'directory'. Devolve itens { caminho, nome, obter() }.
  async function varrerDiretorio(raiz, opcoes) {
    const o = opcoes || {};
    const achados = [];
    async function desce(dir, prefixo) {
      for await (const [nome, h] of dir.entries()) {
        if (o.cancelado && o.cancelado()) return;
        if (h.kind === 'directory') { if (!nome.startsWith('.')) await desce(h, prefixo + nome + '/'); }
        else if (h.kind === 'file' && ehAudio(nome)) {
          let f = null;
          try { f = await h.getFile(); } catch (_) { /* arquivo sumiu no meio: entra marcado, sem tamanho */ }
          achados.push({ caminho: prefixo + nome, nome, tamanho: f ? f.size : -1, data: f ? f.lastModified : -1, obter: async () => f || h.getFile() });
          if (o.aoAchar) o.aoAchar(achados.length);
        }
      }
    }
    await desce(raiz, (raiz.name || 'pasta') + '/');
    return achados;
  }

  // Reserva `<input webkitdirectory>`: recebe os File com webkitRelativePath.
  function varrerLista(arquivos) {
    const achados = [];
    for (const f of Array.from(arquivos || [])) {
      const caminho = f.webkitRelativePath || f.name;
      if (!ehAudio(caminho) || caminho.split('/').some((p, i, a) => i < a.length - 1 && p.startsWith('.'))) continue;
      achados.push({ caminho, nome: f.name, tamanho: f.size, data: f.lastModified, obter: async () => f });
    }
    return achados;
  }


  // ---- caminho de seleção ------------------------------------------------------------------
  // 'diretorio' = showDirectoryPicker (Chrome/Edge; guarda handle). 'pasta' = <input webkitdirectory>
  // (Safari/Firefox de mesa). 'faixas' = <input type=file multiple> do app Arquivos: único que o
  // Safari do iPad/iPhone honra de verdade (showDirectoryPicker não existe; webkitdirectory falha).
  // `amb` injeta o ambiente: { temPicker, userAgent, plataforma, toques } — no navegador vem de window/navigator.
  function ehIOS(amb) {
    const a = amb || {};
    if (/iPad|iPhone|iPod/.test(a.userAgent || '')) return true;
    return a.plataforma === 'MacIntel' && (a.toques || 0) > 1; // iPadOS 13+ se apresenta como Mac
  }
  function escolherCaminho(amb) {
    const a = amb || {};
    if (ehIOS(a)) return 'faixas';
    return a.temPicker ? 'diretorio' : 'pasta';
  }
  // Cada lote de faixas soltas vira uma "pasta" própria: o nome único evita que o segundo lote substitua o primeiro.
  function nomeLoteFaixas(pastas) {
    let n = 1;
    const nomes = new Set((pastas || []).map((p) => p.nome));
    while (nomes.has('Faixas ' + n)) n++;
    return 'Faixas ' + n;
  }
  // O servidor de stems só existe em localhost (servir.py); em hospedagem estática o botão não faz sentido.
  function stemsDisponiveis(loc) {
    const h = (loc && loc.hostname) || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  }

  // ---- cache -------------------------------------------------------------------------------
  // Armazém = { get(chave), put(chave, valor) } assíncrono. Falha de armazém nunca propaga.
  function armazemMemoria() {
    const m = new Map();
    return { tipo: 'memoria', async get(k) { return m.get(k); }, async put(k, v) { m.set(k, v); }, tamanho: () => m.size };
  }

  // Armazém IndexedDB genérico: um banco (versão 1) com uma store. O cache de análise usa o
  // padrão ('vbmx-biblioteca'/'analises'); as pastas lembradas usam um banco próprio (BANCO_PASTAS).
  function armazemIndexedDB(idb, nomeBanco, nomeStore) {
    const store = nomeStore || 'analises';
    let abrindo = null;
    const abrir = () => abrindo || (abrindo = new Promise((ok, falha) => {
      const req = idb.open(nomeBanco || 'vbmx-biblioteca', 1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
      req.onblocked = () => falha(new Error('IndexedDB bloqueado'));
    }));
    const pedido = (modo, fn) => abrir().then(db => new Promise((ok, falha) => {
      const tx = db.transaction(store, modo), r = fn(tx.objectStore(store));
      tx.oncomplete = () => ok(r.result); tx.onerror = () => falha(tx.error); tx.onabort = () => falha(tx.error);
    }));
    return { tipo: 'indexeddb', get: k => pedido('readonly', s => s.get(k)), put: (k, v) => pedido('readwrite', s => s.put(v, k)),
      apagar: k => pedido('readwrite', s => s.delete(k)), todos: () => pedido('readonly', s => s.getAll()) };
  }

  // Cache à prova de falha: qualquer erro do armazém vira "não achei"/"não gravei".
  function criarCache(armazem) {
    let ativo = !!armazem;
    return {
      get ativo() { return ativo; },
      async ler(caminho, tamanho, data) {
        if (!ativo) return null;
        try { const v = await armazem.get(chaveCache(caminho, tamanho, data)); return v || null; }
        catch (_) { ativo = false; return null; }
      },
      async gravar(caminho, tamanho, data, resultado) {
        if (!ativo) return false;
        try { await armazem.put(chaveCache(caminho, tamanho, data), resultado); return true; }
        catch (_) { ativo = false; return false; }
      },
    };
  }

  // ---- fila --------------------------------------------------------------------------------
  // Analisa um por vez (o áudio da festa não pode competir com uma fila paralela). Para cada
  // item: cache -> senão `analisar(item)` -> grava. Erro do analisador marca a faixa, não quebra.
  // Erro NUNCA vai para o cache, e erro que já esteja lá é ignorado: falha de rede, de CDN ou do
  // Worker é passageira, e a faixa tem de ser reanalisada na próxima vez.
  // `controle.cancelar()` interrompe entre faixas; o que já foi analisado fica no cache.
  function criarControle() {
    return { cancelado: false, cancelar() { this.cancelado = true; } };
  }

  async function analisarFila(itens, { cache, analisar, aoProgredir, controle } = {}) {
    const ctl = controle || criarControle();
    const resultados = [];
    let feitas = 0, doCache = 0, erros = 0;
    const avisa = (atual) => aoProgredir && aoProgredir({ feitas, total: itens.length, doCache, erros, atual, cancelado: ctl.cancelado });
    for (const item of itens) {
      if (ctl.cancelado) break;
      avisa(item.caminho);
      let r = cache ? await cache.ler(item.caminho, item.tamanho, item.data) : null;
      if (r && r.analisavel === false) r = null; // erro cacheado por versão antiga: reanalisa
      if (r) doCache += 1;
      else {
        try {
          const a = await analisar(item);
          r = { bpm: a && a.bpm, camelot: a && a.camelot, forca: a && a.forca, analisavel: true };
          if (a && typeof a.duracao === 'number' && a.duracao > 0) r.duracao = a.duracao;
          if (a && gradeValida(a.grade)) r.grade = { bpm: a.grade.bpm, primeira: a.grade.primeira };
          if (!(typeof r.bpm === 'number' && r.bpm > 0) || !/^(?:[1-9]|1[0-2])[AB]$/.test(String(r.camelot))) {
            r = { analisavel: false, erro: 'BPM ou tom não detectado' };
          }
        } catch (e) {
          r = { analisavel: false, erro: String((e && e.message) || e) };
        }
        if (!r.analisavel) erros += 1;
        else if (cache) await cache.gravar(item.caminho, item.tamanho, item.data, r);
      }
      resultados.push({ item, resultado: r });
      feitas += 1;
    }
    avisa(null);
    return { resultados, feitas, doCache, erros, cancelado: ctl.cancelado };
  }

  // Frase de estado ao fim da fila — sempre há uma, em todo caminho (a tela nunca fica muda).
  function resumoFila(r, total) {
    const partes = [`${r.feitas - r.erros} de ${total} com BPM e tom`];
    if (r.doCache) partes.push(`${r.doCache} do cache`);
    if (r.erros) partes.push(`${r.erros} sem análise (passe o mouse na faixa para ver o motivo)`);
    return (r.cancelado ? 'Cancelado: ' : 'Concluído: ') + partes.join(' · ') + (r.cancelado ? ' · o resto fica para depois' : '') + '.';
  }

  // Mesma pasta adicionada de novo substitui a anterior (no lugar), em vez de duplicar a lista;
  // a fila reanalisa só o que não tem resultado bom, porque o resto vem do cache.
  function colocarPasta(pastas, pasta) {
    const i = pastas.findIndex(p => p.nome === pasta.nome);
    if (i >= 0) pastas.splice(i, 1, pasta); else pastas.push(pasta);
    return i >= 0;
  }

  // ---- pastas lembradas entre recargas -------------------------------------------------------
  // O FileSystemDirectoryHandle (showDirectoryPicker) é clonável: vai inteiro para o IndexedDB.
  // Registro = { chave, nome, handle }. Pelo fallback <input webkitdirectory> não há handle.
  const BANCO_PASTAS = 'vbmx-pastas-v1'; // versionado, separado do cache de análise

  function armazemPastasMemoria() {
    const m = new Map();
    return { tipo: 'memoria', async get(k) { return m.get(k); }, async put(k, v) { m.set(k, v); },
      async apagar(k) { m.delete(k); }, async todos() { return Array.from(m.values()); } };
  }

  // À prova de falha, como o cache: qualquer erro vira "nada lembrado"/"não gravei".
  function criarMemoriaPastas(armazem) {
    let ativo = !!armazem;
    const seguro = async (fn, padrao) => { if (!ativo) return padrao; try { return await fn(); } catch (_) { ativo = false; return padrao; } };
    return {
      get ativo() { return ativo; },
      listar: () => seguro(async () => (await armazem.todos()).filter(r => r && r.chave && r.nome && r.handle), []),
      gravar: (reg) => seguro(async () => { await armazem.put(reg.chave, { chave: reg.chave, nome: reg.nome, handle: reg.handle }); return true; }, false),
      remover: (chave) => seguro(async () => { await armazem.apagar(chave); return true; }, false),
    };
  }

  // Dentre `candidatas` (com .handle), a que aponta para a mesma pasta do disco (isSameEntry).
  // Sem isSameEntry (ou se lançar), cai para o nome. Devolve a candidata ou null.
  async function acharIgual(candidatas, handle) {
    for (const c of candidatas) {
      if (!c.handle) continue;
      try { if (typeof handle.isSameEntry === 'function' ? await handle.isSameEntry(c.handle) : c.nome === handle.name) return c; }
      catch (_) { if (c.nome === handle.name) return c; }
    }
    return null;
  }

  // Pastas lembradas que ainda não estão na lista viram marcadores { lembrada:true, itens:[] }.
  function juntarLembradas(pastas, registros) {
    const novas = [];
    for (const r of registros || []) {
      if (pastas.some(p => p.chave === r.chave || p.nome === r.nome) || novas.some(p => p.chave === r.chave)) continue;
      novas.push({ chave: r.chave, nome: r.nome, handle: r.handle, itens: [], resultados: [], lembrada: true });
    }
    return novas;
  }

  // Permissão de leitura só se PEDE num gesto; se já está 'granted' dá para varrer sozinho.
  // `estados` = queryPermission de cada pasta lembrada. Devolve os índices de cada grupo.
  function planejarReabertura(estados) {
    const prontas = [], pendentes = [];
    estados.forEach((e, i) => (e === 'granted' ? prontas : pendentes).push(i));
    return { prontas, pendentes, acao: !estados.length ? 'nada' : (pendentes.length ? 'pedir' : 'varrer') };
  }

  function motivoFalha(e) {
    const n = e && e.name;
    if (n === 'NotFoundError') return 'a pasta sumiu (disco externo desmontado ou pasta apagada/renomeada)';
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'sem permissão de leitura';
    return (e && e.message) || n || 'erro desconhecido';
  }

  // Frase de estado na carga da página (sempre há uma quando existe pasta lembrada).
  function fraseLembradas(total, pendentes) {
    if (!total) return '';
    if (pendentes) return `${total} pasta(s) lembrada(s) — ${pendentes} precisa(m) de um clique em "Reabrir pastas" para o navegador liberar a leitura.`;
    return `${total} pasta(s) lembrada(s): reabrindo…`;
  }

  // Frase ao fim de "Reabrir pastas": quantas voltaram e, por nome, as que falharam e por quê.
  function fraseReabertura(total, falhas) {
    const f = falhas || [];
    const ok = total - f.length;
    const base = `${ok} de ${total} pasta(s) reaberta(s)`;
    if (!f.length) return base + '.';
    return base + ' · ' + f.map(x => `"${x.nome}": ${x.motivo}`).join(' · ') + ' (use × para remover a que não volta).';
  }

  // ---- mapeamento para o motor -------------------------------------------------------------
  // Devolve faixas { id, titulo, artista, bpm, camelot, caminho, analisavel, erro? }. Não
  // analisável: bpm/camelot nulos e analisavel:false — o motor as exclui e conta, a tela as marca.
  function paraMotor(resultados, primeiroId) {
    let id = primeiroId || 1;
    return resultados.map(({ item, resultado: r }) => {
      const base = Object.assign({ id: id++ }, tituloArtista(item.nome), { caminho: item.caminho, obter: item.obter });
      if (r && r.analisavel !== false) {
        const f = Object.assign(base, { bpm: r.bpm, camelot: r.camelot, analisavel: true });
        if (typeof r.duracao === 'number' && r.duracao > 0) f.duracao = r.duracao; // segundos; liga o selo de auto-loop (VB-53)
        if (gradeValida(r.grade)) f.grade = { bpm: r.grade.bpm, primeira: r.grade.primeira }; // lida por VbMxGrade.daFaixa
        return f;
      }
      return Object.assign(base, { bpm: null, camelot: null, analisavel: false, erro: (r && r.erro) || 'não analisada' });
    });
  }

  return { EXTENSOES, VERSAO_ANALISE, gradeValida, gradeDosTicks, moverGrade, escalarGrade, ehAudio, tituloArtista, chaveCache, varrerDiretorio, varrerLista,
    ehIOS, escolherCaminho, nomeLoteFaixas, stemsDisponiveis,
    armazemMemoria, armazemIndexedDB, BANCO_PASTAS, armazemPastasMemoria, criarMemoriaPastas, acharIgual,
    juntarLembradas, planejarReabertura, motivoFalha, fraseLembradas, fraseReabertura, criarCache, criarControle, analisarFila, resumoFila, colocarPasta, paraMotor };
});
