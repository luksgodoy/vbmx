// ===================== disposicao.js — disposição da tela: browser embaixo/à esquerda e recolher (proposta A) =====================
// Dono: proposta A (2026-11-07). No carregamento só declara; o DOM entra em VbMxUI.aoIniciar. Tudo é preferência
// persistida (VbMxPrefs) e vira classe no <body>; o desenho mora em css/disposicao.css.
//   layout.browser           "baixo" | "esquerda"   onde fica o browser (biblioteca + sugestões); alternador no topo
//   deck.mini-a / deck.mini-b                       deck recolhido para o MINI DECK (uma linha); botão ▾ no cabeçalho
//   layout.stems-recolhido-a / -b                   faixa de stems só com o cabeçalho; botão ▾ no cabeçalho dos stems
//   layout.fx-recolhido                             some a faixa de FX dos dois lados
//   (aba BIBLIOTECA)                                browser à esquerda em ≤1500px: coluna recolhida numa aba, abre por cima; não persiste
//   layout.grade-visivel                            barra de ajuste da GRADE (slot deck-X-grade): OCULTA por padrão, botão "Grade ▸" no topo
//   layout.mixer-compacto                           mixer só com canais, crossfader e master
//   (abas do browser)                               D1 do VB-UI-ROLAGEM: pastas, importar .nml, preparação, histórico e gravador
//                                                   moram em abas do browser (os nós são MOVIDOS uma vez no boot, nunca recriados)
//   (gaveta embaixo)                                D4: janela baixa (≤860px) com o browser embaixo vira gaveta com aba de 30px
// Lógica pura (dispClasses) testada em Node por interface/testar-disposicao.js.
const DISP_BROWSER = [{ valor: "baixo", rotulo: "embaixo" }, { valor: "esquerda", rotulo: "à esquerda" }];
VbMxPrefs.declarar("layout.browser", "baixo", { tipo: "opcao", modulo: "layout", rotulo: "Browser (biblioteca e sugestões)", opcoes: DISP_BROWSER });
for (const l of ["a", "b"]) {
  VbMxPrefs.declarar(`deck.mini-${l}`, false, { tipo: "booleano", modulo: "layout", rotulo: `Deck ${l.toUpperCase()} recolhido (mini deck)` });
  VbMxPrefs.declarar(`layout.stems-recolhido-${l}`, false, { tipo: "booleano", modulo: "layout", rotulo: `Stems do deck ${l.toUpperCase()} recolhidos` });
}
VbMxPrefs.declarar("layout.fx-recolhido", false, { tipo: "booleano", modulo: "layout", rotulo: "FX recolhido" });
VbMxPrefs.declarar("layout.grade-visivel", false, { tipo: "booleano", modulo: "layout", rotulo: "Barra de GRADE visível (oculta por padrão)" });
VbMxPrefs.declarar("layout.mixer-compacto", false, { tipo: "booleano", modulo: "layout", rotulo: "Mixer compacto" });

// Estado → lista de classes do <body>. Valor desconhecido de `browser` cai em "baixo".
function dispClasses(e) {
  const c = [`browser-${e.browser === "esquerda" ? "esq" : "baixo"}`];
  if (e.miniA) c.push("mini-A");
  if (e.miniB) c.push("mini-B");
  if (e.stemsA) c.push("stems-rec-A");
  if (e.stemsB) c.push("stems-rec-B");
  if (e.fx) c.push("fx-recolhido");
  if (e.mixer) c.push("mixer-compacto");
  if (e.grade) c.push("grade-visivel");
  return c;
}
const DISP_TODAS = ["browser-baixo", "browser-esq", "mini-A", "mini-B", "stems-rec-A", "stems-rec-B", "fx-recolhido", "mixer-compacto", "grade-visivel"];
function dispEstado() {
  const L = VbMxPrefs.ler;
  return { browser: L("layout.browser"), miniA: L("deck.mini-a"), miniB: L("deck.mini-b"), stemsA: L("layout.stems-recolhido-a"),
    stemsB: L("layout.stems-recolhido-b"), fx: L("layout.fx-recolhido"), mixer: L("layout.mixer-compacto"), grade: L("layout.grade-visivel") };
}
function dispAlternar(chave) { VbMxPrefs.gravar(chave, !VbMxPrefs.ler(chave)); }
// Chaves de preferência por nome curto, usado pelos botões (data-recolher="mini-A", "stems-B", "fx", "mixer").
function dispChave(nome) {
  const m = /^(mini|stems)-([AB])$/.exec(nome);
  if (m) return m[1] === "mini" ? `deck.mini-${m[2].toLowerCase()}` : `layout.stems-recolhido-${m[2].toLowerCase()}`;
  return nome === "fx" ? "layout.fx-recolhido" : nome === "mixer" ? "layout.mixer-compacto" : null;
}

