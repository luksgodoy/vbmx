// VbMx — consulta ao songbpm.com pelo NOME da faixa (artista + título), via um Worker configurável.
// Só sai título/artista limpos: nunca caminho de arquivo. Sem URL do Worker a consulta é desligada
// (devolve null sem tocar na rede) e o painel segue só com o motor próprio. Falha, timeout ou "não achou"
// também devolvem null — silenciosos; quem chama cai no motor próprio.
// Navegador (global `VbMxSongbpm`), Worker e Node. Teste: node biblioteca/testar-songbpm.js
// Resposta esperada do Worker: { achou: true, bpm: 128, tonica: 'C#', modo: 'minor' | null } ou { achou: false }.
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxSongbpm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TIMEOUT_PADRAO_MS = 4000;
  const cache = new Map(); // por faixa (artista|título normalizados): guarda a Promise, então consultas repetidas não repetem a rede

  // tira marcas de download/ruído, nunca devolve barra de caminho
  const limpar = (s) => String(s == null ? '' : s)
    .replace(/[\\/]/g, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*\((?:official|oficial|lyric|audio|video|vídeo|hd|hq)[^)]*\)\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 150);
  const chave = (t, a) => (limpar(a) + '|' + limpar(t)).toLowerCase();

  const MODOS = { major: 'major', maior: 'major', minor: 'minor', menor: 'minor' };
  const NOTA = /^[A-Ga-g][#♯b♭]?$/;

  // Valida a resposta do Worker; qualquer coisa fora do formato = null.
  function interpretar(r) {
    if (!r || r.achou === false) return null;
    const bpm = Number(r.bpm);
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 250) return null;
    const t = String(r.tonica || '').trim();
    if (!NOTA.test(t)) return null;
    const modo = MODOS[String(r.modo || '').trim().toLowerCase()] || null;
    return { bpm: Math.round(bpm * 10) / 10, tom: { tonica: t[0].toUpperCase() + t.slice(1), modo }, fonte: 'songbpm' };
  }

  // consultar(titulo, artista, { url, fetchImpl, timeoutMs }) -> { bpm, tom:{tonica,modo|null}, fonte:'songbpm' } | null
  async function consultar(titulo, artista, opcoes) {
    const o = opcoes || {};
    if (!o.url) return null; // desligado
    const t = limpar(titulo), a = limpar(artista);
    if (!t) return null;
    const k = chave(t, a);
    if (cache.has(k)) return cache.get(k);
    const f = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return null;
    const ms = o.timeoutMs > 0 ? o.timeoutMs : TIMEOUT_PADRAO_MS;
    const p = (async () => {
      let timer;
      try {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const alvo = o.url + (o.url.indexOf('?') >= 0 ? '&' : '?') + 'titulo=' + encodeURIComponent(t) + (a ? '&artista=' + encodeURIComponent(a) : '') + '&q=' + encodeURIComponent((a ? a + ' ' : '') + t);
        const req = Promise.resolve(f(alvo, ctl ? { signal: ctl.signal } : undefined)).then(async (resp) => {
          if (!resp || resp.ok === false) return null;
          return interpretar(await resp.json());
        });
        const limite = new Promise((ok) => { timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (_) {} ok(null); }, ms); });
        return await Promise.race([req, limite]);
      } catch (_) { return null; } finally { clearTimeout(timer); }
    })();
    cache.set(k, p);
    const r = await p;
    if (r === null) cache.delete(k); // falha não fica em cache: a próxima tentativa pode dar certo
    return r;
  }

  const limparCache = () => cache.clear();
  return { TIMEOUT_PADRAO_MS, limpar, interpretar, consultar, limparCache };
});
