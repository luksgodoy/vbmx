// ===================== gravador.js — gravador do set: slot gravador; VbMxCadeia.derivar("master") =====================
// Dono: VB-24. Grava a mixagem do master (a derivação "master" da cadeia, depois do volume e do limitador, com o
// metrônomo do VB-35 só se a preferência gravador.incluir-metronomo estiver ligada; VB-51) em WebM/Opus pelo MediaRecorder. Lógica pura em motor/gravacao.js (VbMxGravacao).
// No carregamento só declara; o DOM mexe em VbMxUI.aoIniciar. Nome de topo com prefixo `gravador`.
// Ao parar, o arquivo e a lista de faixas (.txt, do histórico do VB-18) ficam prontos: o botão usa
// showSaveFilePicker quando existe; sempre sobra um link (o download direto pode ser bloqueado).
// Contrato: docs/contratos.md.
VbMxUI.declararEvento("gravador:mudou");
VbMxPrefs.declarar("gravador.incluir-metronomo", false, { rotulo: "Gravador: incluir o metrônomo na gravação", tipo: "booleano", modulo: "gravador" });

const gravador = {
  estado: "parado",          // parado | gravando | pronto
  rec: null, dest: null, analisador: null, buffer: null, timer: null,
  pedacos: [], mime: null, iniMs: 0, fimMs: 0, t0: 0, ms: 0,
  derivacao: "master", arquivo: null, lista: null, urlArquivo: "", urlLista: "", aviso: "", pico: -Infinity,
};

function gravadorAgora(){ return (typeof performance !== "undefined" ? performance.now() : Date.now()); }
function gravadorSegundos(){ return gravador.estado === "gravando" ? (gravadorAgora() - gravador.t0) / 1000 : gravador.ms / 1000; }
function gravadorTamanhoBytes(){
  const real = gravador.pedacos.reduce((s, b) => s + b.size, 0);
  return real || VbMxGravacao.tamanhoEstimado(gravadorSegundos());
}
function gravadorSuportado(){ return typeof MediaRecorder !== "undefined" && typeof AudioContext !== "undefined"; }

function gravadorLiberarUrls(){
  for (const k of ["urlArquivo", "urlLista"]) { if (gravador[k]) { try { URL.revokeObjectURL(gravador[k]); } catch (_) { /* já solto */ } gravador[k] = ""; } }
}

