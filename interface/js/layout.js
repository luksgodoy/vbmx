// ===================== layout.js — faixa do pitch por deck, layouts da tela e painel de preferências (VB-26) =====================
// Dono: VB-26. No carregamento só declara e registra; o DOM nasce em VbMxUI.aoIniciar. Nome de topo com o prefixo
// `layout`. Contrato: docs/contratos.md.
//
//   Faixa do pitch por deck (spec §1 + decisão do Lucas, 2026-10-26): ±8, ±15 ou ±50, padrão ±15, uma preferência
//     por deck (pitch.faixa-a / pitch.faixa-b). A faixa vive em VbMxPitch (definirFaixa/faixaDe); SYNC, fader e
//     taxa leem de lá. Trocar para uma faixa menor trava o pitch do deck no novo limite (e solta o SYNC se mexeu).
//   Layouts: mostrar/ocultar FX, tempo mestre, biblioteca e o avançado do mixer. Predefinidos (completo,
//     performance, compacto) e "personalizado" (os quatro interruptores do painel, guardados em layout.pers-*).
//   Painel de preferências: botão "Preferências" no topo; o painel LÊ VbMxPrefs.declaradas() (nada hardcoded por
//     preferência), agrupa por módulo, e exporta/importa tudo em JSON.

const LAYOUT_PAINEIS = [
  { id: "fx", rotulo: "FX" },
  { id: "mestre", rotulo: "Tempo mestre" },
  { id: "biblioteca", rotulo: "Biblioteca" },
  { id: "avancado", rotulo: "Avançado do mixer" },
];
const LAYOUT_PREDEFINIDOS = {
  completo:    { rotulo: "Completo",    paineis: { fx: true,  mestre: true,  biblioteca: true,  avancado: false } },
  performance: { rotulo: "Performance", paineis: { fx: true,  mestre: true,  biblioteca: false, avancado: true } },
  compacto:    { rotulo: "Compacto",    paineis: { fx: false, mestre: false, biblioteca: true,  avancado: false } },
};
const LAYOUT_TITULOS = { mixer: "Mixer", mestre: "Tempo mestre", onda: "Onda", avisos: "Avisos e carga", sync: "SYNC", pitch: "Faixa do pitch" };
const LAYOUT_OPCOES_PITCH = [{ valor: 8, rotulo: "±8%" }, { valor: 15, rotulo: "±15%" }, { valor: 50, rotulo: "±50%" }];

VbMxPrefs.declarar("pitch.faixa-a", 15, { tipo: "opcao", modulo: "pitch", rotulo: "Faixa do pitch do deck A", opcoes: LAYOUT_OPCOES_PITCH });
VbMxPrefs.declarar("pitch.faixa-b", 15, { tipo: "opcao", modulo: "pitch", rotulo: "Faixa do pitch do deck B", opcoes: LAYOUT_OPCOES_PITCH });
VbMxPrefs.declarar("layout.atual", "completo", { tipo: "opcao", modulo: "layout", rotulo: "Layout da tela",
  opcoes: [...Object.entries(LAYOUT_PREDEFINIDOS).map(([valor, l]) => ({ valor, rotulo: l.rotulo })), { valor: "personalizado", rotulo: "Personalizado" }] });
for (const p of LAYOUT_PAINEIS) {
  VbMxPrefs.declarar(`layout.pers-${p.id}`, LAYOUT_PREDEFINIDOS.completo.paineis[p.id], { tipo: "booleano", modulo: "layout",
    rotulo: `Layout personalizado: mostrar ${p.rotulo}` });
}

// ---- Lógica pura (testada em Node: interface/testar-layout.js) ----
// Quais painéis aparecem num layout. Nome desconhecido cai no completo; `personalizado` vem dos interruptores.
function layoutPaineis(nome, personalizado) {
  if (nome === "personalizado") {
    const r = {};
    for (const p of LAYOUT_PAINEIS) r[p.id] = !!(personalizado && personalizado[p.id]);
    return r;
  }
  return { ...(LAYOUT_PREDEFINIDOS[nome] || LAYOUT_PREDEFINIDOS.completo).paineis };
}
// O novo limite não pode deixar o pitch do deck para fora. Devolve { pitch, mudou }.
function layoutTravarPitch(pitch, faixa) {
  const novo = VbMxPitch.limitarPitch(pitch, faixa);
  return { pitch: novo, mudou: novo !== pitch };
}

