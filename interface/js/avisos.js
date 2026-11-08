// ===================== avisos.js — avisos do deck: slot deck-X-avisos; guarda-carga (trava de carga no ar) =====================
// Dono: VB-19 (onda 1). Esqueleto criado pelo VB-11: a página já carrega este arquivo (classico.html não
// muda na onda 1). No carregamento só declare e registre (VbMxUI.registrar/ouvir, VbMxPrefs.declarar);
// mexa no DOM dentro de VbMxUI.aoIniciar(fn). Nome de topo com prefixo do módulo (os scripts
// clássicos dividem o escopo global). Contrato: docs/contratos.md.

// Preferências (P9: trava ligada por padrão, desligável; o VB-26 desenha a tela).
VbMxPrefs.declarar("avisos.trava-carga", true, { tipo: "booleano", modulo: "avisos",
  rotulo: "Não carregar faixa em deck que está tocando" });
VbMxPrefs.declarar("avisos.fim-ativo", true, { tipo: "booleano", modulo: "avisos",
  rotulo: "Avisar o fim da faixa no deck e na onda" });
VbMxPrefs.declarar("avisos.fim-segundos", 30, { tipo: "numero", modulo: "avisos", min: 5, max: 120,
  rotulo: "Avisar quando faltarem (s)" });

// ---- Lógica pura (testada em Node: interface/testar-avisos.js) ----
// Nível do aviso de fim: "" (nada), "aviso" (dentro do limite) ou "critico" (último terço, máx. 10 s).
// `restante` em segundos de relógio (já dividido pela taxa); só avisa com o deck tocando.
function avisosNivelFim(restante, limite, tocando){
  if (!tocando || !(limite > 0) || !Number.isFinite(restante) || restante < 0 || restante > limite) return "";
  return restante <= Math.min(10, limite / 3) ? "critico" : "aviso";
}
// Motivo de recusa da carga, ou null. Pura: recebe a preferência e se o deck toca.
function avisosMotivoTrava(travaLigada, tocando, letra){
  if (!travaLigada || !tocando) return null;
  return `Deck ${letra} está tocando: pause antes de carregar outra faixa (trava de segurança, desligável nas preferências)`;
}
function avisosTravaAtiva(letra){
  const toca = typeof tocandoDeck === "function" && tocandoDeck(letra);
  return avisosMotivoTrava(VbMxPrefs.ler("avisos.trava-carga"), toca, letra);
}

// ---- Trava de carga: o deck.js consulta as guardas antes de parar o que toca ----
VbMxUI.registrar("guarda-carga", (letra) => {
  const motivo = avisosTravaAtiva(letra);
  if (motivo) avisosToast(motivo);
  return motivo;
});

// ---- Aviso de fim de faixa ----
function avisosTaxa(letra){
  try { const t = VbMxTocador.estado(letra).taxa; return t > 0 ? t : 1; } catch (_) { return 1; }
}
function avisosAtualizarDeck(letra, posicao, duracao, tocando){
  if (typeof document === "undefined") return;
  const div = document.querySelector(`[data-deck="${letra}"]`);
  if (!div) return;
  const lig = VbMxPrefs.ler("avisos.fim-ativo");
  const restante = (duracao - posicao) / avisosTaxa(letra);
  const nivel = lig ? avisosNivelFim(restante, VbMxPrefs.ler("avisos.fim-segundos"), tocando) : "";
  div.classList.toggle("fim-aviso", nivel === "aviso");
  div.classList.toggle("fim-critico", nivel === "critico");
  if (nivel) div.setAttribute("data-fim", `FIM EM ${VbMxReproducao.formatarTempo(restante)}`);
  else div.removeAttribute("data-fim");
}
VbMxUI.ouvir("deck:posicao", e => avisosAtualizarDeck(e.letra, e.posicao, e.duracao, e.tocando));
for (const ev of ["deck:pausou", "deck:fim", "deck:carregado", "deck:descarregado"])
  VbMxUI.ouvir(ev, e => avisosAtualizarDeck(e.letra, 0, 0, false));

// Faixa vermelha nos últimos N s da onda; pisca dentro do limite (mais rápido no crítico).
VbMxUI.registrar("camada-onda", (c, deck, janela) => {
  if (!VbMxPrefs.ler("avisos.fim-ativo") || !deck.d.buffer) return;
  const dur = deck.d.buffer.duration, lim = VbMxPrefs.ler("avisos.fim-segundos");
  const taxa = avisosTaxa(deck.letra);
  const ini = dur - lim * taxa;
  if (janela.fim < ini || janela.inicio > dur) return;
  const x0 = Math.max(0, janela.x(ini)), x1 = Math.min(c.w, janela.x(dur));
  if (!(x1 > x0)) return;
  const nivel = avisosNivelFim((dur - deck.pos) / taxa, lim, tocandoDeck(deck.letra));
  const pisca = nivel ? 0.5 + 0.5 * Math.sin(Date.now() / (nivel === "critico" ? 120 : 280)) : 0;
  c.g.fillStyle = `rgba(224, 82, 82, ${0.12 + 0.28 * pisca})`;
  c.g.fillRect(x0, 0, x1 - x0, c.h);
  c.g.fillStyle = "rgba(224, 82, 82, 0.9)";
  c.g.fillRect(x0, 0, Math.max(1, c.dpr || 1), c.h);   // marca onde o aviso começa
});

// ---- DOM (só depois do boot) ----
function avisosToast(texto){
  if (typeof document === "undefined") return;
  let el = document.getElementById("avisos-toast");
  if (!el) return;
  el.textContent = texto; el.hidden = false;
  clearTimeout(avisosToast.t);
  avisosToast.t = setTimeout(() => { el.hidden = true; }, 4000);
}
VbMxUI.aoIniciar(() => {
  const css = document.createElement("style");
  css.textContent = `
.deck.fim-aviso, .deck.fim-critico { border-color: #e05252; }
.deck.fim-aviso::before, .deck.fim-critico::before { content: attr(data-fim); position: absolute; top: -1px; left: 50%;
  transform: translateX(-50%); background: #e05252; color: #fff; font: 700 12px var(--fonte-dados, monospace);
  padding: 1px 10px; border-radius: 0 0 4px 4px; letter-spacing: .06em; z-index: 2; }
.deck.fim-aviso { animation: avisos-pisca 1.2s ease-in-out infinite; }
.deck.fim-critico { animation: avisos-pisca .5s ease-in-out infinite; }
@keyframes avisos-pisca { 50% { box-shadow: 0 0 0 2px rgba(224, 82, 82, .7); } }
@media (prefers-reduced-motion: reduce) { .deck.fim-aviso, .deck.fim-critico { animation: none; box-shadow: 0 0 0 2px rgba(224, 82, 82, .7); } }
.deck.alvo-recusado { outline: 2px dashed #e05252; outline-offset: -2px; }
#avisos-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50; max-width: min(90vw, 560px);
  background: #3a1616; color: #ffd9d9; border: 1px solid #e05252; border-radius: 6px; padding: 10px 14px; font-size: 14px; }`;
  document.head.appendChild(css);
  for (const d of document.querySelectorAll(".deck")) if (getComputedStyle(d).position === "static") d.style.position = "relative";
  const t = document.createElement("div");
  t.id = "avisos-toast"; t.hidden = true; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
  document.body.appendChild(t);
});
