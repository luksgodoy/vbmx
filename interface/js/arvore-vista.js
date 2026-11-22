// ===================== arvore-vista.js — a biblioteca em duas vistas: tabela de músicas ou ÁRVORE de próximas faixas =====================
// Pedido do Lucas (2026-11-08): um botão no cabeçalho da biblioteca troca a tabela pela árvore do que pode vir depois do que está
// tocando. A árvore é a de 25/10 (motor/arvore.js, vinda do ramo vb-ui-arvore): o que já tocou → o que toca → o que pode vir
// (agrupado por relação harmônica) → o que vem depois da candidata. Só usa o que a biblioteca já tem (BPM, Camelot) via VbMxMotor.
// A vista ocupa o lugar da `.lista` dentro de #biblio: mesma caixa, mesma altura, mesma rolagem (o contrato de 10 linhas é da tabela).
//   layout.biblio-vista   "tabela" | "arvore"   guardada como as outras prefs layout.*
// Base da árvore = VbMxArvore.escolherBase: o deck que toca (dois tocando → maior volume efetivo; empate → o último a tocar).
// Clique no nó = candidata (abre o nível 2); botões A/B carregam o deck; arrastar o nó para um deck carrega (arrastar.js).
const ARVV_VISTAS = ["tabela", "arvore"];
VbMxPrefs.declarar("layout.biblio-vista", "tabela", { tipo: "opcao", modulo: "layout", rotulo: "pro.pref.biblio-vista", opcoes: ARVV_VISTAS });

function arvvVistaValida(v) { return v === "arvore" ? "arvore" : "tabela"; }
function arvvOutra(v) { return arvvVistaValida(v) === "arvore" ? "tabela" : "arvore"; }
function arvvVista() { return arvvVistaValida(VbMxPrefs.ler("layout.biblio-vista")); }
function arvvAlternar() { VbMxPrefs.gravar("layout.biblio-vista", arvvOutra(arvvVista())); }
function arvvBotaoHTML() {
  const arv = arvvVista() === "arvore";
  return `<button type="button" class="alternador" id="bib-vista" aria-pressed="${arv}" title="${arv ? tr("pro.arv.volta-t") : tr("pro.arv.troca-t")}">${arv ? tr("pro.arv.tabela") : tr("pro.arv.arvore")}</button>${arv && typeof amxBotaoHTML === "function" ? amxBotaoHTML() : ""}`;
}
// Mixagem automática (js/automix.js) ligada? Desligada, esta vista desenha exatamente o que desenhava antes dela.
function arvvAuto() { return typeof amxLigado === "function" && amxLigado(); }

// ---- estado ----
let arvvCandidata = null, arvvRaizId = null, arvvUltimo = null, arvvAssinatura = "", arvvQuadro = 0, arvvModelo = null;
function arvvDecks() {
  const o = {};
  for (const l of ["A", "B"]) {
    const c = mixer[l];
    o[l] = { faixa: decks[l].faixa, tocando: !!decks[l].faixa && tocandoDeck(l),
      volume: VbMxMixer.ganhoFader(c.vol, mixer.curvaFader) * VbMxMixer.ganhoCrossfaderDoCanal(c, mixer) };
  }
  return o;
}
function arvvBase() { return VbMxArvore.escolherBase(arvvDecks(), arvvUltimo); }
function arvvEfetiva(base) { return VbMxTom.faixaEfetiva(base.faixa, decks[base.letra].pitch, opcoesDoTom(decks[base.letra])); }
function arvvFaixa(id) { return BIBLIOTECA.find(f => f.id === id); }
function arvvHistoricoIds() { return VbMxArvore.idsDoHistorico(typeof historicoSessao !== "undefined" && historicoSessao ? historicoSessao.entradas() : []); }

