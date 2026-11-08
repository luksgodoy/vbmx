// Plugin Sidra: o separador de stems do Sidra (htdemucs em ONNX, WebGPU com queda para WASM) dentro do VbMx.
// Roda no navegador, num Web Worker (trabalhador.js + dsp.js, copiados de ~/separador-stems-web), sem servidor e sem upload.
// Contrato: VbMxSidra.disponivel() → Promise<bool> · VbMxSidra.separar(arquivo, onProgresso) → Promise<{vocals,drums,bass,instrumental}>
// (AudioBuffers a 44,1 kHz; instrumental = drums + bass + other). onProgresso({etapa:'modelo'|'sessao'|'separar', fracao}).
// Só os pesos do htdemucs (MIT) entram aqui; BS-Roformer e DrumSep (uso pessoal) não podem.
(function (raiz) {
  'use strict';
  const TAXA = 44100;
  const BASE = new URL('modelo/', document.currentScript ? document.currentScript.src : location.href).href;
  let trab = null, ocupado = Promise.resolve();

  function base() { const p = new URLSearchParams(location.search).get('modelo'); return p ? (p.endsWith('/') ? p : p + '/') : BASE; }

  async function disponivel() {
    try { return typeof Worker !== 'undefined' && (await fetch(new URL('manifesto.json', base()), { method: 'HEAD' })).ok; }
    catch (_) { return false; }
  }

  function worker() {
    if (!trab) trab = new Worker(new URL('trabalhador.js', document.currentScript ? document.currentScript.src : location.href), { type: 'module' });
    return trab;
  }

  async function decodificar(arq) {
    const ctx = new OfflineAudioContext(2, 1, TAXA);          // decodeAudioData reamostra para 44,1 kHz
    const b = await ctx.decodeAudioData(await arq.arrayBuffer());
    const esq = new Float32Array(b.getChannelData(0));
    return { esq, dir: b.numberOfChannels > 1 ? new Float32Array(b.getChannelData(1)) : esq.slice() };
  }

  function rodar(esq, dir, onProgresso) {
    const w = worker();
    return new Promise((ok, erro) => {
      const brutos = (m) => {
        if (m.tipo === 'progresso') { onProgresso && onProgresso({ etapa: m.etapa, fracao: m.total ? m.feito / m.total : 0 }); return; }
        if (m.tipo === 'erro') { w.onmessage = null; erro(new Error(m.texto)); return; }
        if (m.tipo === 'separado') { w.postMessage({ tipo: 'brutos' }); return; }
        if (m.tipo === 'brutos') { w.onmessage = null; ok(m.lista); }
      };
      w.onmessage = (ev) => brutos(ev.data);
      w.postMessage({ tipo: 'separar', esq, dir, base: base(), backend: 'auto', overlap: 0.25 }, [esq.buffer, dir.buffer]);
    });
  }

  function aBuffer(ctx, e, d) {
    const b = ctx.createBuffer(2, e.length, TAXA); b.copyToChannel(e, 0); b.copyToChannel(d, 1); return b;
  }

  // Um job por vez (o modelo ocupa a GPU inteira): chamadas seguintes esperam a anterior.
  function separar(arquivo, onProgresso) {
    const job = ocupado.then(async () => {
      const { esq, dir } = await decodificar(arquivo);
      const lista = await rodar(esq, dir, onProgresso);
      const por = {}; lista.forEach((x) => { por[x.nome] = x; });
      const ctx = new OfflineAudioContext(2, 1, TAXA);
      const soma = (c) => { const o = new Float32Array(por.drums[c].length); for (const n of ['drums', 'bass', 'other']) { const s = por[n][c]; for (let i = 0; i < o.length; i++) o[i] += s[i]; } return o; };
      return {
        vocals: aBuffer(ctx, por.vocals.esq, por.vocals.dir), drums: aBuffer(ctx, por.drums.esq, por.drums.dir),
        bass: aBuffer(ctx, por.bass.esq, por.bass.dir), instrumental: aBuffer(ctx, soma('esq'), soma('dir')),
      };
    });
    ocupado = job.catch(() => {});
    return job;
  }

  raiz.VbMxSidra = { TAXA, disponivel, separar };
})(typeof window !== 'undefined' ? window : globalThis);