// D1 (VB-UI-ROLAGEM, 2026-11-08): abas do browser. id → rótulo e os seletores do que a aba carrega; "biblioteca" é a tabela + sugestões.
const DISP_ABAS = [
  { id: "biblioteca", rotulo: "Biblioteca", nos: [] },
  { id: "pastas", rotulo: "Pastas · importar", nos: ["#pastas", "#importar-nml"] },
  { id: "preparacao", rotulo: "Preparação", nos: ['[data-slot="preparacao"]'] },
  { id: "historico", rotulo: "Histórico", nos: ['[data-slot="historico"]'] },
  { id: "gravador", rotulo: "Gravador", nos: ['[data-slot="gravador"]'] },
];
function dispAbaValida(id) { return DISP_ABAS.some(a => a.id === id) ? id : "biblioteca"; }

let dispBotoes = null;
function dispAbaMostrar(id) {
  const br = document.querySelector("section.browser"); if (!br) return;
  const atual = dispAbaValida(id);
  br.dataset.aba = atual;
  for (const b of br.querySelectorAll(".browser-abas [data-aba]")) b.setAttribute("aria-selected", String(b.dataset.aba === atual));
  for (const p of br.querySelectorAll(".browser-painel")) p.hidden = p.dataset.painel !== atual;
}
// Monta a barra de abas e MOVE os nós (o módulo dono continua achando o seu pelo id ou pelo VbMxUI.slot). Roda depois de todos os
// aoIniciar (setTimeout 0): o importar.js cria #importar-nml no dele.
function dispAbasMontar() {
  const br = document.querySelector("section.browser"); if (!br || br.querySelector(".browser-abas")) return;
  const barra = document.createElement("div");
  barra.className = "browser-abas"; barra.setAttribute("role", "tablist"); barra.setAttribute("aria-label", "Abas do browser");
  barra.innerHTML = DISP_ABAS.map(a => `<button type="button" class="browser-aba-bt" role="tab" data-aba="${a.id}" aria-selected="false">${a.rotulo}</button>`).join("");
  br.insertBefore(barra, br.firstChild);
  for (const a of DISP_ABAS) {
    if (!a.nos.length) continue;
    const p = document.createElement("div");
    p.className = "browser-painel"; p.dataset.painel = a.id; p.setAttribute("role", "tabpanel"); p.setAttribute("aria-label", a.rotulo);
    for (const sel of a.nos) { const el = document.querySelector(sel); if (el) p.appendChild(el); }
    br.appendChild(p);
  }
  barra.addEventListener("click", e => { const b = e.target.closest("[data-aba]"); if (b) dispAbaMostrar(b.dataset.aba); });
  dispAbaMostrar("biblioteca");
}
function dispAplicar() {
  if (typeof document === "undefined" || !document.body) return;
  const est = dispEstado();
  document.body.classList.remove(...DISP_TODAS);
  document.body.classList.add(...dispClasses(est));
  for (const el of document.querySelectorAll("[data-recolher]")) {
    const ch = dispChave(el.dataset.recolher), lig = ch ? !!VbMxPrefs.ler(ch) : false;
    el.setAttribute("aria-pressed", String(lig));
    el.title = el.title.replace(/^(Recolher|Expandir)/, lig ? "Expandir" : "Recolher");
  }
  if (dispBotoes) {
    dispBotoes.querySelector("[data-disp-browser]").textContent = `Browser: ${est.browser === "esquerda" ? "à esquerda" : "embaixo"}`;
    dispBotoes.querySelector("[data-disp-fx]").setAttribute("aria-pressed", String(est.fx));
    dispBotoes.querySelector("[data-disp-mixer]").setAttribute("aria-pressed", String(est.mixer));
    const g = dispBotoes.querySelector("[data-disp-grade]");
    g.setAttribute("aria-pressed", String(!!est.grade)); g.textContent = est.grade ? "Grade ▾" : "Grade ▸";
  }
  const topo = document.querySelector("header.topo");
  if (topo) document.documentElement.style.setProperty("--topo-h", `${topo.offsetHeight}px`);
}