function gravadorIniciar(){
  if (gravador.estado === "gravando") return;
  if (!gravadorSuportado()) { gravador.aviso = "este navegador não tem MediaRecorder"; gravadorDesenhar(); return; }
  const ctx = garantirAudio();
  if (!ctx) { gravador.aviso = "sem áudio neste navegador"; gravadorDesenhar(); return; }
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  const mime = VbMxGravacao.escolherMime(t => MediaRecorder.isTypeSupported(t));
  if (!mime) { gravador.aviso = "este navegador não grava WebM/Opus"; gravadorDesenhar(); return; }
  gravadorLiberarUrls();
  try {
    gravador.derivacao = VbMxGravacao.derivacaoDoMaster(VbMxPrefs.ler("gravador.incluir-metronomo"));   // fixa na hora de gravar
    const mestre = VbMxCadeia.derivar(gravador.derivacao);
    gravador.dest = ctx.createMediaStreamDestination();
    gravador.analisador = ctx.createAnalyser(); gravador.analisador.fftSize = 1024;
    gravador.buffer = new Float32Array(gravador.analisador.fftSize);
    mestre.connect(gravador.dest); mestre.connect(gravador.analisador);
    gravador.rec = new MediaRecorder(gravador.dest.stream, { mimeType: mime, audioBitsPerSecond: VbMxGravacao.BITRATE_BPS });
  } catch (e) { gravadorDesligarGrafo(); gravador.aviso = `não consegui começar: ${(e && e.message) || e}`; gravadorDesenhar(); return; }
  gravador.mime = mime; gravador.pedacos = []; gravador.arquivo = gravador.lista = null; gravador.aviso = ""; gravador.pico = -Infinity;
  gravador.rec.ondataavailable = ev => { if (ev.data && ev.data.size) gravador.pedacos.push(ev.data); };
  gravador.rec.onerror = ev => { gravador.aviso = `erro na gravação: ${(ev.error && ev.error.message) || "desconhecido"}`; gravadorParar(); };
  gravador.rec.onstop = gravadorFinalizar;
  gravador.iniMs = Date.now(); gravador.t0 = gravadorAgora(); gravador.estado = "gravando";
  gravador.rec.start(1000);   // pedaços de 1 s: o tamanho real aparece e uma queda perde pouco
  gravador.timer = setInterval(gravadorQuadro, 100);
  VbMxUI.emitir("gravador:mudou", { estado: "gravando" });
  gravadorDesenhar();
}
function gravadorParar(){
  if (gravador.estado !== "gravando") return;
  gravador.ms = gravadorAgora() - gravador.t0; gravador.fimMs = Date.now();
  try { gravador.rec.stop(); } catch (_) { gravadorFinalizar(); }
}
function gravadorDesligarGrafo(){
  if (gravador.timer) { clearInterval(gravador.timer); gravador.timer = null; }
  try {
    const mestre = VbMxCadeia.derivar(gravador.derivacao);
    if (gravador.dest) mestre.disconnect(gravador.dest);
    if (gravador.analisador) mestre.disconnect(gravador.analisador);
  } catch (_) { /* contexto já fechado */ }
  gravador.dest = gravador.analisador = null;
}
function gravadorFinalizar(){
  gravadorDesligarGrafo();
  const entradas = typeof historicoSessao !== "undefined" ? historicoSessao.entradas() : [];
  gravador.arquivo = new Blob(gravador.pedacos, { type: gravador.mime });
  gravador.lista = new Blob([VbMxGravacao.textoDaLista(entradas, gravador.iniMs, gravador.fimMs)], { type: "text/plain;charset=utf-8" });
  gravador.urlArquivo = URL.createObjectURL(gravador.arquivo); gravador.urlLista = URL.createObjectURL(gravador.lista);
  gravador.estado = "pronto";
  VbMxUI.emitir("gravador:mudou", { estado: "pronto" });
  gravadorDesenhar();
}
function gravadorQuadro(){
  if (gravador.analisador) {
    gravador.analisador.getFloatTimeDomainData(gravador.buffer);
    gravador.pico = VbMxGravacao.picoDb(gravador.buffer);
  }
  gravadorPintar();
}

// Salva por showSaveFilePicker (precisa de gesto: chamado direto do clique); sem ele, o link <a download> da tela.
async function gravadorSalvar(qual){
  const blob = qual === "lista" ? gravador.lista : gravador.arquivo;
  const nome = qual === "lista" ? VbMxGravacao.nomeLista(gravador.iniMs) : VbMxGravacao.nomeArquivo(gravador.iniMs, gravador.mime);
  if (!blob) return;
  if (typeof window.showSaveFilePicker !== "function") { gravador.aviso = "este navegador não abre o seletor de arquivo; use o link abaixo"; gravadorDesenhar(); return; }
  try {
    const tipo = qual === "lista" ? { description: "Texto", accept: { "text/plain": [".txt"] } }
      : { description: "Áudio WebM/Opus", accept: { [gravador.mime.split(";")[0]]: ["." + VbMxGravacao.extensaoDoMime(gravador.mime)] } };
    const alca = await window.showSaveFilePicker({ suggestedName: nome, types: [tipo] });
    const w = await alca.createWritable(); await w.write(blob); await w.close();
    gravador.aviso = `salvo: ${alca.name}`;
  } catch (e) {
    gravador.aviso = e && e.name === "AbortError" ? "" : `não consegui salvar (${(e && e.message) || e}); use o link abaixo`;
  }
  gravadorDesenhar();
}

