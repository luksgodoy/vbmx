// ===================== VbMxHistorico — histórico: o que tocou, quando (regra P10 do "no ar") =====================
// Dono: VB-18 (onda 1). Lógica pura (UMD), testada em Node por biblioteca/testar-historico.js.
// Contrato: docs/contratos.md. Sem DOM e sem relógio próprio: todo tempo entra por argumento.
//
// Regra P10 (docs/decisoes.md): uma faixa "tocou" quando soma 30 s ou mais NO AR, registrando se veio
// da sugestão. "No ar" = o deck está tocando E o ganho do canal (volume × crossfader, a mesma conta de
// VbMxReproducao.ganhoDoCanal) é pelo menos GANHO_MINIMO. Os segundos somam por carga do deck: pausar
// e voltar à mesma faixa continua a contar; carregar outra faixa (ou descarregar) fecha a conta.
//
// API:
//   MINIMO_NO_AR (30 s), GANHO_MINIMO (0.05)
//   ganhoDoCanal(letra, mixer)        → 0…1 (mixer = {A:{vol}, B:{vol}, xfade})
//   noAr(tocando, ganho, minimo?)     → boolean
//   criarSessao({epocaMs, minimo, ganhoMinimo, aoEntrar, aoAtualizar, entradas})
//     tempo `t` em segundos, de um relógio qualquer e monotônico; `epocaMs` = Date.now() em t = 0.
//     .carregou(letra, faixa, t, {veioDaSugestao}) .descarregou(letra, t)
//     .tocou(letra, t) .pausou(letra, t) .fim(letra, t) .mixer(mx, t) .avancar(t)
//     .entradas() (cópia)  .estado(letra)  .recarregar(entradas)
//   taxaDeAceitacao(entradas)         → {aceitas, total, taxa}    (o X do VB-04; taxa null sem faixa)
//   exportarTexto(set, {fusoMin})     → texto do histórico + taxa
//   fmtDuracao(s), fmtHora(ms, fusoMin)
//   preparacaoAdicionar(lista, faixa) / preparacaoRemover(lista, id) / preparacaoMover(lista, de, para)
//   preparacaoMarcar(lista, entradas) → itens com `tocada`
//   novoSet(id, nomeOuNull, ms)       → {id, nome, inicio_ms, entradas: [], preparacao: []}
//   criarArmazemMemoria() / criarArmazemIDB(indexedDB, nomeDoBanco?)
//     async: lerSet(id) gravarSet(set) listarSets() apagarSet(id) lerMeta(chave) gravarMeta(chave, valor)
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxHistorico = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const MINIMO_NO_AR = 30;
  const GANHO_MINIMO = 0.05;

  let Reproducao = raiz.VbMxReproducao || null;
  if (!Reproducao && typeof require === 'function') { try { Reproducao = require('../motor/reproducao.js'); } catch (_) { /* sem a conta pronta: cai na cópia abaixo */ } }

  const num = v => typeof v === 'number' && Number.isFinite(v);
  function trava(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function ganhoDoCanal(letra, mixer) {
    const m = mixer || {};
    const vol = m[letra] && num(m[letra].vol) ? m[letra].vol : 0;
    const x = num(m.xfade) ? m.xfade : 0;
    if (Reproducao && Reproducao.ganhoDoCanal) return Reproducao.ganhoDoCanal(letra, vol, x);
    const xf = letra === 'A' ? (x <= 0 ? 1 : (100 - x) / 100) : (x >= 0 ? 1 : (100 + x) / 100);
    return trava(vol, 0, 100) / 100 * xf;
  }
  function noAr(tocando, ganho, minimo = GANHO_MINIMO) { return !!tocando && num(ganho) && ganho >= minimo; }

  // ---------------- sessão: soma segundos no ar por deck ----------------
  function copiaEntrada(e) { return { ...e, faixa: { ...e.faixa } }; }
  function resumoFaixa(f) {
    return { id: f.id, titulo: f.titulo || '', artista: f.artista || '', bpm: num(f.bpm) ? f.bpm : null, camelot: f.camelot || '', caminho: f.caminho || '' };
  }

  function criarSessao(opcoes = {}) {
    const epocaMs = num(opcoes.epocaMs) ? opcoes.epocaMs : 0;
    const minimo = num(opcoes.minimo) ? opcoes.minimo : MINIMO_NO_AR;
    const ganhoMin = num(opcoes.ganhoMinimo) ? opcoes.ganhoMinimo : GANHO_MINIMO;
    const aoEntrar = typeof opcoes.aoEntrar === 'function' ? opcoes.aoEntrar : null;
    const aoAtualizar = typeof opcoes.aoAtualizar === 'function' ? opcoes.aoAtualizar : null;
    const lista = Array.isArray(opcoes.entradas) ? opcoes.entradas.map(copiaEntrada) : [];
    let seq = lista.reduce((m, e) => Math.max(m, e.n || 0), 0);
    let mx = { A: { vol: 100 }, B: { vol: 100 }, xfade: 0 };
    let ultimo = null;                       // último t integrado
    const decks = {};                        // letra → carga atual

    function integrar(t) {
      if (!num(t)) return;
      if (ultimo === null) { ultimo = t; return; }
      const dt = t - ultimo;
      if (dt <= 0) return;
      for (const letra of Object.keys(decks)) {
        const d = decks[letra];
        if (!d.faixa || !noAr(d.tocando, ganhoDoCanal(letra, mx), ganhoMin)) continue;
        if (d.primeiroAr === null) d.primeiroAr = ultimo;
        d.acumulado += dt;
        if (d.entrada) { d.entrada.segundos = d.acumulado; if (aoAtualizar) aoAtualizar(copiaEntrada(d.entrada)); }
        else if (d.acumulado >= minimo) {
          seq += 1;
          d.entrada = { n: seq, faixa: d.faixa, deck: letra, inicio_ms: Math.round(epocaMs + d.primeiroAr * 1000),
            segundos: d.acumulado, veio_da_sugestao: d.veio };
          lista.push(d.entrada);
          if (aoEntrar) aoEntrar(copiaEntrada(d.entrada));
        }
      }
      ultimo = t;
    }
    const deck = letra => decks[letra] || (decks[letra] = { faixa: null, veio: false, tocando: false, acumulado: 0, primeiroAr: null, entrada: null });

    return {
      carregou(letra, faixa, t, extra = {}) {
        integrar(t);
        decks[letra] = { faixa: resumoFaixa(faixa), veio: !!extra.veioDaSugestao, tocando: false, acumulado: 0, primeiroAr: null, entrada: null };
      },
      descarregou(letra, t) { integrar(t); decks[letra] = { faixa: null, veio: false, tocando: false, acumulado: 0, primeiroAr: null, entrada: null }; },
      tocou(letra, t) { integrar(t); deck(letra).tocando = true; },
      pausou(letra, t) { integrar(t); deck(letra).tocando = false; },
      fim(letra, t) { integrar(t); deck(letra).tocando = false; },
      mixer(novo, t) { integrar(t); mx = { A: { vol: novo && novo.A ? novo.A.vol : 0 }, B: { vol: novo && novo.B ? novo.B.vol : 0 }, xfade: novo ? novo.xfade : 0 }; },
      avancar(t) { integrar(t); },
      entradas() { return lista.map(copiaEntrada); },
      estado(letra) { const d = decks[letra]; return d ? { faixa: d.faixa, tocando: d.tocando, acumulado: d.acumulado, registrada: !!d.entrada, veio: d.veio } : null; },
      recarregar(entradas) {
        lista.length = 0;
        for (const e of entradas || []) lista.push(copiaEntrada(e));
        seq = lista.reduce((m, e) => Math.max(m, e.n || 0), 0);
        for (const l of Object.keys(decks)) decks[l].entrada = null;
      },
    };
  }

  // ---------------- o X do VB-04 ----------------
  function taxaDeAceitacao(entradas) {
    // faixas vindas da sugestão ÷ faixas tocadas ≥ 30 s (entrada sem `segundos` numérico conta: já passou do corte)
    const lista = (entradas || []).filter(e => !num(e.segundos) || e.segundos >= MINIMO_NO_AR);
    const aceitas = lista.filter(e => e.veio_da_sugestao).length;
    return { aceitas, total: lista.length, taxa: lista.length ? aceitas / lista.length : null };
  }

  // ---------------- texto ----------------
  const dois = n => String(n).padStart(2, '0');
  function fmtDuracao(s) {
    const t = Math.max(0, Math.round(num(s) ? s : 0));
    return `${Math.floor(t / 60)}:${dois(t % 60)}`;
  }
  function fmtHora(ms, fusoMin) {
    const f = num(fusoMin) ? fusoMin : -new Date(ms).getTimezoneOffset();
    const d = new Date(ms + f * 60000);
    return `${dois(d.getUTCHours())}:${dois(d.getUTCMinutes())}`;
  }
  function fmtData(ms, fusoMin) {
    const f = num(fusoMin) ? fusoMin : -new Date(ms).getTimezoneOffset();
    const d = new Date(ms + f * 60000);
    return `${dois(d.getUTCDate())}/${dois(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  function exportarTexto(set, opcoes = {}) {
    const fuso = opcoes.fusoMin;
    const entradas = (set && set.entradas) || [];
    const linhas = [`Histórico do set${set && set.nome ? ' — ' + set.nome : ''}${set && num(set.inicio_ms) ? ' (' + fmtData(set.inicio_ms, fuso) + ')' : ''}`, ''];
    entradas.forEach((e, i) => {
      const f = e.faixa || {};
      const bpm = num(f.bpm) ? ` ${String(Math.round(f.bpm * 10) / 10).replace('.', ',')} BPM` : '';
      linhas.push(`${dois(i + 1)}  ${fmtHora(e.inicio_ms, fuso)}  deck ${e.deck}  ${fmtDuracao(e.segundos)}  ${f.artista ? f.artista + ' — ' : ''}${f.titulo || '(sem título)'}  [${f.camelot || '?'}${bpm}]  ${e.veio_da_sugestao ? 'veio da sugestão' : 'fora da sugestão'}`);
    });
    if (!entradas.length) linhas.push('(nenhuma faixa passou de ' + MINIMO_NO_AR + ' s no ar)');
    const r = taxaDeAceitacao(entradas);
    linhas.push('', r.total ? `Taxa de aceitação da sugestão: ${r.aceitas} de ${r.total} (${Math.round(r.taxa * 100)}%)` : 'Taxa de aceitação da sugestão: sem faixa tocada ainda');
    return linhas.join('\n') + '\n';
  }

  // ---------------- lista de preparação (imutável) ----------------
  const mesma = (a, b) => a.id === b.id && (a.caminho || '') === (b.caminho || '');
  function preparacaoAdicionar(lista, faixa) {
    const item = resumoFaixa(faixa);
    if ((lista || []).some(x => mesma(x, item))) return (lista || []).slice();
    return [...(lista || []), item];
  }
  function preparacaoRemover(lista, id) { return (lista || []).filter(x => x.id !== id); }
  function preparacaoMover(lista, de, para) {
    const l = (lista || []).slice();
    if (de < 0 || de >= l.length) return l;
    const p = trava(para, 0, l.length - 1);
    const [x] = l.splice(de, 1);
    l.splice(p, 0, x);
    return l;
  }
  function preparacaoMarcar(lista, entradas) {
    return (lista || []).map(x => ({ ...x, tocada: (entradas || []).some(e => e.faixa && mesma(e.faixa, x)) }));
  }

  // ---------------- set e armazenamento ----------------
  function novoSet(id, nome, ms) { return { id, nome: nome || '', inicio_ms: ms, entradas: [], preparacao: [] }; }
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function criarArmazemMemoria() {
    const sets = new Map(), meta = new Map();
    return {
      async lerSet(id) { return sets.has(id) ? clone(sets.get(id)) : null; },
      async gravarSet(set) { sets.set(set.id, clone(set)); },
      async listarSets() { return [...sets.values()].map(clone).sort((a, b) => a.inicio_ms - b.inicio_ms); },
      async apagarSet(id) { sets.delete(id); },
      async lerMeta(chave) { return meta.has(chave) ? clone(meta.get(chave)) : null; },
      async gravarMeta(chave, valor) { meta.set(chave, clone(valor)); },
    };
  }

  // IndexedDB própria ("vbmx-historico"): loja `sets` (um registro por set) e `meta` (set atual).
  function criarArmazemIDB(idb, nomeDoBanco = 'vbmx-historico') {
    if (!idb) throw new Error('VbMxHistorico: sem indexedDB');
    const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error || new Error('indexedDB falhou')); });
    let aberto = null;
    function banco() {
      if (!aberto) {
        aberto = new Promise((ok, no) => {
          const r = idb.open(nomeDoBanco, 1);
          r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('sets', { keyPath: 'id' }); db.createObjectStore('meta', { keyPath: 'chave' }); };
          r.onsuccess = () => ok(r.result);
          r.onerror = () => no(r.error || new Error('indexedDB não abriu'));
        });
        aberto.catch(() => { aberto = null; });
      }
      return aberto;
    }
    async function loja(nome, modo) { return (await banco()).transaction(nome, modo).objectStore(nome); }
    return {
      async lerSet(id) { const r = await req((await loja('sets', 'readonly')).get(id)); return r || null; },
      async gravarSet(set) { await req((await loja('sets', 'readwrite')).put(clone(set))); },
      async listarSets() { const r = await req((await loja('sets', 'readonly')).getAll()); return (r || []).sort((a, b) => a.inicio_ms - b.inicio_ms); },
      async apagarSet(id) { await req((await loja('sets', 'readwrite')).delete(id)); },
      async lerMeta(chave) { const r = await req((await loja('meta', 'readonly')).get(chave)); return r ? r.valor : null; },
      async gravarMeta(chave, valor) { await req((await loja('meta', 'readwrite')).put({ chave, valor: clone(valor) })); },
    };
  }

  return { MINIMO_NO_AR, GANHO_MINIMO, ganhoDoCanal, noAr, criarSessao, taxaDeAceitacao, exportarTexto, fmtDuracao, fmtHora, fmtData,
    preparacaoAdicionar, preparacaoRemover, preparacaoMover, preparacaoMarcar, novoSet, criarArmazemMemoria, criarArmazemIDB };
});
