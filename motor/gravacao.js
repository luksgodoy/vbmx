// ===================== gravacao.js — lógica pura do gravador (VB-24) =====================
// Nomes de arquivo, tempos, tamanho estimado, nível e a lista de faixas com o tempo em que entraram na
// gravação. Sem DOM nem áudio: a tela e o MediaRecorder ficam em interface/js/gravador.js.
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxGravacao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BITRATE_BPS = 128000;   // Opus pedido ao MediaRecorder; só a estimativa de tamanho depende dele
  const MIME_PREFERIDOS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const dois = n => String(n).padStart(2, '0');
  const num = v => typeof v === 'number' && isFinite(v);

  // Primeiro tipo que o navegador diz suportar (ehSuportado = MediaRecorder.isTypeSupported); null se nenhum.
  function escolherMime(ehSuportado) {
    if (typeof ehSuportado !== 'function') return null;
    return MIME_PREFERIDOS.find(m => { try { return !!ehSuportado(m); } catch (_) { return false; } }) || null;
  }
  // Derivação da cadeia que o gravador grava: com o metrônomo (VB-51) ou a mixagem sem o clique.
  function derivacaoDoMaster(incluirMetronomo) { return incluirMetronomo === true ? 'master' : 'master-sem-clique'; }
  function extensaoDoMime(mime) { return /ogg/.test(mime || '') ? 'ogg' : 'webm'; }
  // gravacao-2026-10-26-21h05 (hora local do `ms`)
  function nomeBase(ms) {
    const d = new Date(ms);
    return `gravacao-${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}-${dois(d.getHours())}h${dois(d.getMinutes())}`;
  }
  function nomeArquivo(ms, mime) { return `${nomeBase(ms)}.${extensaoDoMime(mime)}`; }
  function nomeLista(ms) { return `${nomeBase(ms)}.txt`; }

  // 75 -> "1:15"; 3725 -> "1:02:05"
  function fmtTempo(s) {
    const t = Math.max(0, Math.floor(num(s) ? s : 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), seg = t % 60;
    return h ? `${h}:${dois(m)}:${dois(seg)}` : `${m}:${dois(seg)}`;
  }
  function tamanhoEstimado(segundos, bps = BITRATE_BPS) { return Math.max(0, Math.round((num(segundos) ? segundos : 0) * bps / 8)); }
  function fmtTamanho(bytes) {
    const b = Math.max(0, num(bytes) ? bytes : 0);
    if (b < 1024) return `${Math.round(b)} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1048576).toFixed(1).replace('.', ',')} MB`;
  }
  // Pico (dBFS) de um bloco de amostras no domínio do tempo (Float32Array do AnalyserNode); -Infinity se mudo.
  function picoDb(amostras) {
    let p = 0;
    for (let i = 0; i < (amostras ? amostras.length : 0); i++) { const a = Math.abs(amostras[i]); if (a > p) p = a; }
    return p > 0 ? 20 * Math.log10(p) : -Infinity;
  }
  // dBFS -> 0..1 para a barra (piso -60 dB)
  function nivelParaBarra(db, piso = -60) {
    if (!num(db)) return 0;
    return Math.min(1, Math.max(0, (db - piso) / -piso));
  }
  // Entradas do histórico (VbMxHistorico: inicio_ms em época, segundos, deck, faixa) que se sobrepõem à gravação
  // [iniMs, fimMs]. `inicio` é o tempo da faixa dentro do arquivo (0 se já estava no ar ao apertar gravar).
  function faixasDaGravacao(entradas, iniMs, fimMs) {
    const out = [];
    for (const e of entradas || []) {
      if (!e || !num(e.inicio_ms)) continue;
      const fim = e.inicio_ms + (num(e.segundos) ? e.segundos : 0) * 1000;
      if (fim < iniMs || e.inicio_ms > fimMs) continue;
      out.push({ inicio: Math.max(0, (e.inicio_ms - iniMs) / 1000), deck: e.deck, faixa: e.faixa || {}, segundos: num(e.segundos) ? e.segundos : 0 });
    }
    return out.sort((a, b) => a.inicio - b.inicio);
  }
  function textoDaLista(entradas, iniMs, fimMs) {
    const dur = Math.max(0, (fimMs - iniMs) / 1000);
    const d = new Date(iniMs);
    const linhas = [`Gravação de ${dois(d.getDate())}/${dois(d.getMonth() + 1)}/${d.getFullYear()} ${dois(d.getHours())}:${dois(d.getMinutes())} — duração ${fmtTempo(dur)}`, ''];
    const lista = faixasDaGravacao(entradas, iniMs, fimMs);
    lista.forEach((x, i) => {
      const f = x.faixa;
      linhas.push(`${dois(i + 1)}  ${fmtTempo(x.inicio)}  deck ${x.deck}  ${f.artista ? f.artista + ' — ' : ''}${f.titulo || '(sem título)'}`);
    });
    if (!lista.length) linhas.push('(nenhuma faixa registrada no histórico durante a gravação)');
    return linhas.join('\n') + '\n';
  }

  return { BITRATE_BPS, MIME_PREFERIDOS, escolherMime, derivacaoDoMaster, extensaoDoMime, nomeArquivo, nomeLista, fmtTempo, tamanhoEstimado, fmtTamanho, picoDb, nivelParaBarra, faixasDaGravacao, textoDaLista };
});