// ---- tela ----
function gravadorPintar(){
  const slot = VbMxUI.slot("gravador"); if (!slot) return;
  const tempo = slot.querySelector("[data-grav-tempo]"), tam = slot.querySelector("[data-grav-tam]"), barra = slot.querySelector("[data-grav-nivel]");
  if (tempo) tempo.textContent = VbMxGravacao.fmtTempo(gravadorSegundos());
  if (tam) tam.textContent = (gravador.pedacos.length ? "" : "~") + VbMxGravacao.fmtTamanho(gravadorTamanhoBytes());
  if (barra) { barra.style.width = `${Math.round(VbMxGravacao.nivelParaBarra(gravador.pico) * 100)}%`; barra.classList.toggle("clipe", gravador.pico > -0.5); }
}
function gravadorDesenhar(){
  const slot = VbMxUI.slot("gravador"); if (!slot) return;
  const g = gravador;
  slot.hidden = false; slot.className = "hist grav"; slot.style.gridColumn = "1 / -1"; slot.style.order = "6";
  const links = g.estado === "pronto" ? `<div class="prep-barra">
      <button type="button" data-grav="salvar-arquivo">Salvar gravação</button>
      <button type="button" data-grav="salvar-lista">Salvar lista (.txt)</button>
    </div>
    <div class="prep-barra grav-links">
      <a href="${g.urlArquivo}" download="${VbMxGravacao.nomeArquivo(g.iniMs, g.mime)}">link: ${VbMxGravacao.nomeArquivo(g.iniMs, g.mime)}</a>
      <a href="${g.urlLista}" download="${VbMxGravacao.nomeLista(g.iniMs)}">link: ${VbMxGravacao.nomeLista(g.iniMs)}</a>
    </div>` : "";
  slot.innerHTML = `<div class="prep-cab hist-cab">
      <h3>Gravador</h3>
      <span class="hist-taxa">${g.estado === "gravando" ? "gravando a mixagem do master" : g.estado === "pronto" ? "pronta" : "parado"}</span>
    </div>
    <div class="prep-barra">
      <button type="button" data-grav="${g.estado === "gravando" ? "parar" : "gravar"}" class="${g.estado === "gravando" ? "tocando" : ""}" aria-pressed="${g.estado === "gravando"}">${g.estado === "gravando" ? "Parar" : "Gravar"}</button>
      <span class="mono" title="Tempo gravado" data-grav-tempo>0:00</span>
      <span class="mono hist-taxa" title="Tamanho do arquivo (com ~ é estimativa: ${VbMxGravacao.BITRATE_BPS / 1000} kbps)" data-grav-tam>~0 B</span>
      <span class="grav-medidor" title="Nível de pico do master" style="flex:1;min-width:80px;height:8px;background:var(--bg-3);border-radius:4px;overflow:hidden;align-self:center"><i data-grav-nivel style="display:block;height:100%;width:0;background:var(--acento)"></i></span>
    </div>
    ${g.aviso ? `<div class="prep-aviso" role="status">${esc(g.aviso)}</div>` : ""}
    ${links}
    <label class="prep-vazio"><input type="checkbox" data-grav-metro ${VbMxPrefs.ler("gravador.incluir-metronomo") ? "checked" : ""} ${g.estado === "gravando" ? "disabled" : ""}> Incluir o metrônomo na gravação</label>`;
  gravadorPintar();
}

VbMxUI.registrar("acao", "gravador.alternar", () => { if (gravador.estado === "gravando") gravadorParar(); else gravadorIniciar(); });

VbMxUI.aoIniciar(() => {
  const slot = VbMxUI.slot("gravador");
  if (slot) {
    slot.addEventListener("change", e => {
      if (!e.target.matches("[data-grav-metro]")) return;
      try { VbMxPrefs.gravar("gravador.incluir-metronomo", e.target.checked); } catch (_) { /* sem armazenamento: vale na sessão */ }
    });
    slot.addEventListener("click", e => {
      const b = e.target.closest("[data-grav]");
      if (!b) return;
      e.stopPropagation();
      const a = b.dataset.grav;
      if (a === "gravar") gravadorIniciar();
      else if (a === "parar") gravadorParar();
      else if (a === "salvar-arquivo") gravadorSalvar("arquivo");
      else if (a === "salvar-lista") gravadorSalvar("lista");
    });
  }
  gravadorDesenhar();
  window.addEventListener("pagehide", () => { if (gravador.estado === "gravando") gravadorParar(); });
});