function layoutPersonalizadoAtual() {
  const r = {};
  for (const p of LAYOUT_PAINEIS) r[p.id] = VbMxPrefs.ler(`layout.pers-${p.id}`);
  return r;
}
function layoutPaineisAtuais() { return layoutPaineis(VbMxPrefs.ler("layout.atual"), layoutPersonalizadoAtual()); }

// ---- Faixa do pitch: da preferência para o VbMxPitch (sem DOM; vale já no carregamento) ----
for (const l of ["A", "B"]) VbMxPitch.definirFaixa(l, VbMxPrefs.ler(`pitch.faixa-${l.toLowerCase()}`));
for (const l of ["A", "B"]) {
  VbMxPrefs.ouvir(`pitch.faixa-${l.toLowerCase()}`, faixa => {
    VbMxPitch.definirFaixa(l, faixa);
    if (typeof decks === "undefined" || !decks[l]) return;
    const r = layoutTravarPitch(decks[l].pitch, faixa);
    if (r.mudou) { decks[l].pitch = r.pitch; decks[l].sync = false; decks[l].aviso = ""; decks[l].avisoCls = ""; }
    if (typeof aplicarTaxa === "function" && decks[l].faixa) aplicarTaxa(l);
    if (typeof renderTudo === "function" && typeof document !== "undefined" && document.querySelector("[data-deck]")) renderTudo();
  });
}

// ---- Layout: classes no <body> escondem os painéis; "avançado" é a preferência do próprio mixer ----
function layoutAplicar() {
  const vis = layoutPaineisAtuais();
  for (const p of LAYOUT_PAINEIS) document.body.classList.toggle(`layout-sem-${p.id}`, !vis[p.id]);
  try { if (VbMxPrefs.ler("mixer.avancado") !== vis.avancado) VbMxPrefs.gravar("mixer.avancado", vis.avancado); } catch (_) { /* mixer sem a preferência */ }
}
const layoutPronto = () => typeof document !== "undefined" && !!document.body && !!layoutPainel;
for (const p of LAYOUT_PAINEIS) VbMxPrefs.ouvir(`layout.pers-${p.id}`, () => { if (layoutPronto()) layoutAplicar(); });
VbMxPrefs.ouvir("layout.atual", () => { if (layoutPronto()) { layoutAplicar(); layoutRedesenhar(); } });

// ---- Painel de preferências ----
let layoutPainel = null;
function layoutEsc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function layoutRotuloOpcao(o) { return typeof o === "object" ? (o.rotulo ?? o.valor) : o; }
function layoutValorOpcao(o) { return typeof o === "object" ? o.valor : o; }

function layoutControle(d) {
  const id = `pref-${d.chave.replace(/\./g, "-")}`, c = layoutEsc(d.chave);
  if (d.tipo === "booleano") return `<label class="lay-linha" for="${id}"><input type="checkbox" id="${id}" data-pref="${c}" ${d.valor ? "checked" : ""}> <span>${layoutEsc(d.rotulo)}</span></label>`;
  let campo;
  if (d.tipo === "opcao") {
    campo = `<select id="${id}" data-pref="${c}">${d.opcoes.map((o, i) => `<option value="${i}" ${layoutValorOpcao(o) === d.valor ? "selected" : ""}>${layoutEsc(layoutRotuloOpcao(o))}</option>`).join("")}</select>`;
  } else if (d.tipo === "numero") {
    campo = `<input type="number" id="${id}" data-pref="${c}" value="${d.valor}" ${d.min != null ? `min="${d.min}"` : ""} ${d.max != null ? `max="${d.max}"` : ""} step="any">`;
  } else {
    campo = `<input type="text" id="${id}" data-pref="${c}" value="${layoutEsc(d.valor)}">`;
  }
  return `<label class="lay-linha" for="${id}"><span>${layoutEsc(d.rotulo)}</span>${campo}</label>`;
}

