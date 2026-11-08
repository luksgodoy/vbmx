// ===================== historico.js — histórico do set: slot historico; emite ar:faixa =====================
// Dono: VB-18 (onda 1). A conta é de biblioteca/historico.js (VbMxHistorico, regra P10: 30 s no ar, com
// volume e crossfader abertos); aqui só se ligam os eventos do deck e do mixer, a IndexedDB e a tela.
// No carregamento só declara e registra; o DOM mexe em VbMxUI.aoIniciar. Contrato: docs/contratos.md.
//
// Eventos: emite `ar:faixa` {letra, faixa, desde} quando a faixa completa o tempo no ar, e
// `historico:mudou` {set, entradas, taxa} quando o set muda (carga, nova faixa, set novo).
// Ouve `preparacao:mudou` {lista} (de preparacao.js) para guardar a lista junto do set.
//
// "Veio da sugestão" (VB-18b): a faixa foi carregada a partir de um card do painel (clique no A/B ou arrasto);
// a marca é de sugestao.js (sugestaoConsumirOrigem). Escolher na biblioteca não conta, mesmo se for compatível.
VbMxUI.declararEvento("historico:mudou");

const HISTORICO_SALVAR_A_CADA = 5;     // s entre gravações enquanto a faixa soma tempo
let historicoSessao = null, historicoArmazem = null, historicoSet = null, historicoTimer = null;
let historicoSujo = false, historicoUltimaGravacao = 0, historicoRef = null, historicoAviso = "", historicoPronto = false;

function historicoAgora(){ return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000; }
function historicoEpocaMs(){ return Date.now() - historicoAgora() * 1000; }
function historicoChave(f){ return `${f.id}|${f.caminho || ""}`; }

function historicoCriarSessao(entradas){
  return VbMxHistorico.criarSessao({
    epocaMs: historicoEpocaMs(), entradas,
    aoEntrar: e => {
      historicoSujo = true;
      const viva = (typeof BIBLIOTECA !== "undefined" && BIBLIOTECA.find(f => historicoChave(f) === historicoChave(e.faixa))) || e.faixa;
      VbMxUI.emitir("ar:faixa", { letra: e.deck, faixa: viva, desde: e.inicio_ms });
      historicoAvisarMudou();
    },
    aoAtualizar: () => { historicoSujo = true; },
  });
}
historicoSessao = historicoCriarSessao([]);

function historicoAvisarMudou(){
  if (!historicoSet) return;
  historicoSet.entradas = historicoSessao.entradas();
  VbMxUI.emitir("historico:mudou", { set: historicoSet, entradas: historicoSet.entradas, taxa: VbMxHistorico.taxaDeAceitacao(historicoSet.entradas) });
  historicoDesenhar();
}
function historicoGravar(){
  if (!historicoSet || !historicoArmazem) return;
  historicoSet.entradas = historicoSessao.entradas();
  historicoSujo = false; historicoUltimaGravacao = historicoAgora();
  historicoArmazem.gravarSet(historicoSet).catch(e => { historicoAviso = `não consegui gravar o histórico: ${(e && e.message) || e}`; historicoDesenhar(); });
}

// ---- liga os eventos do deck e do mixer à sessão ----
function historicoMixerAtual(){ return typeof mixer !== "undefined" ? mixer : null; }
VbMxUI.ouvir("selecao:mudou", d => { historicoRef = d.faixa; });
VbMxUI.ouvir("deck:carregado", d => {
  historicoSessao.carregou(d.letra, d.faixa, historicoAgora(), { veioDaSugestao: typeof sugestaoConsumirOrigem === "function" && sugestaoConsumirOrigem(d.faixa) });
  const mx = historicoMixerAtual(); if (mx) historicoSessao.mixer(mx, historicoAgora());
});
VbMxUI.ouvir("deck:descarregado", d => historicoSessao.descarregou(d.letra, historicoAgora()));
VbMxUI.ouvir("deck:tocou", d => historicoSessao.tocou(d.letra, historicoAgora()));
VbMxUI.ouvir("deck:pausou", d => historicoSessao.pausou(d.letra, historicoAgora()));
VbMxUI.ouvir("deck:fim", d => historicoSessao.fim(d.letra, historicoAgora()));
VbMxUI.ouvir("mixer:mudou", d => { if (d.mixer) historicoSessao.mixer(d.mixer, historicoAgora()); });
VbMxUI.ouvir("preparacao:mudou", d => { if (historicoSet) { historicoSet.preparacao = d.lista; historicoSujo = true; historicoGravar(); } });

// ---- set: abre o último (ou cria) e persiste ----
function historicoNovoId(){ return "set-" + Date.now().toString(36); }
async function historicoAbrir(){
  try { historicoArmazem = VbMxHistorico.criarArmazemIDB(typeof indexedDB !== "undefined" ? indexedDB : null); await historicoArmazem.listarSets(); }
  catch (e) { historicoArmazem = VbMxHistorico.criarArmazemMemoria(); historicoAviso = "sem IndexedDB neste navegador: o histórico vale só até fechar a aba"; }
  let set = null;
  try { const id = await historicoArmazem.lerMeta("atual"); set = id ? await historicoArmazem.lerSet(id) : null; } catch (_) { set = null; }
  if (!set) set = VbMxHistorico.novoSet(historicoNovoId(), "", Date.now());
  const jaTinha = historicoSessao.entradas();
  historicoSet = set;
  if (!jaTinha.length) historicoSessao.recarregar(set.entradas); else set.entradas = [...set.entradas, ...jaTinha];
  historicoPronto = true;
  try { await historicoArmazem.gravarMeta("atual", set.id); } catch (_) { /* a próxima gravação tenta de novo */ }
  historicoGravar();
  historicoAvisarMudou();
}
function historicoNovoSet(){
  historicoGravar();
  const set = VbMxHistorico.novoSet(historicoNovoId(), "", Date.now());
  set.preparacao = (historicoSet && historicoSet.preparacao || []).slice();   // a lista do próximo set parte da atual
  historicoSet = set;
  historicoSessao.recarregar([]);
  if (historicoArmazem) historicoArmazem.gravarMeta("atual", set.id).catch(() => {});
  historicoGravar();
  historicoAviso = "set novo aberto; o anterior continua guardado no navegador";
  historicoAvisarMudou();
}

