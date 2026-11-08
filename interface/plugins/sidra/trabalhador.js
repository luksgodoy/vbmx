// Web Worker (module): baixa o modelo (com cache), cria a sessao do onnxruntime-web e separa
// janela a janela, sem travar a pagina. Fala com app.js por postMessage.

import * as dsp from "./dsp.js";

const ORT_VERSAO = "1.30.0";
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSAO}/dist/`;
const CACHE = "separador-stems-modelo";

let ort = null;
let sessao = null;
let backend = null;
let stems = null;        // [[esq, dir] x 4] Float32Array, depois da separacao
let pedido = null;       // backend pedido na sessao atual

const enviar = (m, t) => postMessage(m, t || []);
const progresso = (etapa, feito, total, texto) => enviar({ tipo: "progresso", etapa, feito, total, texto });

async function carregarOrt() {
  if (ort) return;
  ort = await import(`${ORT_URL}ort.webgpu.min.mjs`);
  ort.env.wasm.wasmPaths = ORT_URL;
  // threads so com isolamento entre origens (COOP/COEP); sem ele o WASM roda em 1 thread
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
}

async function sha256hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function abrirCache() {
  try { return await caches.open(CACHE); } catch { return null; }   // modo privado etc.: segue sem cache
}

/** Baixa os pedacos do manifesto (ou le do Cache API), confere sha256 e devolve o .onnx inteiro. */
async function baixarModelo(base) {
  const man = await (await fetch(new URL("manifesto.json", base), { cache: "no-cache" })).json();
  const cache = await abrirCache();
  const chaves = new Set();
  const total = man.bytes;
  const modelo = new Uint8Array(total);
  let feito = 0;
  for (const p of man.partes) {
    const url = new URL(p.arquivo, base).href;
    const chave = `${url}?sha256=${p.sha256}`;
    chaves.add(chave);
    let buf = null;
    if (cache) {
      const r = await cache.match(chave);
      if (r) {
        buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength !== p.bytes || (await sha256hex(buf)) !== p.sha256) { buf = null; await cache.delete(chave); }
      }
    }
    if (!buf) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`falha ao baixar ${p.arquivo}: HTTP ${r.status}`);
      buf = new Uint8Array(p.bytes);
      const leitor = r.body.getReader();
      let o = 0;
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        if (o + value.byteLength > p.bytes) throw new Error(`${p.arquivo} maior que o esperado`);
        buf.set(value, o); o += value.byteLength;
        progresso("modelo", feito + o, total, "Baixando o modelo (so na primeira vez)");
      }
      if (o !== p.bytes || (await sha256hex(buf)) !== p.sha256) throw new Error(`${p.arquivo} chegou corrompido (sha256 diferente)`);
      if (cache) { try { await cache.put(chave, new Response(buf)); } catch { /* sem espaco: segue sem cache */ } }
    }
    modelo.set(buf, feito);
    feito += p.bytes;
    progresso("modelo", feito, total, "Carregando o modelo");
  }
  if (cache) {   // apaga pedacos de versoes antigas do modelo
    for (const req of await cache.keys()) if (!chaves.has(req.url)) await cache.delete(req);
  }
  return modelo;
}

async function temWebGPU() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

async function prepararSessao(base, querBackend) {
  if (sessao && pedido === querBackend) return;
  await carregarOrt();
  const bytes = await baixarModelo(base);
  progresso("sessao", 0, 1, "Preparando o modelo no navegador");
  const tentativas = [];
  if (querBackend !== "wasm" && (await temWebGPU())) tentativas.push("webgpu");
  if (querBackend !== "webgpu") tentativas.push("wasm");
  if (!tentativas.length) throw new Error("WebGPU indisponivel neste navegador; escolha WASM.");
  let ultimoErro = null;
  for (const ep of tentativas) {
    try {
      if (sessao) { try { await sessao.release(); } catch {} sessao = null; }
      sessao = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: "all" });
      backend = ep;
      pedido = querBackend;
      return;
    } catch (e) {
      ultimoErro = e;
      enviar({ tipo: "aviso", texto: `Backend ${ep} falhou (${String(e.message || e).slice(0, 160)}); tentando o proximo.` });
    }
  }
  throw new Error(`nao foi possivel criar a sessao: ${ultimoErro && (ultimoErro.message || ultimoErro)}`);
}

async function separar({ esq, dir, base, backend: querBackend, overlap }) {
  stems = null;
  await prepararSessao(base, querBackend);
  const L = dsp.SEGMENTO, T = Math.ceil(L / dsp.HOP), FQ = dsp.NFFT / 2;
  const rodar = async (mix, cac) => {
    const r = await sessao.run({
      mix: new ort.Tensor("float32", mix, [1, 2, L]),
      cac: new ort.Tensor("float32", cac, [1, 4, FQ, T]),
    });
    const out = { xfreq: r.xfreq.data, xtempo: r.xtempo.data };
    return out;
  };
  const t0 = performance.now();
  const total = dsp.planoJanelas(esq.length, L, overlap).length;
  progresso("separar", 0, total, `Separando (${backend.toUpperCase()})`);
  stems = await dsp.separar(esq, dir, rodar, {
    overlap,
    progresso: (k, n) => progresso("separar", k, n, `Separando (${backend.toUpperCase()})`),
  });
  const pico = dsp.reescalar(stems);
  enviar({ tipo: "separado", backend, segundos: (performance.now() - t0) / 1000, pico, amostras: esq.length,
           threads: backend === "wasm" ? ort.env.wasm.numThreads : null });
}

function wavs(bits) {
  if (!stems) throw new Error("nada separado ainda");
  const lista = dsp.FONTES.map((nome, s) => ({ nome, wav: dsp.codificarWav(stems[s][0], stems[s][1], dsp.TAXA, bits) }));
  enviar({ tipo: "wavs", bits, lista }, lista.map((x) => x.wav));
}

/** So para o teste automatizado: devolve os stems em float32 (copia). */
function brutos() {
  const lista = dsp.FONTES.map((nome, s) => ({ nome, esq: stems[s][0].slice(), dir: stems[s][1].slice() }));
  enviar({ tipo: "brutos", lista }, lista.flatMap((x) => [x.esq.buffer, x.dir.buffer]));
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.tipo === "separar") await separar(m);
    else if (m.tipo === "wavs") wavs(m.bits);
    else if (m.tipo === "brutos") brutos();
  } catch (e) {
    enviar({ tipo: "erro", texto: String((e && e.message) || e) });
  }
};
