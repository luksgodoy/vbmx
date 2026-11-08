// ===================== VbMxMarcadores — cue e hot cues persistidos por faixa =====================
// Dono: VB-14 (onda 1). Persistência em IndexedDB próprio `vbmx-cues-v1` (decisão P4): nunca escreve
// no arquivo de áudio. Testado em Node por biblioteca/testar-marcadores.js, com armazém falso.
//   chave(caminho, tamanho, data)  → "caminho|tamanho|mtime" (a mesma ideia do cache de análise: se o
//                                    arquivo mudou, os marcadores antigos não valem mais)
//   armazemMemoria()               { get, put, apagar }  assíncrono, para teste e para quando não há IndexedDB
//   armazemIndexedDB(idb)          idem sobre o banco `vbmx-cues-v1`, store `cues`
//   criar(armazem)                 { ler(chave) → registro | null, gravar(chave, registro) → bool, apagar(chave) → bool }
//                                  Falha do armazém NUNCA propaga: vira null/false (a página segue sem lembrar).
// Registro = o estado de VbMxCues { cue, hotcues[8] }. Registro sem nada (cue 0 e 8 slots vazios) apaga a chave
// em vez de gravar lixo.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMarcadores = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const BANCO = 'vbmx-cues-v1', STORE = 'cues', SLOTS = 8;

  const chave = (caminho, tamanho, data) => `${caminho}|${tamanho}|${data}`;

  function armazemMemoria() {
    const m = new Map();
    return { tipo: 'memoria', async get(k) { return m.get(k); }, async put(k, v) { m.set(k, v); },
      async apagar(k) { m.delete(k); }, tamanho: () => m.size };
  }

  function armazemIndexedDB(idb) {
    let abrindo = null;
    const abrir = () => abrindo || (abrindo = new Promise((ok, falha) => {
      const req = idb.open(BANCO, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
      req.onblocked = () => falha(new Error('IndexedDB bloqueado'));
    }));
    const pedido = (modo, fn) => abrir().then(db => new Promise((ok, falha) => {
      const tx = db.transaction(STORE, modo), r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => ok(r.result); tx.onerror = () => falha(tx.error); tx.onabort = () => falha(tx.error);
    }));
    return { tipo: 'indexeddb', get: k => pedido('readonly', s => s.get(k)), put: (k, v) => pedido('readwrite', s => s.put(v, k)),
      apagar: k => pedido('readwrite', s => s.delete(k)) };
  }

  // Só o que vale ser guardado: cue finito ≥ 0 e 8 slots (objeto ou null). Quem valida a fundo é VbMxCues.normalizar.
  function limpo(reg) {
    if (!reg || typeof reg !== 'object' || !Array.isArray(reg.hotcues)) return null;
    const hotcues = [];
    for (let i = 0; i < SLOTS; i++) { const h = reg.hotcues[i]; hotcues.push(h && typeof h === 'object' ? h : null); }
    return { cue: typeof reg.cue === 'number' && isFinite(reg.cue) && reg.cue > 0 ? reg.cue : 0, hotcues };
  }
  const vazio = r => !(r.cue > 0) && r.hotcues.every(h => !h);

  function criar(armazem) {
    let ativo = !!armazem;
    return {
      get ativo() { return ativo; },
      async ler(k) {
        if (!ativo) return null;
        try { const v = await armazem.get(k); return limpo(v); } catch (_) { return null; }
      },
      async gravar(k, reg) {
        if (!ativo) return false;
        const r = limpo(reg); if (!r) return false;
        try {
          if (vazio(r)) await armazem.apagar(k); else await armazem.put(k, JSON.parse(JSON.stringify(r)));
          return true;
        } catch (_) { return false; }
      },
      async apagar(k) {
        if (!ativo) return false;
        try { await armazem.apagar(k); return true; } catch (_) { return false; }
      },
    };
  }

  // No navegador: o armazém real, ou memória se não houver IndexedDB (modo privado, arquivo local bloqueado).
  function doNavegador() {
    try { return criar(raiz.indexedDB ? armazemIndexedDB(raiz.indexedDB) : armazemMemoria()); }
    catch (_) { return criar(armazemMemoria()); }
  }

  return { BANCO, STORE, chave, armazemMemoria, armazemIndexedDB, criar, doNavegador };
});