// ---- desenho ----
function arvvNoHTML(n, nivel, candId, proxId) {
  const f = n.c.faixa;
  const sai = n.c.sairiaCom ? amxSairiaHTML(n.c) : { classe: "", dica: "", etiqueta: "" };   // só com a mixagem automática ligada
  const prox = nivel === 1 && proxId != null && proxId === n.id;
  const cls = `no n${nivel}${nivel === 1 && candId === n.id ? " candidata" : ""}${sai.classe}${prox ? " proxima" : ""}`;
  const dica = `${f.titulo} · ${f.camelot} · ${fmtBpm(f.bpm)} BPM · ${trm(n.c.motivo)}${sai.dica}${prox ? " · " + tr("pro.arv.e-proxima") : ""}. ${nivel === 1 ? tr("pro.arv.clique-n1") : tr("pro.arv.clique-n2")}`;
  return `<div class="${cls}" data-faixa="${f.id}" data-no="${nivel}" draggable="true" role="button" tabindex="0" style="left:${n.x}px;top:${n.y}px;--cor:${corCamelot(f.camelot)}" title="${esc(dica)}" aria-label="${esc(dica)}">
    <span class="no-cor"></span><span class="no-chave mono">${tomTexto(f.camelot)}</span>
    <span class="no-titulo">${esc(f.titulo)}</span>
    <span class="no-delta mono ${VbMxArvore.classeDelta(n.c.bpm)}" title="${tr("pro.arv.delta-t",{ref:nivel === 1 ? tr("pro.arv.ref-tocando") : tr("pro.arv.ref-cand")})}">${VbMxArvore.deltaCurto(n.c.bpm)}</span>${sai.etiqueta}
    ${["A", "B"].map(l => `<span class="para-deck" role="button" tabindex="0" data-carregar="${l}" data-id="${f.id}" title="${tr("pro.carregar.titulo",{l})}" aria-label="${tr("pro.carregar.aria",{titulo:esc(f.titulo),l})}">${l}</span>`).join("")}
  </div>`;
}
function arvvQuadroHTML(m, base, auto) {
  const G = VbMxArvore.GEO, ref = m.ref, candId = m.candidata ? m.candidata.id : null;
  const hist = m.historico.map((h, i) => {
    const f = arvvFaixa(h.id);
    return `<div class="no hist" style="left:${h.x}px;top:${h.y}px;--cor:${f ? corCamelot(f.camelot) : "var(--fg-3)"}" title="${f ? esc(`${f.titulo} · ${tr("pro.arv.ja-tocou-set")}`) : tr("pro.arv.faixa-ja",{id:h.id})}"><span class="no-cor"></span><span class="no-titulo">${f ? esc(f.titulo) : `#${h.id}`}</span><span class="no-ordem mono">${i + 1}</span></div>`;
  }).join("");
  const ligHist = m.historico.map((h, i) => {
    const x0 = h.x + G.HIST_L, x1 = i + 1 < m.historico.length ? m.historico[i + 1].x : G.RAIZ_X;
    return `<path class="lig hist" d="M${x0} ${m.H / 2} L${x1} ${m.H / 2}"/>`;
  }).join("");
  const colunas = `
    <span class="coluna" style="left:${G.HIST_X}px">${tr("pro.arv.col-hist")}${m.escondidas ? ` · ${tr(m.escondidas === 1 ? "pro.arv.escondida" : "pro.arv.escondidas",{n:m.escondidas})}` : ""}</span>
    <span class="coluna" style="left:${G.RAIZ_X}px">${tr("pro.arv.col-tocando",{l:base.letra})}</span>
    <span class="coluna" style="left:${G.N1_X}px">${tr("pro.arv.col-vir")} · ${auto ? `${tr("pro.arv.criterios",{n:auto.entram})}${auto.entram > auto.max ? ` ${tr("pro.arv.melhores",{n:auto.max})}` : ""}` : tr(m.mixaveis === 1 ? "pro.arv.mixavel" : "pro.arv.mixaveis",{n:m.mixaveis})}</span>
    <span class="coluna n2" style="left:${G.N2_X}px">${m.candidata ? tr("pro.arv.depois-de",{t:esc(m.candidata.c.faixa.titulo),n:m.candidata.n2Total}) : tr("pro.arv.depois")}</span>`;
  const raiz = `<div class="no raiz" style="left:${m.raiz.x}px;top:${m.raiz.y}px;--cor:${corCamelot(ref.camelot)}" title="${esc(base.faixa.titulo)} · ${tr("pro.arv.tocando-no",{l:base.letra})} (${esc(trm(base.motivo))})">
      <span class="no-cor"></span><span class="raiz-txt"><b>${esc(base.faixa.titulo)}</b><span>${esc(base.faixa.artista)} · <span class="mono">${tomTexto(ref.camelot)} · ${fmtBpm(ref.bpm)}</span> BPM</span></span></div>`;
  const cabs = m.cabecalhos.map(c => `<span class="cab" style="left:${c.x}px;top:${c.y + 8}px">${esc(trm(c.motivo))} · ${c.n}</span>`).join("");
  const lig1 = m.nos.map(n => `<path class="lig n1${candId === n.id ? " candidata" : ""}" d="${n.caminho}"/>`).join("");
  const lig2 = m.n2.map(n => `<path class="lig n2" d="${n.caminho}"/>`).join("");
  const vazio = m.nos.length ? "" : `<div class="no vazio" style="left:${G.N1_X}px;top:${m.H / 2 - 13}px">${auto ? tr("pro.arv.vazio-auto") : m.total ? tr("pro.arv.vazio-tudo") : tr("pro.arv.vazio-nada")}</div>`;
  const crit = auto ? amxCriteriosHTML(auto.resumo, m.H) : { nos: "", caminho: "" };
  const proxId = auto ? auto.proximaId : null;
  return `<div class="arvore-quadro" style="width:${G.LARGURA}px;height:${m.H}px">
    <svg class="arvore-ligacoes" viewBox="0 0 ${G.LARGURA} ${m.H}" width="${G.LARGURA}" height="${m.H}" aria-hidden="true">${ligHist}${crit.caminho}${lig1}${lig2}</svg>
    ${colunas}${hist}${raiz}${crit.nos}${cabs}${m.nos.map(n => arvvNoHTML(n, 1, candId, proxId)).join("")}${m.n2.map(n => arvvNoHTML(n, 2, candId, null)).join("")}${vazio}
  </div>`;
}
// Conteúdo da vista (o que vai dentro de `.lista.lista-arvore`).
function arvoreVistaHTML() {
  const base = arvvBase(), ligado = arvvAuto(), barra = ligado ? amxBarraHTML() : "";
  if (!base) { arvvModelo = null; return `${barra}<div class="vazio-biblio vazio-arvore">${tr("pro.arv.nenhuma")}</div>`; }
  if (arvvRaizId !== base.faixa.id) { arvvCandidata = null; arvvRaizId = base.faixa.id; }
  const ref = arvvEfetiva(base);
  let compativeis = f => VbMxMotor.compativeis(f === base.faixa ? ref : f, BIBLIOTECA), auto = null, relacoes;
  if (ligado) {
    // A árvore pelos critérios marcados: o nível 1 é o que a mixagem automática escolheria agora (as melhores primeiro),
    // o nível 2 é a mesma conta a partir da candidata. Critério desmarcado continua desenhado (fileira acima da raiz) e
    // quem só entra por causa dele sai tracejado, com a razão.
    const outra = base.letra === "A" ? "B" : "A", max = VbMxArvore.GEO.N1_MAX_AUTO;
    const av = amxAvaliar(Object.assign({}, base.faixa, { camelot: ref.camelot }), amxTaxa(base.letra), VbMxPitch.faixaDe(outra), amxJaTocadas());
    auto = { resumo: av.resumo, entram: av.entram.length, max, proximaId: amxProximaId(base) };
    relacoes = amxRelacoes();
    compativeis = f => VbMxAutomix.paraArvore(f === base.faixa ? av : amxAvaliar(f, 1, VbMxPitch.faixaDe(base.letra), []), max);
  }
  const m = arvvModelo = VbMxArvore.montar({ ref: base.faixa, compativeis, historicoIds: arvvHistoricoIds(), candidataId: arvvCandidata, relacoes });
  m.ref = ref;
  if (m.candidata) arvvCandidata = m.candidata.id;
  return `${barra}<div class="arvore-rolo"><div class="arvore" id="arvore" role="group" aria-label="${tr("pro.arv.aria",{t:esc(base.faixa.titulo)})}">${arvvQuadroHTML(m, base, auto)}</div></div>`;
}
// Escala o quadro de 1456 px para a largura da caixa (mínimo 0,55; abaixo disso rola na horizontal).
function arvvEscalar() {
  const rolo = document.querySelector("#biblio .arvore-rolo"), q = rolo && rolo.querySelector(".arvore");
  if (!q) return;
  const G = VbMxArvore.GEO, esc_ = Math.max(0.55, Math.min(1, (rolo.clientWidth - 4) / G.LARGURA));
  const H = arvvModelo ? arvvModelo.H : G.ALTURA;
  q.style.setProperty("--escala", esc_.toFixed(4));
  q.style.width = `${Math.round(G.LARGURA * esc_)}px`; q.style.height = `${Math.round(H * esc_)}px`;
}
function arvvAssinaturaAtual() {
  const b = arvvBase(), a = arvvAuto() ? `|auto:${amxAssinatura(b)}` : "";
  if (!b) return `-${a}`;
  const r = arvvEfetiva(b);
  return `${b.letra}|${b.faixa.id}|${r.camelot}|${r.bpm.toFixed(3)}|${arvvCandidata}|${arvvHistoricoIds().join(",")}|${BIBLIOTECA.length}${a}`;
}
// Redesenha só a vista (não a biblioteca inteira), pulando quando nada que ela lê mudou.
function arvvAtualizar(forcar) {
  if (arvvVista() !== "arvore") return;
  const lista = document.querySelector("#biblio .lista-arvore");
  if (!lista) return;
  const nova = arvvAssinaturaAtual();
  if (!forcar && nova === arvvAssinatura) return;
  arvvAssinatura = nova;
  const rolo = lista.querySelector(".arvore-rolo"), esq = rolo ? rolo.scrollLeft : 0, topo = lista.scrollTop;
  const foco = document.activeElement && lista.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.amxCriterio : null;
  lista.innerHTML = arvoreVistaHTML();
  if (foco) { const el = lista.querySelector(`[data-amx-criterio="${foco}"]`); if (el) el.focus(); }
  arvvEscalar();
  const r2 = lista.querySelector(".arvore-rolo"); if (r2) r2.scrollLeft = esq;
  lista.scrollTop = topo;
}
function arvvAgendar() {
  if (arvvQuadro) return;
  arvvQuadro = requestAnimationFrame(() => { arvvQuadro = 0; arvvAtualizar(false); });
}
// Chamado por biblio.js depois de desenhar a biblioteca inteira (renderBiblio): marca a assinatura e escala.
function arvvAposRender() { arvvAssinatura = arvvAssinaturaAtual(); arvvEscalar(); }

