// ===================== VbMxMeta — avaliação, cor, comentário, playlists e smartlists =====================
// Dono: VB-17b (onda 3). Persistência em IndexedDB próprio `vbmx-meta-v1` (nunca no arquivo de áudio). UMD;
// testado em Node por biblioteca/testar-meta.js com IndexedDB falso. Falha do armazém NUNCA propaga: vira null/false.
//
// CHAVE DA FAIXA (a mesma para tudo): chaveDe(faixa) → faixa.caminho (texto, sem normalizar) ou "id:N" se não houver
//   caminho. É de propósito só o caminho (sem tamanho/mtime como em marcadores.js): nota e cor sobrevivem a retag.
//   Quem importa de outro lugar (VB-27) passa a chave que quiser, desde que seja a mesma de chaveDe(faixa).
//
// META DA FAIXA = { chave, avaliacao 0..5, cor (nome em CORES ou null), comentario (texto), importadaEm (ms ou null) }
//   criar(armazem, { agora })    → instância (agora: () => ms, injetável no teste)
//   p.ler(chave)                 → meta (com padrões; nunca null se o armazém estiver ativo)
//   p.lerTodos()                 → Map chave → meta (só as que têm registro)
//   p.definir(chave, parcial)    → meta | null. parcial: { avaliacao, cor, comentario, importadaEm } (valida e limita:
//                                  avaliacao inteira 0..5; cor fora de CORES vira null; comentario vira texto)
//   p.definirLote(itens)         → itens: [{ chave, ...parcial }]; grava tudo (para importação em massa). → nº gravado
//   p.garantirImportada(chaves)  → grava importadaEm = agora nas chaves que ainda não têm (data de importação)
//   p.avaliar / p.pintar / p.comentar (chave, valor)  → atalhos de definir
// LISTAS (playlist = faixas na mão; inteligente = regras):
//   p.listas()                   → [lista] na ordem de criação
//   p.criarLista(nome)           → lista | null     { id, tipo:'playlist', nome, chaves:[] }
//   p.criarInteligente(nome, regras, combinar)  → lista | null   { id, tipo:'inteligente', nome, regras, combinar }
//   p.renomear(id, nome) / p.apagar(id) → bool;  p.definirRegras(id, regras, combinar) → lista | null
//   p.adicionar(id, chaves, posicao?) → nº adicionado (sem duplicata; posicao opcional; só playlist)
//   p.remover(id, chave) / p.mover(id, de, para) → bool (reordenar por índice)
// PURAS (exportadas):
//   mesclar(faixa, meta)         → cópia da faixa com avaliacao/cor/comentario/importada (ms) para colunas e regras
//   regraValida(r), avaliarRegras(faixaMesclada, regras, combinar), resolver(lista, faixasMescladas)
//   Regra = { campo, op, valor }: bpm (=, >=, <=, entre [a,b]), camelot (e, uma-de [..], compativel),
//   genero/artista/titulo/comentario (contem, e), avaliacao (=, >=, <=), cor (e, nenhuma), data (depois, antes: ms/ISO).
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMeta = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const BANCO = 'vbmx-meta-v1', S_FAIXAS = 'faixas', S_LISTAS = 'listas';
  const CORES = ['vermelho', 'laranja', 'amarelo', 'verde', 'ciano', 'azul', 'roxo', 'rosa'];
  const CAMPOS = { bpm: ['=', '>=', '<=', 'entre'], camelot: ['e', 'uma-de', 'compativel'], genero: ['contem', 'e'], artista: ['contem', 'e'],
    titulo: ['contem', 'e'], comentario: ['contem', 'e'], avaliacao: ['=', '>=', '<='], cor: ['e', 'nenhuma'], data: ['depois', 'antes'] };

  const chaveDe = (f) => (f && typeof f.caminho === 'string' && f.caminho) ? f.caminho : 'id:' + (f ? f.id : '');
  const norm = (s) => (s === null || s === undefined) ? '' : String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const metaPadrao = (chave) => ({ chave, avaliacao: 0, cor: null, comentario: '', importadaEm: null });

  function limparMeta(chave, bruto) {
    const m = metaPadrao(chave), b = bruto || {};
    const a = Math.round(Number(b.avaliacao));
    m.avaliacao = Number.isFinite(a) ? Math.max(0, Math.min(5, a)) : 0;
    m.cor = CORES.includes(b.cor) ? b.cor : null;
    m.comentario = b.comentario === null || b.comentario === undefined ? '' : String(b.comentario).slice(0, 2000);
    m.importadaEm = b.importadaEm !== null && b.importadaEm !== undefined && b.importadaEm !== '' && Number.isFinite(Number(b.importadaEm)) ? Number(b.importadaEm) : null;
    return m;
  }

  // ---------------------------------------------------------------- puras
  function mesclar(faixa, meta) {
    const m = meta || {};
    return Object.assign({}, faixa, { avaliacao: m.avaliacao || 0, cor: m.cor || null, comentario: m.comentario || '', importada: m.importadaEm === undefined ? null : m.importadaEm });
  }

  function tempo(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  function numero(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

  function regraValida(r) {
    if (!r || typeof r !== 'object' || !CAMPOS[r.campo] || !CAMPOS[r.campo].includes(r.op)) return false;
    if (r.campo === 'bpm' && r.op === 'entre') return Array.isArray(r.valor) && r.valor.length === 2 && r.valor.every(v => numero(v) !== null);
    if (r.campo === 'bpm' || r.campo === 'avaliacao') return numero(r.valor) !== null;
    if (r.campo === 'data') return tempo(r.valor) !== null;
    if (r.op === 'uma-de') return Array.isArray(r.valor) && r.valor.length > 0;
    if (r.op === 'nenhuma') return true;
    if (r.campo === 'cor') return CORES.includes(r.valor);
    return typeof r.valor === 'string' && r.valor.trim() !== '';
  }

  // Casas compatíveis na roda de Camelot: a mesma, ±1 no número, e a paralela (A↔B).
  function casasCompativeis(c) {
    const m = /^(\d{1,2})([AB])$/i.exec(String(c || '').trim());
    if (!m) return [];
    const n = Number(m[1]), l = m[2].toUpperCase(), outra = l === 'A' ? 'B' : 'A';
    const volta = (x) => ((x - 1 + 12) % 12) + 1;
    return [n + l, volta(n + 1) + l, volta(n - 1) + l, n + outra];
  }

  function casaRegra(f, r) {
    switch (r.campo) {
      case 'bpm': {
        const v = numero(f.bpm); if (v === null) return false;
        if (r.op === 'entre') { const a = Math.min(numero(r.valor[0]), numero(r.valor[1])), b = Math.max(numero(r.valor[0]), numero(r.valor[1])); return v >= a && v <= b; }
        const x = numero(r.valor);
        return r.op === '=' ? Math.abs(v - x) < 0.5 : r.op === '>=' ? v >= x : v <= x;
      }
      case 'camelot': {
        const c = norm(f.camelot).toUpperCase(); if (!c) return false;
        if (r.op === 'e') return c === norm(r.valor).toUpperCase();
        if (r.op === 'uma-de') return r.valor.some(x => norm(x).toUpperCase() === c);
        return casasCompativeis(norm(r.valor).toUpperCase()).includes(c);
      }
      case 'avaliacao': {
        const v = f.avaliacao || 0, x = numero(r.valor);
        return r.op === '=' ? v === x : r.op === '>=' ? v >= x : v <= x;
      }
      case 'cor': return r.op === 'nenhuma' ? !f.cor : f.cor === r.valor;
      case 'data': {
        const v = tempo(f.importada); if (v === null) return false;
        return r.op === 'depois' ? v >= tempo(r.valor) : v <= tempo(r.valor);
      }
      default: {
        const v = norm(f[r.campo]); if (!v) return false;
        return r.op === 'e' ? v === norm(r.valor) : v.includes(norm(r.valor));
      }
    }
  }

  // regras vazias (ou todas inválidas) casam tudo — uma lista inteligente nova mostra a coleção inteira.
  function avaliarRegras(faixa, regras, combinar) {
    const rs = (regras || []).filter(regraValida);
    if (!rs.length) return true;
    return combinar === 'qualquer' ? rs.some(r => casaRegra(faixa, r)) : rs.every(r => casaRegra(faixa, r));
  }

  // faixasMescladas = tudo da coleção já mesclado com a meta. Playlist: na ordem da lista (sumida fica de fora).
  function resolver(lista, faixasMescladas) {
    if (!lista) return [];
    if (lista.tipo === 'inteligente') return faixasMescladas.filter(f => avaliarRegras(f, lista.regras, lista.combinar));
    const porChave = new Map(faixasMescladas.map(f => [chaveDe(f), f]));
    return (lista.chaves || []).map(k => porChave.get(k)).filter(Boolean);
  }

  // ---------------------------------------------------------------- armazéns
  function armazemMemoria() {
    const lojas = { [S_FAIXAS]: new Map(), [S_LISTAS]: new Map() };
    return { tipo: 'memoria', async get(s, k) { return lojas[s].get(k); }, async put(s, v) { lojas[s].set(s === S_FAIXAS ? v.chave : v.id, JSON.parse(JSON.stringify(v))); },
      async apagar(s, k) { lojas[s].delete(k); }, async todos(s) { return [...lojas[s].values()].map(v => JSON.parse(JSON.stringify(v))); } };
  }

  function armazemIndexedDB(idb) {
    let abrindo = null;
    const abrir = () => abrindo || (abrindo = new Promise((ok, falha) => {
      const req = idb.open(BANCO, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(S_FAIXAS, { keyPath: 'chave' }); req.result.createObjectStore(S_LISTAS, { keyPath: 'id' }); };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
      req.onblocked = () => falha(new Error('IndexedDB bloqueado'));
    }));
    const pedido = (s, modo, fn) => abrir().then(db => new Promise((ok, falha) => {
      const tx = db.transaction(s, modo), r = fn(tx.objectStore(s));
      tx.oncomplete = () => ok(r.result); tx.onerror = () => falha(tx.error); tx.onabort = () => falha(tx.error);
    }));
    return { tipo: 'indexeddb', get: (s, k) => pedido(s, 'readonly', st => st.get(k)), put: (s, v) => pedido(s, 'readwrite', st => st.put(v)),
      apagar: (s, k) => pedido(s, 'readwrite', st => st.delete(k)), todos: (s) => pedido(s, 'readonly', st => st.getAll()) };
  }

  // ---------------------------------------------------------------- instância
  function criar(armazem, opcoes) {
    const agora = (opcoes && opcoes.agora) || (() => Date.now());
    const ativo = !!armazem;
    let fila = Promise.resolve();                                  // serializa leitura-modificação-gravação
    const serial = (fn) => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };
    const seguro = (valorFalha, fn) => serial(async () => { if (!ativo) return valorFalha; try { return await fn(); } catch (_) { return valorFalha; } });

    async function lerMeta(chave) { const v = await armazem.get(S_FAIXAS, chave); return v ? limparMeta(chave, v) : metaPadrao(chave); }
    function normalizarLista(v) {
      const base = { id: String(v.id), tipo: v.tipo === 'inteligente' ? 'inteligente' : 'playlist', nome: String(v.nome || ''), criada: Number(v.criada) || 0, seq: Number(v.seq) || 0 };
      if (base.tipo === 'inteligente') return Object.assign(base, { regras: (v.regras || []).filter(regraValida), combinar: v.combinar === 'qualquer' ? 'qualquer' : 'todas' });
      return Object.assign(base, { chaves: Array.isArray(v.chaves) ? v.chaves.filter(k => typeof k === 'string') : [] });
    }
    async function lerLista(id) { const v = await armazem.get(S_LISTAS, id); return v ? normalizarLista(v) : null; }
    const nomeLimpo = (n) => { const t = String(n === null || n === undefined ? '' : n).trim().slice(0, 120); return t || null; };
    async function proximoSeq() { const todas = await armazem.todos(S_LISTAS); return todas.reduce((m, l) => Math.max(m, Number(l.seq) || 0), 0) + 1; }
    async function nova(extra, nome) {
      const n = nomeLimpo(nome); if (!n) return null;
      const seq = await proximoSeq(), l = normalizarLista(Object.assign({ id: 'L' + seq, nome: n, criada: agora(), seq }, extra));
      await armazem.put(S_LISTAS, l);
      return l;
    }

    return {
      get ativo() { return ativo; },
      ler: (chave) => seguro(null, () => lerMeta(chave)),
      lerTodos: () => seguro(new Map(), async () => new Map((await armazem.todos(S_FAIXAS)).map(v => [v.chave, limparMeta(v.chave, v)]))),
      definir: (chave, parcial) => seguro(null, async () => {
        if (typeof chave !== 'string' || !chave) return null;
        const m = limparMeta(chave, Object.assign({}, await lerMeta(chave), parcial || {}));
        await armazem.put(S_FAIXAS, m);
        return m;
      }),
      definirLote: (itens) => seguro(0, async () => {
        let n = 0;
        for (const it of itens || []) {
          if (!it || typeof it.chave !== 'string' || !it.chave) continue;
          const { chave, ...p } = it;
          await armazem.put(S_FAIXAS, limparMeta(chave, Object.assign({}, await lerMeta(chave), p))); n++;
        }
        return n;
      }),
      garantirImportada: (chaves) => seguro(0, async () => {
        let n = 0; const t = agora();
        for (const k of chaves || []) {
          if (typeof k !== 'string' || !k) continue;
          const m = await lerMeta(k);
          if (m.importadaEm === null) { m.importadaEm = t; await armazem.put(S_FAIXAS, m); n++; }
        }
        return n;
      }),
      avaliar(chave, n) { return this.definir(chave, { avaliacao: n }); },
      pintar(chave, cor) { return this.definir(chave, { cor }); },
      comentar(chave, texto) { return this.definir(chave, { comentario: texto }); },

      listas: () => seguro([], async () => (await armazem.todos(S_LISTAS)).map(normalizarLista).sort((a, b) => a.seq - b.seq)),
      lista: (id) => seguro(null, () => lerLista(id)),
      criarLista: (nome) => seguro(null, () => nova({ tipo: 'playlist', chaves: [] }, nome)),
      criarInteligente: (nome, regras, combinar) => seguro(null, () => nova({ tipo: 'inteligente', regras: regras || [], combinar }, nome)),
      renomear: (id, nome) => seguro(false, async () => {
        const l = await lerLista(id), n = nomeLimpo(nome); if (!l || !n) return false;
        l.nome = n; await armazem.put(S_LISTAS, l); return true;
      }),
      apagar: (id) => seguro(false, async () => { if (!(await lerLista(id))) return false; await armazem.apagar(S_LISTAS, id); return true; }),
      definirRegras: (id, regras, combinar) => seguro(null, async () => {
        const l = await lerLista(id); if (!l || l.tipo !== 'inteligente') return null;
        l.regras = (regras || []).filter(regraValida); l.combinar = combinar === 'qualquer' ? 'qualquer' : 'todas';
        await armazem.put(S_LISTAS, l); return l;
      }),
      adicionar: (id, chaves, posicao) => seguro(0, async () => {
        const l = await lerLista(id); if (!l || l.tipo !== 'playlist') return 0;
        const novas = [];
        for (const k of chaves || []) if (typeof k === 'string' && k && !l.chaves.includes(k) && !novas.includes(k)) novas.push(k);
        if (!novas.length) return 0;
        const i = Number.isInteger(posicao) ? Math.max(0, Math.min(l.chaves.length, posicao)) : l.chaves.length;
        l.chaves.splice(i, 0, ...novas);
        await armazem.put(S_LISTAS, l); return novas.length;
      }),
      remover: (id, chave) => seguro(false, async () => {
        const l = await lerLista(id); if (!l || l.tipo !== 'playlist') return false;
        const i = l.chaves.indexOf(chave); if (i < 0) return false;
        l.chaves.splice(i, 1); await armazem.put(S_LISTAS, l); return true;
      }),
      mover: (id, de, para) => seguro(false, async () => {
        const l = await lerLista(id); if (!l || l.tipo !== 'playlist') return false;
        const ok = (i) => Number.isInteger(i) && i >= 0 && i < l.chaves.length;
        if (!ok(de) || !ok(para)) return false;
        if (de !== para) { const [k] = l.chaves.splice(de, 1); l.chaves.splice(para, 0, k); await armazem.put(S_LISTAS, l); }
        return true;
      }),
    };
  }

  function doNavegador() {
    try { return criar(raiz.indexedDB ? armazemIndexedDB(raiz.indexedDB) : armazemMemoria()); }
    catch (_) { return criar(armazemMemoria()); }
  }

  return { BANCO, CORES, CAMPOS, chaveDe, metaPadrao, limparMeta, mesclar, regraValida, casasCompativeis, avaliarRegras, resolver,
    armazemMemoria, armazemIndexedDB, criar, doNavegador };
});