// ---- texto exportado ----
function historicoTexto(){ return VbMxHistorico.exportarTexto(historicoSet || { entradas: [] }); }
function historicoBaixar(){
  const blob = new Blob([historicoTexto()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  const d = new Date(historicoSet ? historicoSet.inicio_ms : Date.now()), p = n => String(n).padStart(2, "0");
  a.href = url; a.download = `historico-set-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  historicoAviso = `texto baixado (${a.download})`; historicoDesenhar();
}
async function historicoCopiar(){
  try { await navigator.clipboard.writeText(historicoTexto()); historicoAviso = "texto copiado"; }
  catch (_) { historicoAviso = "o navegador não deixou copiar; use Baixar .txt"; }
  historicoDesenhar();
}

// ---- tela ----
function historicoDesenhar(){
  const slot = VbMxUI.slot("historico");
  if (!slot) return;
  const entradas = historicoSessao.entradas();
  const r = VbMxHistorico.taxaDeAceitacao(entradas);
  const taxa = r.total ? `${r.aceitas} de ${r.total} · ${Math.round(r.taxa * 100)}%` : "sem faixa ainda";
  const vivas = ["A", "B"].map(l => ({ l, e: historicoSessao.estado(l) })).filter(x => x.e && x.e.faixa && x.e.tocando && !x.e.registrada && x.e.acumulado > 0)
    .map(x => `<span class="hist-conta mono">deck ${x.l}: ${Math.floor(x.e.acumulado)}/${VbMxHistorico.MINIMO_NO_AR} s no ar</span>`).join("");
  const linhas = entradas.slice().reverse().map(e => `<li class="hist-item">
      <span class="hist-hora mono">${VbMxHistorico.fmtHora(e.inicio_ms)}</span>
      <span class="hist-nome"><b>${esc(e.faixa.titulo)}</b><span>${esc(e.faixa.artista)}</span></span>
      <span class="hist-meta mono">deck ${e.deck} · ${VbMxHistorico.fmtDuracao(e.segundos)}</span>
      <span class="hist-origem ${e.veio_da_sugestao ? "sugerida" : ""}" title="${e.veio_da_sugestao ? "carregada a partir do painel de sugestão" : "não veio do painel de sugestão"}">${e.veio_da_sugestao ? "sugestão" : "livre"}</span>
    </li>`).join("");
  slot.hidden = false;
  slot.className = "hist";
  slot.innerHTML = `<div class="prep-cab hist-cab">
      <h3>Histórico do set</h3>
      <span class="hist-taxa" title="Aceitação = faixas que vieram da sugestão ÷ faixas que tocaram (30 s ou mais no ar). É o X do VB-04.">aceitação <b class="mono">${taxa}</b></span>
    </div>
    <div class="prep-barra">
      <button type="button" data-hist="copiar">Copiar texto</button>
      <button type="button" data-hist="baixar">Baixar .txt</button>
      <button type="button" data-hist="novo" title="Fecha este set (fica guardado) e começa outro">Novo set</button>
    </div>
    ${vivas ? `<div class="hist-vivas">${vivas}</div>` : ""}
    ${historicoAviso ? `<div class="prep-aviso" role="status">${esc(historicoAviso)}</div>` : ""}
    ${entradas.length ? `<ol class="hist-lista">${linhas}</ol>` : `<div class="prep-vazio">Nada tocou ainda. Uma faixa entra aqui quando soma ${VbMxHistorico.MINIMO_NO_AR} s no ar (deck tocando, volume e crossfader abertos).</div>`}`;
}

VbMxUI.aoIniciar(() => {
  const slot = VbMxUI.slot("historico");
  historicoRef = typeof atual !== "undefined" ? atual : null;
  if (slot) {
    slot.addEventListener("click", e => {
      const b = e.target.closest("[data-hist]");
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.hist === "copiar") historicoCopiar();
      else if (b.dataset.hist === "baixar") historicoBaixar();
      else if (b.dataset.hist === "novo") historicoNovoSet();
    });
  }
  historicoDesenhar();
  historicoAbrir().catch(e => { historicoAviso = `histórico indisponível: ${(e && e.message) || e}`; historicoDesenhar(); });
  historicoTimer = setInterval(() => {
    historicoSessao.avancar(historicoAgora());
    const algumContando = ["A", "B"].some(l => { const s = historicoSessao.estado(l); return s && s.tocando && !s.registrada; });
    if (historicoSujo || algumContando) historicoDesenhar();
    if (historicoSujo && historicoPronto && historicoAgora() - historicoUltimaGravacao >= HISTORICO_SALVAR_A_CADA) historicoGravar();
  }, 1000);
  window.addEventListener("pagehide", () => { if (historicoPronto) historicoGravar(); });
});