function layoutHtmlLayout() {
  const atual = VbMxPrefs.ler("layout.atual"), vis = layoutPaineisAtuais();
  const botoes = [...Object.entries(LAYOUT_PREDEFINIDOS).map(([v, l]) => [v, l.rotulo]), ["personalizado", "Personalizado"]]
    .map(([v, r]) => `<button type="button" class="botao lay-btn" data-layout="${v}" aria-pressed="${v === atual}">${r}</button>`).join("");
  const chaves = LAYOUT_PAINEIS.map(p => `<label class="lay-linha"><input type="checkbox" data-painel="${p.id}" ${vis[p.id] ? "checked" : ""}> <span>${p.rotulo}</span></label>`).join("");
  return `<section class="lay-sec"><h3 class="rotulo">Layout</h3><div class="lay-botoes">${botoes}</div><div class="lay-paineis">${chaves}</div></section>`;
}

// Lê a lista de preferências declaradas (nada por nome); "layout" tem seção própria acima.
function layoutHtmlPrefs() {
  const grupos = new Map();
  for (const d of VbMxPrefs.declaradas()) {
    if (d.modulo === "layout") continue;
    if (!grupos.has(d.modulo)) grupos.set(d.modulo, []);
    grupos.get(d.modulo).push(d);
  }
  return [...grupos].map(([m, lista]) =>
    `<section class="lay-sec"><h3 class="rotulo">${layoutEsc(LAYOUT_TITULOS[m] || m)}</h3>${lista.map(layoutControle).join("")}</section>`).join("");
}

function layoutRedesenhar() {
  if (!layoutPainel) return;
  const area = layoutPainel.querySelector("[data-lay-area]");
  if (area) area.innerHTML = layoutHtmlLayout() + layoutHtmlPrefs();
}
function layoutMensagem(txt, erro) {
  const m = layoutPainel && layoutPainel.querySelector("[data-lay-msg]");
  if (m) { m.textContent = txt; m.classList.toggle("erro", !!erro); }
}

function layoutEscolherLayout(nome) {
  if (nome === "personalizado") {
    // parte do que está na tela, para não "pular" ao entrar no modo livre
    const vis = layoutPaineisAtuais();
    for (const p of LAYOUT_PAINEIS) VbMxPrefs.gravar(`layout.pers-${p.id}`, vis[p.id]);
  }
  VbMxPrefs.gravar("layout.atual", nome);
}

function layoutAoMudar(ev) {
  const el = ev.target;
  if (el.dataset.painel) {
    const id = el.dataset.painel, vis = layoutPaineisAtuais();
    for (const p of LAYOUT_PAINEIS) VbMxPrefs.gravar(`layout.pers-${p.id}`, p.id === id ? el.checked : vis[p.id]);
    if (VbMxPrefs.ler("layout.atual") !== "personalizado") VbMxPrefs.gravar("layout.atual", "personalizado");
    else layoutAplicar();
    layoutRedesenhar();
    return;
  }
  const chave = el.dataset.pref;
  const d = chave && VbMxPrefs.declaradas().find(x => x.chave === chave);
  if (!d) return;
  let v;
  if (d.tipo === "booleano") v = el.checked;
  else if (d.tipo === "numero") v = el.value === "" ? NaN : Number(el.value);
  else if (d.tipo === "opcao") v = layoutValorOpcao(d.opcoes[Number(el.value)]);
  else v = el.value;
  try { VbMxPrefs.gravar(chave, v); layoutMensagem(""); }
  catch (_) {
    layoutMensagem(`Valor inválido para "${d.rotulo}"${d.min != null || d.max != null ? ` (entre ${d.min ?? "−∞"} e ${d.max ?? "∞"})` : ""}.`, true);
    layoutRedesenhar();
  }
}