VbMxUI.aoIniciar(() => {
  const topo = document.querySelector("header.topo");
  if (topo) {
    dispBotoes = document.createElement("div");
    dispBotoes.className = "disp-botoes";
    dispBotoes.innerHTML = `<button type="button" class="disp-bt" data-disp-browser title="Alternar o browser entre embaixo e à esquerda (fica guardado)" aria-label="Posição do browser: alternar entre embaixo e à esquerda"></button>
      <button type="button" class="disp-bt" data-disp-fx aria-pressed="false" title="Recolher ou mostrar as faixas de FX" aria-label="Recolher FX">FX ▾</button>
      <button type="button" class="disp-bt" data-disp-grade aria-pressed="false" title="Mostrar ou ocultar a barra de ajuste da grade (BPM, 1ª batida, TAP, TICK…); oculta por padrão" aria-label="Barra de grade">Grade ▸</button>
      <button type="button" class="disp-bt" data-disp-mixer aria-pressed="false" title="Mixer compacto: só canais, crossfader e master" aria-label="Mixer compacto">Mixer ▾</button>`;
    topo.insertBefore(dispBotoes, topo.querySelector(".estado-global"));
    dispBotoes.querySelector("[data-disp-browser]").addEventListener("click", () =>
      VbMxPrefs.gravar("layout.browser", VbMxPrefs.ler("layout.browser") === "baixo" ? "esquerda" : "baixo"));
    dispBotoes.querySelector("[data-disp-fx]").addEventListener("click", () => dispAlternar("layout.fx-recolhido"));
    dispBotoes.querySelector("[data-disp-grade]").addEventListener("click", () => dispAlternar("layout.grade-visivel"));
    dispBotoes.querySelector("[data-disp-mixer]").addEventListener("click", () => dispAlternar("layout.mixer-compacto"));
  }
  // aba do browser à esquerda em janela estreita (≤1500px, ver disposicao.css): abre/fecha a gaveta; não persiste
  const tela = document.querySelector("main.tela");
  if (tela) {
    const aba = document.createElement("button");
    aba.type = "button"; aba.className = "browser-aba"; aba.textContent = "BIBLIOTECA";
    aba.title = "Abrir ou fechar a biblioteca e as sugestões"; aba.setAttribute("aria-label", "Abrir ou fechar o browser");
    tela.insertBefore(aba, tela.firstChild);
    aba.addEventListener("click", () => document.body.classList.toggle("browser-aberto"));
    document.addEventListener("keydown", e => { if (e.key === "Escape") document.body.classList.remove("browser-aberto"); });
  }
  setTimeout(dispAbasMontar, 0);
  // topo numa linha: a origem da biblioteca vira selo curto (CSS corta), o texto inteiro fica no title
  const origem = document.getElementById("marca-origem");
  if (origem && typeof MutationObserver === "function") {
    const titulo = () => { const t = origem.textContent.replace(/\s+/g, " ").trim(); if (origem.title !== t) origem.title = t; };
    new MutationObserver(titulo).observe(origem, { childList: true, characterData: true, subtree: true }); titulo();
  }
  // botões [data-recolher] nascem dentro dos decks e dos stems (reescritos por renderDeck e pelos stems): delegação
  document.addEventListener("click", e => {
    const b = e.target && e.target.closest ? e.target.closest("[data-recolher]") : null;
    const ch = b && dispChave(b.dataset.recolher);
    if (ch) dispAlternar(ch);
  });
  for (const ch of ["layout.browser", "deck.mini-a", "deck.mini-b", "layout.stems-recolhido-a", "layout.stems-recolhido-b", "layout.fx-recolhido", "layout.mixer-compacto", "layout.grade-visivel"])
    VbMxPrefs.ouvir(ch, dispAplicar);
  window.addEventListener("resize", () => { const t = document.querySelector("header.topo"); if (t) document.documentElement.style.setProperty("--topo-h", `${t.offsetHeight}px`); });
  dispAplicar();
});
if (typeof module !== "undefined") module.exports = { dispClasses, dispChave, dispAbaValida, DISP_ABAS };
