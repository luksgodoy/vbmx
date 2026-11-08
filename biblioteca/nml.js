// ===================== VbMxNml — importar o collection.nml (VB-27) =====================
// Lógica pura (UMD), sem DOM: roda no navegador e em Node. Formato em docs/formatos.md (§3 a §5, §8).
//   lerXml(texto)                      árvore { tag, attrs, filhos } (parser mínimo: só atributos, sem texto)
//   tomParaCamelot(n) / camelotParaTom(c)   MUSICAL_KEY 0–23 ↔ Camelot (formatos §5)
//   lerColecao(texto, opc?)            { versao, faixas[], playlists[], avisos[], baseSlots }
//   casar(entradas, faixas)            { pares, semPar, ambiguas }: regra de nome + tamanho + sufixo do caminho
//   importar(colecao, faixas, alvo, opc?)  casa, grava pelo `alvo` injetado e devolve o relatório
//   textoRelatorio(rel)                frase curta do relatório
// Faixa da coleção (saída de lerColecao):
//   { titulo, artista, volume, diretorio, arquivo, segmentos[], chave (VOLUME+DIR+FILE), tamanhoKiB|null, duracao (s)|null,
//     bpm|null, grade {bpm, primeira}|null, tom|null (0–23), camelot|null, rating|null (0–5), cor|null,
//     comentario|null, marcadores[{tipo, nome, t (s), fim|null, slot}], cuePrincipal (s)|null }
// `alvo` (tudo opcional; o que faltar não é gravado): lerGrade(faixa) → grade editada | null,
//   gravarGrade(faixa, grade), lerMarcadores(faixa) → { cue, hotcues[8] } | null, gravarMarcadores(faixa, reg),
//   gravarTom(faixa, camelot), gravarDuracao(faixa, segundos), gravarMeta(faixa, { rating, cor, comentario }), gravarPlaylists(playlists).
// A gravação de rating/cor/comentário/playlists é injetada porque mora em biblioteca/meta.js (VB-17b).
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxNml = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TIPOS = ['cue', 'fade-in', 'fade-out', 'load', 'grid', 'loop']; // TYPE 0–5 (formatos §4), nomes de VbMxCues
  const SLOTS = 8;
  const ehNum = v => typeof v === 'number' && Number.isFinite(v);
  const num = s => { if (s === undefined || s === null || s === '') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
  const modulo = (a, m) => ((a % m) + m) % m;
  const arred = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

  // ---- XML mínimo ---------------------------------------------------------------------------
  const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function desescapar(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
      if (e[0] === '#') { const c = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(c); } catch (_) { return m; } }
      return Object.prototype.hasOwnProperty.call(ENTIDADES, e) ? ENTIDADES[e] : m;
    });
  }

  // Varre o texto uma vez: <?...?>, <!--...-->, <!...>, <tag a="v" ...>, </tag>, <tag .../>. Texto entre tags é ignorado.
  function lerXml(texto) {
    const t = String(texto || '').replace(/^﻿/, '');
    const n = t.length;
    const raizFalsa = { tag: '#raiz', attrs: {}, filhos: [] };
    const pilha = [raizFalsa];
    let i = 0;
    while (i < n) {
      const j = t.indexOf('<', i);
      if (j < 0) break;
      if (t.startsWith('<!--', j)) { const f = t.indexOf('-->', j + 4); if (f < 0) throw new Error('comentário XML sem fim'); i = f + 3; continue; }
      if (t.startsWith('<![CDATA[', j)) { const f = t.indexOf(']]>', j + 9); if (f < 0) throw new Error('CDATA sem fim'); i = f + 3; continue; }
      if (t[j + 1] === '?') { const f = t.indexOf('?>', j + 2); if (f < 0) throw new Error('instrução XML sem fim'); i = f + 2; continue; }
      if (t[j + 1] === '!') { const f = t.indexOf('>', j + 2); if (f < 0) throw new Error('declaração XML sem fim'); i = f + 1; continue; }
      if (t[j + 1] === '/') {
        const f = t.indexOf('>', j + 2); if (f < 0) throw new Error('tag de fechamento sem fim');
        const nome = t.slice(j + 2, f).trim();
        const topo = pilha.pop();
        if (!topo || topo === raizFalsa || topo.tag !== nome) throw new Error(`XML malformado: </${nome}> fecha ${topo && topo !== raizFalsa ? '<' + topo.tag + '>' : 'nada'}`);
        i = f + 1; continue;
      }
      // tag de abertura: nome, atributos entre aspas (o valor pode conter ">"), "/" opcional
      let k = j + 1;
      while (k < n && !/[\s/>]/.test(t[k])) k++;
      const no = { tag: t.slice(j + 1, k), attrs: {}, filhos: [] };
      let fechou = false;
      for (;;) {
        while (k < n && /\s/.test(t[k])) k++;
        if (k >= n) throw new Error(`tag <${no.tag}> sem fim`);
        if (t[k] === '>') { k++; break; }
        if (t[k] === '/' && t[k + 1] === '>') { k += 2; fechou = true; break; }
        const ini = k;
        while (k < n && !/[\s=>/]/.test(t[k])) k++;
        const chave = t.slice(ini, k);
        while (k < n && /\s/.test(t[k])) k++;
        if (t[k] !== '=') throw new Error(`atributo "${chave}" sem valor em <${no.tag}>`);
        k++;
        while (k < n && /\s/.test(t[k])) k++;
        const aspa = t[k];
        if (aspa !== '"' && aspa !== "'") throw new Error(`valor de "${chave}" sem aspas em <${no.tag}>`);
        const f = t.indexOf(aspa, k + 1); if (f < 0) throw new Error(`valor de "${chave}" sem fim`);
        no.attrs[chave] = desescapar(t.slice(k + 1, f));
        k = f + 1;
      }
      pilha[pilha.length - 1].filhos.push(no);
      if (!fechou) pilha.push(no);
      i = k;
    }
    if (pilha.length !== 1) throw new Error(`XML malformado: <${pilha[pilha.length - 1].tag}> nunca fecha`);
    if (raizFalsa.filhos.length !== 1) throw new Error('XML sem elemento raiz único');
    return raizFalsa.filhos[0];
  }
  const filhos = (no, tag) => (no ? no.filhos.filter(f => f.tag === tag) : []);
  const filho = (no, tag) => filhos(no, tag)[0] || null;

  // ---- tom (formatos §5) ------------------------------------------------------------------------
  // 0–11 = maiores a partir de dó; 12–23 = menores a partir de dó. Quintas: +7 semitons = +1 casa.
  // Dó maior = 8B; lá menor (classe 9) = 8A.
  function tomParaCamelot(n) {
    if (!Number.isInteger(n) || n < 0 || n > 23) return null;
    const menor = n >= 12, classe = n % 12;
    const numero = menor ? modulo(4 + 7 * classe, 12) + 1 : modulo(7 + 7 * classe, 12) + 1;
    return `${numero}${menor ? 'A' : 'B'}`;
  }
  function camelotParaTom(c) {
    const m = /^\s*(\d{1,2})\s*([AaBb])\s*$/.exec(String(c || ''));
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
    const menor = m[2].toUpperCase() === 'A';
    const classe = modulo((Number(m[1]) - 1 - (menor ? 4 : 7)) * 7, 12); // 7·7 ≡ 1 (mod 12): 7 é o próprio inverso
    return classe + (menor ? 12 : 0);
  }

  // ---- localização (formatos §3) ------------------------------------------------------------------
  // DIR "/:Users/:fulano/:Musica/:" (ou "/:/:Users/:..." com volume raiz nomeado) → ['Users','fulano','Musica'].
  const segmentosDoDir = dir => String(dir || '').split('/:').filter(s => s !== '');
  const norm = s => String(s || '').normalize('NFC').toLowerCase();

  // ---- coleção ------------------------------------------------------------------------------------
  function lerMarcador(c) {
    const a = c.attrs, tipo = num(a.TYPE);
    if (tipo === null || tipo < 0 || tipo > 5) return null;
    const ini = num(a.START), len = num(a.LEN);
    if (ini === null || ini < 0) return null;
    return { tipo, nome: a.NAME && a.NAME !== 'n.n.' && a.NAME !== 'AutoGrid' ? a.NAME : '', ms: ini, lenMs: len && len > 0 ? len : 0, hotcue: num(a.HOTCUE) };
  }

  function lerEntrada(e) {
    const loc = filho(e, 'LOCATION');
    if (!loc || !loc.attrs.FILE) return null;
    const info = filho(e, 'INFO') || { attrs: {} }, tempo = filho(e, 'TEMPO'), chaveMus = filho(e, 'MUSICAL_KEY');
    const volume = loc.attrs.VOLUME || '', diretorio = loc.attrs.DIR || '', arquivo = loc.attrs.FILE;
    const bpm = tempo ? num(tempo.attrs.BPM) : null;
    const tomN = chaveMus ? num(chaveMus.attrs.VALUE) : null;
    const rk = num(info.attrs.RANKING);
    return {
      titulo: e.attrs.TITLE || '', artista: e.attrs.ARTIST || '',
      volume, diretorio, arquivo, segmentos: segmentosDoDir(diretorio).concat(arquivo), chave: volume + diretorio + arquivo,
      tamanhoKiB: num(info.attrs.FILESIZE),
      duracao: (d => d !== null && d > 0 ? d : null)(num(info.attrs.PLAYTIME_FLOAT) !== null ? num(info.attrs.PLAYTIME_FLOAT) : num(info.attrs.PLAYTIME)),
      bpm: bpm !== null && bpm > 0 ? bpm : null,
      tom: Number.isInteger(tomN) && tomN >= 0 && tomN <= 23 ? tomN : null,
      camelot: Number.isInteger(tomN) ? tomParaCamelot(tomN) : null,
      // RANKING é 0–255 (inferência, formatos §3): 51 por estrela; 0 = sem nota
      rating: rk !== null && rk > 0 ? Math.min(5, Math.round(rk / 51)) : null,
      cor: info.attrs.COLOR || null,
      comentario: info.attrs.COMMENT || null,
      _marcs: filhos(e, 'CUE_V2').map(lerMarcador).filter(Boolean),
    };
  }

  // Resolve os marcadores de todas as faixas: grade (tipo 4) e hotcues/cue principal.
  // Slots (lacuna 4): base 0 se algum marcador que não é grade tem HOTCUE 0; senão base 1 (o 0 do arquivo é
  // "sem slot", como na grade). HOTCUE negativo é sempre "sem slot". Sem slot: o 1º tipo 0 vira o cue principal;
  // os demais caem no primeiro slot livre.
  function resolverMarcadores(faixas, baseOpc) {
    const nao = [];
    for (const f of faixas) for (const m of f._marcs) if (m.tipo !== 4) nao.push(m);
    let base = baseOpc === 0 || baseOpc === 1 ? baseOpc : null;
    if (base === null) base = nao.some(m => m.hotcue === 0) ? 0 : 1;
    const avisos = [];
    for (const f of faixas) {
      const grades = f._marcs.filter(m => m.tipo === 4);
      f.grade = null;
      if (f.bpm && grades.length) {
        // O marcador de grade do .nml é a batida 1 do compasso: dobrar por COMPASSO (4 batidas), não por batida.
        // Dobrar por batida trocava o 1 por outra batida em 3 de cada 4 âncoras e o SYNC por compasso punha
        // bumbo na caixa (defeito de 2026-10-27; VB-64 (2)). BPM e âncora a 6 casas, como a análise.
        const compasso = 4 * 60 / f.bpm;
        f.grade = { bpm: arred(f.bpm, 6), primeira: arred(modulo(grades[0].ms / 1000, compasso), 6) };
        if (grades.length > 1) avisos.push(`${f.arquivo}: ${grades.length} marcadores de grade, usado o primeiro`);
      }
      const usados = new Array(SLOTS).fill(false);
      const marcadores = [], semSlot = [];
      for (const m of f._marcs.filter(x => x.tipo !== 4)) {
        const reg = { tipo: TIPOS[m.tipo], nome: m.nome, t: arred(m.ms / 1000, 4), fim: m.tipo === 5 && m.lenMs ? arred((m.ms + m.lenMs) / 1000, 4) : null, slot: null };
        const valor = m.hotcue === null ? -1 : m.hotcue - base;
        if (Number.isInteger(valor) && valor >= 0 && valor < SLOTS && !usados[valor]) { reg.slot = valor; usados[valor] = true; marcadores.push(reg); }
        else if (valor >= SLOTS) avisos.push(`${f.arquivo}: slot ${m.hotcue} fora dos ${SLOTS} do VbMx, marcador descartado`);
        else semSlot.push(reg);
      }
      f.cuePrincipal = null;
      for (const r of semSlot) {
        if (r.tipo === 'cue' && f.cuePrincipal === null) { f.cuePrincipal = r.t; continue; }
        const livre = usados.indexOf(false);
        if (livre < 0) { avisos.push(`${f.arquivo}: sem slot livre para o marcador em ${r.t}s`); continue; }
        r.slot = livre; usados[livre] = true; marcadores.push(r);
      }
      f.marcadores = marcadores.sort((a, b) => a.slot - b.slot);
      delete f._marcs;
    }
    return { base, avisos };
  }

  function lerPlaylists(raizNo) {
    const lista = [];
    function desce(no, pasta) {
      if (no.attrs.TYPE === 'PLAYLIST') {
        const pl = filho(no, 'PLAYLIST');
        if (!pl) return;
        const chaves = filhos(pl, 'ENTRY').map(e => { const pk = filho(e, 'PRIMARYKEY'); return pk && pk.attrs.KEY ? pk.attrs.KEY : null; }).filter(Boolean);
        lista.push({ nome: no.attrs.NAME || '', pasta, tipo: pl.attrs.TYPE || 'LIST', chaves });
        return;
      }
      const sub = filho(no, 'SUBNODES');
      const prox = pasta.concat(no.attrs.NAME || '');
      if (sub) for (const f of filhos(sub, 'NODE')) desce(f, prox);
    }
    const pls = filho(raizNo, 'PLAYLISTS');
    // o nó raiz (pasta) não entra no caminho de pasta das listas
    for (const n of filhos(pls, 'NODE')) {
      const sub = filho(n, 'SUBNODES');
      if (n.attrs.TYPE === 'FOLDER' && sub) for (const f of filhos(sub, 'NODE')) desce(f, []);
      else desce(n, []);
    }
    return lista;
  }

  function lerColecao(texto, opc) {
    const o = opc || {};
    const r = lerXml(texto);
    if (r.tag !== 'NML') throw new Error(`não é um .nml: raiz <${r.tag}>`);
    const faixas = filhos(filho(r, 'COLLECTION'), 'ENTRY').map(lerEntrada).filter(Boolean); // ENTRY sem LOCATION não é faixa
    const { base, avisos } = resolverMarcadores(faixas, o.baseSlots);
    return { versao: r.attrs.VERSION || '', faixas, playlists: lerPlaylists(r), avisos, baseSlots: base };
  }

  // ---- casamento com o que o VbMx já conhece ------------------------------------------------------------
  // Mesma ideia da chave de cache (caminho + tamanho): o nome do arquivo tem de bater (sem diferenciar caixa nem
  // acento composto/decomposto); se os dois lados sabem o tamanho, tem de bater (FILESIZE é em KiB: tolera 1 KiB);
  // vários candidatos → o de maior sufixo de pasta em comum; empate → ambígua, nada é gravado.
  function sufixoComum(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && norm(a[a.length - 1 - n]) === norm(b[b.length - 1 - n])) n++;
    return n;
  }
  const nomeDe = f => String(f.nome || String(f.caminho || '').split('/').pop());
  function casar(entradas, faixas) {
    const porNome = new Map();
    for (const f of faixas) { const k = norm(nomeDe(f)); if (!porNome.has(k)) porNome.set(k, []); porNome.get(k).push(f); }
    const pares = [], semPar = [], ambiguas = [], usadas = new Set();
    for (const e of entradas) {
      let cand = porNome.get(norm(e.arquivo)) || [];
      const comNome = cand.length;
      cand = cand.filter(f => !ehNum(f.tamanho) || f.tamanho < 0 || e.tamanhoKiB === null || Math.abs(f.tamanho / 1024 - e.tamanhoKiB) <= 1);
      if (!cand.length) { semPar.push({ entrada: e, motivo: comNome ? 'nome igual, tamanho diferente' : 'arquivo não está na biblioteca' }); continue; }
      if (cand.length > 1) {
        const pont = cand.map(f => sufixoComum(String(f.caminho || '').split('/'), e.segmentos));
        const melhor = Math.max(...pont);
        const topo = cand.filter((f, i) => pont[i] === melhor);
        if (topo.length > 1) { ambiguas.push({ entrada: e, candidatas: topo }); continue; }
        cand = topo;
      }
      const f = cand[0];
      if (usadas.has(f)) { ambiguas.push({ entrada: e, candidatas: [f], motivo: 'a faixa já casou com outra entrada' }); continue; }
      usadas.add(f);
      pares.push({ entrada: e, faixa: f });
    }
    return { pares, semPar, ambiguas };
  }

  // ---- importação -------------------------------------------------------------------------------------
  const iguaisT = (a, b) => Math.abs(a - b) <= 0.005;
  const gradeIgual = (a, b) => !!a && !!b && Math.abs(a.bpm - b.bpm) <= 0.005 && Math.abs(a.primeira - b.primeira) <= 0.005;
  const rotuloFaixa = f => f.caminho || nomeDe(f);

  async function importar(colecao, faixas, alvo, opc) {
    const a = alvo || {}, o = opc || {}, sob = !!o.sobrescrever;
    const { pares, semPar, ambiguas } = casar(colecao.faixas, faixas);
    const rel = {
      total: colecao.faixas.length, casadas: pares.length,
      semPar: semPar.map(s => ({ arquivo: s.entrada.arquivo, motivo: s.motivo })),
      ambiguas: ambiguas.map(x => ({ arquivo: x.entrada.arquivo, candidatas: x.candidatas.length, motivo: x.motivo || 'mais de uma faixa serve' })),
      conflitos: [], gravadas: { grade: 0, tom: 0, cues: 0, meta: 0 }, playlists: 0, avisos: colecao.avisos.slice(), baseSlots: colecao.baseSlots,
    };
    const conflito = (faixa, campo, atual, nml) => rel.conflitos.push({ faixa: rotuloFaixa(faixa), campo, atual, nml, sobrescrito: sob });
    const mapa = new Map(); // chave Traktor → faixa do VbMx (para as playlists)

    for (const { entrada: e, faixa: f } of pares) {
      mapa.set(e.chave, f);
      // grade (e o BPM que ela leva)
      if (e.grade && a.gravarGrade) {
        const atual = a.lerGrade ? await a.lerGrade(f) : null;
        if (!atual) { await a.gravarGrade(f, e.grade); rel.gravadas.grade += 1; }
        else if (!gradeIgual(atual, e.grade)) {
          if (sob) { await a.gravarGrade(f, e.grade); rel.gravadas.grade += 1; }
          conflito(f, 'grade', `${atual.bpm} BPM @ ${atual.primeira}s`, `${e.grade.bpm} BPM @ ${e.grade.primeira}s`);
        }
      }
      // duração (só preenche o que falta: a decodificada pelo VbMx vale mais que a do .nml)
      if (e.duracao && a.gravarDuracao && !(f.duracao > 0)) await a.gravarDuracao(f, e.duracao);
      // tom
      if (e.camelot && a.gravarTom) {
        if (!f.camelot) { await a.gravarTom(f, e.camelot); rel.gravadas.tom += 1; }
        else if (f.camelot !== e.camelot) {
          if (sob) { await a.gravarTom(f, e.camelot); rel.gravadas.tom += 1; }
          conflito(f, 'tom', f.camelot, e.camelot);
        }
      }
      // cues e hotcues
      if ((e.marcadores.length || e.cuePrincipal !== null) && a.gravarMarcadores) {
        const atual = (a.lerMarcadores ? await a.lerMarcadores(f) : null) || { cue: 0, hotcues: [] };
        const reg = { cue: atual.cue || 0, hotcues: Array.from({ length: SLOTS }, (_, i) => (atual.hotcues && atual.hotcues[i]) || null) };
        let mudou = false;
        for (const m of e.marcadores) {
          const novo = { t: m.t, tipo: m.tipo };
          if (m.nome) novo.nome = m.nome;
          if (m.fim !== null && m.fim > m.t) novo.fim = m.fim;
          const ex = reg.hotcues[m.slot];
          if (!ex) { reg.hotcues[m.slot] = novo; mudou = true; }
          else if (!iguaisT(ex.t, novo.t) || ex.tipo !== novo.tipo) {
            if (sob) { reg.hotcues[m.slot] = novo; mudou = true; }
            conflito(f, `hotcue ${m.slot + 1}`, `${ex.tipo} @ ${ex.t}s`, `${novo.tipo} @ ${novo.t}s`);
          }
        }
        if (e.cuePrincipal !== null) {
          if (!(reg.cue > 0)) { reg.cue = e.cuePrincipal; mudou = true; }
          else if (!iguaisT(reg.cue, e.cuePrincipal)) {
            const antes = reg.cue;
            if (sob) { reg.cue = e.cuePrincipal; mudou = true; }
            conflito(f, 'cue', `${antes}s`, `${e.cuePrincipal}s`);
          }
        }
        if (mudou) { await a.gravarMarcadores(f, reg); rel.gravadas.cues += 1; }
      }
      // rating, cor, comentário: gravação injetada (biblioteca/meta.js)
      if (a.gravarMeta && (e.rating !== null || e.cor || e.comentario)) {
        await a.gravarMeta(f, { rating: e.rating, cor: e.cor, comentario: e.comentario });
        rel.gravadas.meta += 1;
      }
    }

    // playlists: só as que têm ao menos uma faixa casada; "PROTOCOL" é histórico de sessão, não lista
    const listas = [];
    for (const p of colecao.playlists) {
      if (p.tipo === 'PROTOCOL') continue;
      const fx = p.chaves.map(k => mapa.get(k)).filter(Boolean);
      if (fx.length) listas.push({ nome: p.nome, pasta: p.pasta, faixas: fx, total: p.chaves.length });
    }
    if (listas.length && a.gravarPlaylists) { await a.gravarPlaylists(listas); rel.playlists = listas.length; }
    return rel;
  }

  function textoRelatorio(r) {
    const partes = [`${r.casadas} de ${r.total} faixas casadas`, `${r.semPar.length} sem par`];
    if (r.ambiguas.length) partes.push(`${r.ambiguas.length} ambígua(s)`);
    partes.push(`${r.conflitos.length} conflito(s)${r.conflitos.length ? ' (mantido o do VbMx, salvo "sobrescrever")' : ''}`);
    const g = r.gravadas;
    partes.push(`gravado: ${g.grade} grade(s), ${g.tom} tom(ns), ${g.cues} faixa(s) com cues${g.meta ? `, ${g.meta} com nota/cor/comentário` : ''}, ${r.playlists} playlist(s)`);
    return partes.join(' · ') + '.';
  }

  return { TIPOS, lerXml, tomParaCamelot, camelotParaTom, segmentosDoDir, lerColecao, casar, importar, textoRelatorio };
});
