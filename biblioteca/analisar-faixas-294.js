// Gera faixas-294/catalogo.json: BPM, tom (Camelot) e grade das 5 faixas da 294 Records, pela análise REAL do projeto
// (Essentia.js no worker do painel) no Chrome headless. Roda UMA vez, aqui; o visitante do site publicado não analisa nada.
// Rode: node biblioteca/analisar-faixas-294.js     (precisa de Chrome e de internet para o CDN do Essentia; os MP3 ficam
// em faixas-294/, fora do git; o catalogo.json é versionado). Mesmo esqueleto de biblioteca/chrome-bpm.js.
'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const RAIZ = path.resolve(__dirname, '..'), PASTA = path.join(RAIZ, 'faixas-294');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// arquivo -> título e artista curados (as tags ID3 dos MP3 são as mesmas)
const FAIXAS = [
  ['chemars-papaya.mp3', 'Papaya', 'Chemars'],
  ['corduroy-mavericks-break-from-the-norm.mp3', 'Break From The Norm (Dublime Version)', 'Corduroy Mavericks'],
  ['get-it-on.mp3', 'Get It On', '294 Records'],
  ['dj-daniel-d-what-is-house.mp3', 'What Is House (Paul et Luc Remix)', 'DJ Daniel D'],
  ['joey-chicago-i-love-u-and-need-u.mp3', 'I Love U And Need U', 'Joey Chicago'],
];
const PAGINA = `<!doctype html><meta charset="utf-8"><title>analisar</title><div id="p"></div>
<script src="../analise/camelot.js"></script>
<script src="../biblioteca/bpm.js"></script>
<script src="../biblioteca/biblioteca.js"></script>
<script src="../biblioteca/painel.js"></script>
<script>
window.__rodar = (lista) => new Promise((ok) => {
  VbMxPainel.iniciar({ montarEm: document.getElementById('p'), aoMudar: (fx) => ok(fx.map(f => ({ nome: f.caminho, bpm: f.bpm, camelot: f.camelot, duracao: f.duracao, grade: f.grade || null, erro: f.erro || null }))) })
    .adicionar({ nome: '294', itens: lista.map((n, i) => ({ caminho: '294/' + n, nome: n, tamanho: i + 1, data: Date.now(),
      obter: async () => new File([await (await fetch('/__faixas/' + n)).arrayBuffer()], n, { type: 'audio/mpeg' }) })) });
});
</script>`;
const tipos = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const manda = (cod, tipo, corpo) => { res.writeHead(cod, { 'Content-Type': tipo, 'Cache-Control': 'no-store' }); res.end(corpo); };
  if (u === '/interface/__analisar.html') return manda(200, 'text/html', PAGINA);
  if (u.startsWith('/__faixas/')) { const a = path.join(PASTA, path.basename(u)); return fs.existsSync(a) ? manda(200, 'audio/mpeg', fs.readFileSync(a)) : manda(404, 'text/plain', 'não'); }
  const arq = path.join(RAIZ, path.normalize(u));
  if (!arq.startsWith(RAIZ + path.sep) || /\.(mp3|wav|aiff?|nml)$/i.test(arq) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) return manda(404, 'text/plain', 'não');
  manda(200, tipos[path.extname(arq)] || 'application/octet-stream', fs.readFileSync(arq));
});
async function esperarArquivo(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (fs.existsSync(arq)) { const t = fs.readFileSync(arq, 'utf8'); if (t.includes('\n')) return t; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('o Chrome não abriu a porta de depuração');
}
function cdp(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.falha(new Error(JSON.stringify(m.error))) : p.ok(m.result); } };
  const pronto = new Promise((ok, falha) => { ws.onopen = ok; ws.onerror = falha; });
  const enviar = (method, params, sessionId) => new Promise((ok, falha) => { const id = ++seq; pend.set(id, { ok, falha }); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
  return { pronto, enviar, fechar: () => ws.close() };
}

async function esperarArquivo(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (fs.existsSync(arq)) { const t = fs.readFileSync(arq, 'utf8'); if (t.includes('\n')) return t; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('o Chrome não abriu a porta de depuração');
}


(async () => {
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const porta = srv.address().port;
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let c = null;
  try {
    const [p, caminho] = (await esperarArquivo(path.join(perfil, 'DevToolsActivePort'), 20000)).trim().split('\n');
    c = cdp(`ws://127.0.0.1:${p}${caminho}`); await c.pronto;
    const { targetId } = await c.enviar('Target.createTarget', { url: `http://127.0.0.1:${porta}/interface/__analisar.html` });
    const { sessionId } = await c.enviar('Target.attachToTarget', { targetId, flatten: true });
    const avaliar = async (expr) => {
      const r = await c.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    for (let i = 0; i < 100 && !(await avaliar('typeof window.__rodar === "function"')); i++) await new Promise(r => setTimeout(r, 100));
    const res = await avaliar(`__rodar(${JSON.stringify(FAIXAS.map(f => f[0]))})`);
    const faixas = FAIXAS.map(([arquivo, titulo, artista], i) => {
      const r = res[i];
      if (!r || r.erro || !r.bpm) throw new Error(`análise falhou em ${arquivo}: ${r && r.erro}`);
      const f = { id: i + 1, arquivo, titulo, artista, bpm: Math.round(r.bpm * 100) / 100, camelot: r.camelot, duracao: Math.round(r.duracao * 100) / 100,
        tamanho: fs.statSync(path.join(PASTA, arquivo)).size };
      if (r.grade) f.grade = { bpm: Math.round(r.grade.bpm * 1e4) / 1e4, primeira: Math.round(r.grade.primeira * 1e3) / 1e3 };
      return f;
    });
    fs.writeFileSync(path.join(PASTA, 'catalogo.json'), JSON.stringify({ pasta: '294 Records', gerado: new Date().toISOString().slice(0, 10), faixas }, null, 1) + '\n');
    for (const f of faixas) console.log([f.titulo, f.bpm, f.camelot, f.duracao + ' s', f.grade ? 'grade ' + f.grade.bpm : 'sem grade'].join(' | '));
  } finally { try { c && c.fechar(); } catch (_) {} chrome.kill(); srv.close(); setTimeout(() => { try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (_) {} }, 500); }
})().catch((e) => { console.error('falhou:', e.message); process.exit(1); });