function layoutExportar() {
  const json = JSON.stringify(VbMxPrefs.exportar(), null, 2);
  layoutPainel.querySelector("[data-lay-json]").value = json;
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = "vbmx-preferencias.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (_) { /* o texto fica na caixa para copiar */ }
  layoutMensagem("Preferências exportadas (arquivo baixado e texto na caixa).");
}
function layoutImportarTexto(txt) {
  let obj;
  try { obj = JSON.parse(txt); } catch (_) { layoutMensagem("JSON inválido: nada foi importado.", true); return; }
  const r = VbMxPrefs.importar(obj);
  layoutAplicar(); layoutRedesenhar();
  const nomes = r.ignoradas.slice(0, 3).map(i => i.chave).join(", ") + (r.ignoradas.length > 3 ? "…" : "");
  layoutMensagem(`Importadas ${r.aplicadas.length}; ignoradas ${r.ignoradas.length}${r.ignoradas.length ? ` (${nomes})` : ""}.`, r.ignoradas.length > 0);
}

function layoutAlternarPainel(abrir) {
  if (!layoutPainel) return;
  const aberto = abrir === undefined ? layoutPainel.hidden : abrir;
  layoutPainel.hidden = !aberto;
  const b = document.getElementById("layout-abrir");
  if (b) b.setAttribute("aria-expanded", String(aberto));
  if (aberto) layoutRedesenhar();
}

function layoutMontar() {
  const topo = document.querySelector("header.topo"), slot = VbMxUI.slot("preferencias");
  if (!topo || !slot || document.getElementById("layout-abrir")) return;
  layoutPainel = slot;
  const b = document.createElement("button");
  b.id = "layout-abrir"; b.type = "button"; b.className = "botao lay-abrir";
  b.textContent = "Preferências"; b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", "layout-painel");
  topo.appendChild(b);
  layoutPainel.id = "layout-painel"; layoutPainel.className = "lay-painel";
  layoutPainel.setAttribute("role", "dialog"); layoutPainel.setAttribute("aria-label", "Preferências");
  layoutPainel.innerHTML = `
    <div class="lay-cab"><h2>Preferências</h2><button type="button" class="botao" data-lay-fechar aria-label="Fechar as preferências">Fechar</button></div>
    <div data-lay-area></div>
    <section class="lay-sec"><h3 class="rotulo">Exportar e importar</h3>
      <div class="lay-botoes">
        <button type="button" class="botao lay-btn" data-lay-exportar>Exportar JSON</button>
        <button type="button" class="botao lay-btn" data-lay-importar>Importar da caixa</button>
        <label class="botao lay-btn lay-arquivo">Importar arquivo<input type="file" accept="application/json,.json" data-lay-arquivo hidden></label>
        <button type="button" class="botao lay-btn" data-lay-padroes>Restaurar padrões</button>
      </div>
      <textarea data-lay-json rows="6" spellcheck="false" aria-label="Preferências em JSON" placeholder="Cole aqui o JSON exportado"></textarea>
    </section>
    <p class="lay-msg" data-lay-msg role="status"></p>`;
  b.addEventListener("click", () => layoutAlternarPainel());
  layoutPainel.addEventListener("change", layoutAoMudar);
  layoutPainel.addEventListener("click", ev => {
    const t = ev.target.closest("button"); if (!t) return;
    if (t.dataset.layout) { layoutEscolherLayout(t.dataset.layout); layoutRedesenhar(); }
    else if (t.hasAttribute("data-lay-fechar")) { layoutAlternarPainel(false); b.focus(); }
    else if (t.hasAttribute("data-lay-exportar")) layoutExportar();
    else if (t.hasAttribute("data-lay-importar")) layoutImportarTexto(layoutPainel.querySelector("[data-lay-json]").value);
    else if (t.hasAttribute("data-lay-padroes")) { VbMxPrefs.restaurarPadroes(); layoutAplicar(); layoutRedesenhar(); layoutMensagem("Padrões restaurados."); }
  });
  layoutPainel.querySelector("[data-lay-arquivo]").addEventListener("change", ev => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    f.text().then(txt => { layoutPainel.querySelector("[data-lay-json]").value = txt; layoutImportarTexto(txt); });
    ev.target.value = "";
  });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !layoutPainel.hidden) { layoutAlternarPainel(false); b.focus(); } });
  layoutAplicar();
}
if (typeof document !== "undefined") VbMxUI.aoIniciar(layoutMontar);