// Clique no nó: nível 1 vira candidata (nível 2 muda); nível 2 cai no seletor global (seleciona a faixa).
// O A/B dos nós sobe até o principal.js, que carrega o deck.
function arvvClique(e) {
  if (e.target.closest("[data-carregar],[data-card-acao]")) return;
  const no = e.target.closest(".no[data-no='1']");
  if (!no) return;
  e.stopPropagation();
  arvvCandidata = Number(no.dataset.faixa);
  arvvAtualizar(true);
}
VbMxUI.aoIniciar(() => {
  const div = document.getElementById("biblio");
  div.addEventListener("click", arvvClique);
  div.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".no[data-no='1']")) { e.preventDefault(); e.stopPropagation(); arvvCandidata = Number(e.target.dataset.faixa); arvvAtualizar(true); }
  });
  VbMxUI.ouvir("deck:tocou", e => { arvvUltimo = e.letra; arvvAgendar(); });
  for (const ev of ["deck:pausou", "deck:fim", "deck:carregado", "deck:descarregado", "deck:pitch", "mixer:mudou", "ar:faixa", "biblioteca:mudou"]) VbMxUI.ouvir(ev, arvvAgendar);
  VbMxPrefs.ouvir("layout.biblio-vista", () => renderBiblio());
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(arvvEscalar).observe(div);
  else window.addEventListener("resize", arvvEscalar);
});
if (typeof module !== "undefined") module.exports = { arvvVistaValida, arvvOutra, ARVV_VISTAS };
if (typeof VbMxUI !== "undefined") VbMxUI.aoIdioma(() => { if (typeof renderBiblio === "function" && typeof BIBLIOTECA !== "undefined") renderBiblio(); });
