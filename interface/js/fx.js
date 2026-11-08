// ===================== fx.js — unidades de FX: slots fx-1 e fx-2 =====================
// Dono: VB-22 (onda 2). Spec §6. O estado puro mora em motor/fx.js (VbMxFx); os nós, em js/fx-nos.js.
// No carregamento só declara e registra; o DOM nasce em VbMxUI.aoIniciar. Nome de topo: prefixo `fx`.
//
// 2 unidades. Cada uma tem, no cabeçalho, um botão por canal (A, B; acende ao atribuir), o seletor de modo
// (1 ponto = único, 3 pontos = grupo) e o liga. Modo único: seletor, D/W, 3 knobs, 2 botões, reset e
// "salvar" (snapshot). Modo grupo: 3 seletores, 3 knobs (duplo clique restaura o padrão), 3 liga e 1 D/W.
//
// TEMPO: o BPM vem de `obterBpm()`, injetável com VbMxFxUI.definirObterBpm(fn) — o VB-35 (relógio mestre)
// liga aqui o BPM do deck mestre. Sem injeção, usa o deck que toca (A primeiro) e, parado, o deck A ou B
// carregado; sem nenhum, 120.
// ÁUDIO: o grafo (VbMxCadeia) só existe depois do primeiro gesto; a cada 250 ms o módulo confere se já dá
// para inserir as unidades no ponto "fx" de cada canal e reajusta o que depende do BPM.
// Ações (teclado/MIDI): fx{1|2}.liga, fx{1|2}.canalA, fx{1|2}.canalB, fx{1|2}.modo, fx{1|2}.rota.
const fx = {
  est: VbMxFx.estadoInicial(),
  nos: null,            // {A: [unidadeCanal×2], B: [...]} depois de ligado ao grafo
  liga: null,           // {A: {removers, envios}, B: …}: a fiação de cada canal (fxReligar)
  rotas: null,
  obterBpm: null,
  timer: null,
};
VbMxUI.declararEvento("fx:mudou");

function fxDefinirObterBpm(fn) { fx.obterBpm = typeof fn === "function" ? fn : null; fxTempo(); }
function fxBpmPadrao() {
  if (typeof decks === "undefined") return NaN;
  for (const l of ["A", "B"]) { if (decks[l].faixa && tocandoDeck(l)) return bpmEfetivoDeck(l); }
  for (const l of ["A", "B"]) { if (decks[l].faixa) return bpmEfetivoDeck(l); }
  return NaN;
}
function fxLerBpm() { try { return fx.obterBpm ? fx.obterBpm() : fxBpmPadrao(); } catch (_) { return NaN; } }

// ---------- áudio ----------
function fxUnidade(n) { return fx.est.unidades.find(u => u.n === n); }
function fxLigarAoGrafo() {
  if (fx.nos || !VbMxCadeia.montada()) return;
  const ctx = VbMxCadeia.ponto("A", "fx").entrada.context;
  fx.nos = {}; fx.liga = {};
  for (const l of VbMxFx.CANAIS) {
    fx.nos[l] = VbMxFx.estadoInicial().unidades.map(() => VbMxFxNos.criarUnidadeCanal(ctx, fxLerBpm));
    fx.liga[l] = { removers: [], envios: {} };
  }
  fxReligar();
  fxAplicarAudio();
}
// VB-62b: liga cada unidade pela sua rota. inserção = em série no ponto "fx" (antes do fader, o som de sempre);
// pós-fader = em série no ponto "posfader"; envio = em paralelo, cópia do canal → nível → unidade → soma do master.
// Só refaz a fiação quando a combinação de rotas muda (fx.rotas); com tudo em inserção é a mesma cadeia de antes.
function fxReligar() {
  if (!fx.nos) return;
  const chave = fx.est.unidades.map(u => u.rota).join();
  if (chave === fx.rotas) return;
  fx.rotas = chave;
  for (const l of VbMxFx.CANAIS) {
    const lg = fx.liga[l];
    for (const r of lg.removers) r();
    for (const i in lg.envios) lg.envios[i].remover();
    lg.removers = []; lg.envios = {};
    for (const u of fx.nos[l]) u.saida.disconnect();
    const grupo = { insercao: [], "pos-fader": [] };
    fx.est.unidades.forEach((u, i) => {
      if (grupo[u.rota]) grupo[u.rota].push(fx.nos[l][i]);
      else lg.envios[i] = VbMxCadeia.enviar(l, fx.nos[l][i]);
    });
    for (const [rota, ponto] of [["insercao", "fx"], ["pos-fader", "posfader"]]) {
      const us = grupo[rota]; if (!us.length) continue;
      for (let i = 1; i < us.length; i++) us[i - 1].saida.connect(us[i].entrada);
      lg.removers.push(VbMxCadeia.inserir(l, ponto, { entrada: us[0].entrada, saida: us[us.length - 1].saida }));
    }
  }
}
function fxAplicarAudio() {
  if (!fx.nos) return;
  fxReligar();
  for (const l of VbMxFx.CANAIS) {
    fx.est.unidades.forEach((u, i) => {
      const ativa = VbMxFx.ativaNoCanal(u, l), envio = u.rota === "envio";
      fx.nos[l][i].aplicar(VbMxFx.efeitosEfetivos(u), ativa, envio);
      const e = fx.liga[l].envios[i];
      if (e) e.nivel.gain.setTargetAtTime(ativa ? u.nivelEnvio : 0, e.nivel.context.currentTime, 0.01);
    });
  }
}
function fxTempo() { if (fx.nos) for (const l of VbMxFx.CANAIS) for (const u of fx.nos[l]) u.tempo(); }

// ---------- estado → tela e áudio ----------
function fxMudar(novo, n, redesenhar) {
  fx.est = novo;
  fxAplicarAudio();
  if (redesenhar) fxDesenhar(n);
  else fxAtualizar(n);
  VbMxUI.emitir("fx:mudou", { unidade: n, estado: fxUnidade(n) });
}

// ---------- tela ----------
const fxM = VbMxFx;
function fxOpcoes(sel) { return fxM.TIPOS.map(t => `<option value="${t}"${t === sel ? " selected" : ""}>${fxM.NOMES[t]}</option>`).join(""); }
function fxKnob(id, rotulo, d, valor, tipo, indice) {
  const passo = d.inteiro ? 1 : d.bipolar ? 1 : 0.01;
  return `<label class="fx-knob" title="${rotulo}; duplo clique restaura o padrão">
    <span class="fx-nome">${rotulo}</span>
    <input type="range" min="${d.min}" max="${d.max}" step="${passo}" value="${valor}" data-fx-id="${id}" data-padrao="${d.padrao}" aria-label="${rotulo}">
    <span class="fx-val" data-fx-val="${id}">${tipo ? fxM.rotuloDoParametro(tipo, indice, valor) : Math.round(valor * 100) + "%"}</span></label>`;
}
function fxHtml(u) {
  const n = u.n, c = fxM.CANAIS;
  const cab = `<div class="fx-cab">
    <span class="fx-titulo">FX ${n}</span>
    <span class="fx-canais" role="group" aria-label="Atribuir a canais">${c.map(l => `<button type="button" class="fx-bt fx-canal" data-fx-canal="${l}" aria-pressed="${u.atribuicao[l]}" title="Unidade ${n} no canal ${l}">${l}</button>`).join("")}</span>
    <button type="button" class="fx-bt fx-rota" data-fx-rota aria-label="Rota: ${fxM.ROTULOS_ROTA[u.rota]}; clique para trocar" title="Rota: inserção (antes do fader) → pós-fader → envio (paralelo, só o processado)">${fxM.ROTULOS_ROTA[u.rota]}</button>${u.rota === "envio" ? fxKnob("nivel", "envio", { min: 0, max: 1, padrao: fxM.NIVEL_ENVIO_PADRAO }, u.nivelEnvio, "", -1) : ""}
    <button type="button" class="fx-bt fx-modo" data-fx-modo aria-label="Modo ${u.modo === "unico" ? "único" : "grupo"}; clique para trocar" title="${u.modo === "unico" ? "Modo único (1 efeito)" : "Modo grupo (3 efeitos)"}">${u.modo === "unico" ? "●" : "●●●"}</button>
    <button type="button" class="fx-bt fx-liga" data-fx-liga aria-pressed="${u.ligada}" title="Liga a unidade">ON</button></div>`;
  let corpo;
  if (u.modo === "unico") {
    const e = u.unico, def = fxM.DEFS[e.tipo];
    corpo = `<div class="fx-linha"><select data-fx-tipo aria-label="Efeito da unidade ${n}">${fxOpcoes(e.tipo)}</select>
      <label class="fx-knob fx-dw"><span class="fx-nome">D/W</span><input type="range" min="0" max="1" step="0.01" value="${e.dw}" data-fx-id="dw" data-padrao="${def.dw}" aria-label="Mistura seco/processado"><span class="fx-val" data-fx-val="dw">${Math.round(e.dw * 100)}%</span></label></div>
      <div class="fx-knobs">${def.params.map((d, i) => fxKnob("p" + i, d.rotulo, d, e.params[i], e.tipo, i)).join("")}</div>
      <div class="fx-linha">${def.botoes.map((r, i) => `<button type="button" class="fx-bt fx-botao" data-fx-botao="${i}" aria-pressed="${e.botoes[i]}">${r}</button>`).join("")}
      <button type="button" class="fx-bt" data-fx-reset title="Volta aos padrões do efeito">reset</button>
      <button type="button" class="fx-bt" data-fx-snap title="Guarda estes valores para a próxima vez que o efeito for escolhido">salvar</button></div>`;
  } else {
    corpo = `<div class="fx-grupo">${u.grupo.slots.map((s, i) => {
      const d = fxM.DEFS[s.tipo].params[0];
      return `<div class="fx-slot"><select data-fx-slot-tipo="${i}" aria-label="Efeito ${i + 1}">${fxOpcoes(s.tipo)}</select>
        ${fxKnob("s" + i, d.rotulo, d, s.valor, s.tipo, 0)}
        <button type="button" class="fx-bt" data-fx-slot-liga="${i}" aria-pressed="${s.ligado}">ON</button></div>`;
    }).join("")}</div>
    <div class="fx-linha"><label class="fx-knob fx-dw"><span class="fx-nome">D/W</span><input type="range" min="0" max="1" step="0.01" value="${u.grupo.dw}" data-fx-id="dw" data-padrao="0.5" aria-label="Mistura seco/processado da cadeia"><span class="fx-val" data-fx-val="dw">${Math.round(u.grupo.dw * 100)}%</span></label></div>`;
  }
  return `<div class="fx-un" data-fx-un="${n}">${cab}${corpo}</div>`;
}
function fxRaiz(n) { return VbMxUI.slot(`fx-${n}`); }
function fxDesenhar(n) {
  const el = fxRaiz(n); if (!el) return;
  if (typeof VbMxPecas !== "undefined") VbMxPecas.destruirEm(el);   // peças vestidas saem antes de reescrever o innerHTML
  el.innerHTML = fxHtml(fxUnidade(n));
  el.hidden = false; el.classList.add("fx");
  fxVestir(el);
}
// proposta B: cada parâmetro e o D/W viram knob (pele por cima; o input continua a fonte de verdade e o alvo dos ouvintes delegados)
function fxVestir(el) {
  if (typeof VbMxPecas === "undefined") return;
  for (const i of el.querySelectorAll(".fx-knob input[type=range]")) VbMxPecas.vestir(i, { fabrica: "knob", padrao: Number(i.dataset.padrao), tamPx: 34 });
}
// atualiza só o que mudou sem refazer (arrastar um knob não pode destruir o input em uso)
function fxAtualizar(n) {
  const el = fxRaiz(n), u = fxUnidade(n); if (!el) return;
  for (const b of el.querySelectorAll("[data-fx-canal]")) b.setAttribute("aria-pressed", String(u.atribuicao[b.dataset.fxCanal]));
  el.querySelector("[data-fx-liga]").setAttribute("aria-pressed", String(u.ligada));
  const tn = el.querySelector('[data-fx-val="nivel"]'); if (tn) tn.textContent = Math.round(u.nivelEnvio * 100) + "%";
  if (u.modo === "unico") {
    const e = u.unico;
    e.params.forEach((v, i) => { const t = el.querySelector(`[data-fx-val="p${i}"]`); if (t) t.textContent = fxM.rotuloDoParametro(e.tipo, i, v); });
    for (const b of el.querySelectorAll("[data-fx-botao]")) b.setAttribute("aria-pressed", String(e.botoes[b.dataset.fxBotao]));
    const t = el.querySelector('[data-fx-val="dw"]'); if (t) t.textContent = Math.round(e.dw * 100) + "%";
  } else {
    u.grupo.slots.forEach((s, i) => {
      const t = el.querySelector(`[data-fx-val="s${i}"]`); if (t) t.textContent = fxM.rotuloDoParametro(s.tipo, 0, s.valor);
      el.querySelector(`[data-fx-slot-liga="${i}"]`).setAttribute("aria-pressed", String(s.ligado));
    });
    const t = el.querySelector('[data-fx-val="dw"]'); if (t) t.textContent = Math.round(u.grupo.dw * 100) + "%";
  }
}
function fxSincronizarKnobs(n) {   // reflete no DOM valores que mudaram por baixo (reset, snapshot)
  const el = fxRaiz(n), u = fxUnidade(n); if (!el) return;
  const pos = (id, v) => { const i = el.querySelector(`[data-fx-id="${id}"]`); if (i) { i.value = v; if (i._peca) i._peca.definir(v, { silencioso: true }); } };
  if (u.modo === "unico") { u.unico.params.forEach((v, i) => pos("p" + i, v)); pos("dw", u.unico.dw); }
  else { u.grupo.slots.forEach((s, i) => pos("s" + i, s.valor)); pos("dw", u.grupo.dw); }
}

// ---------- ações ----------
function fxAoClicar(n, e) {
  const bt = e.target.closest("button"); if (!bt) return;
  const u = fxUnidade(n);
  if (bt.dataset.fxCanal) fxMudar(fxM.atribuir(fx.est, n, bt.dataset.fxCanal), n);
  else if ("fxLiga" in bt.dataset) fxMudar(fxM.ligar(fx.est, n), n);
  else if ("fxRota" in bt.dataset) fxMudar(fxM.proximaRota(fx.est, n), n, true);
  else if ("fxModo" in bt.dataset) fxMudar(fxM.trocarModo(fx.est, n, u.modo === "unico" ? "grupo" : "unico"), n, true);
  else if (bt.dataset.fxBotao !== undefined) fxMudar(fxM.alternarBotao(fx.est, n, Number(bt.dataset.fxBotao)), n);
  else if ("fxReset" in bt.dataset) { fxMudar(fxM.resetar(fx.est, n), n); fxSincronizarKnobs(n); }
  else if ("fxSnap" in bt.dataset) { fx.est = fxM.salvarSnapshot(fx.est, n); bt.textContent = "salvo"; setTimeout(() => { bt.textContent = "salvar"; }, 900); }
  else if (bt.dataset.fxSlotLiga !== undefined) fxMudar(fxM.ligarSlot(fx.est, n, Number(bt.dataset.fxSlotLiga)), n);
}
function fxAoMexer(n, e) {
  const i = e.target.closest("[data-fx-id]"); if (!i) return;
  const id = i.dataset.fxId, v = Number(i.value);
  if (id === "dw") fxMudar(fxM.definirDw(fx.est, n, v), n);
  else if (id === "nivel") fxMudar(fxM.definirNivelEnvio(fx.est, n, v), n);
  else if (id[0] === "p") fxMudar(fxM.definirParametro(fx.est, n, Number(id.slice(1)), v), n);
  else if (id[0] === "s") fxMudar(fxM.definirSlotValor(fx.est, n, Number(id.slice(1)), v), n);
  if (id === "dw" || id[0] === "p") fxTempo();
}
function fxAoTrocar(n, e) {
  const t = e.target;
  if ("fxTipo" in t.dataset) fxMudar(fxM.definirTipo(fx.est, n, t.value), n, true);
  else if (t.dataset.fxSlotTipo !== undefined) fxMudar(fxM.definirSlotTipo(fx.est, n, Number(t.dataset.fxSlotTipo), t.value), n, true);
}
function fxAoDuploClique(n, e) {
  const i = e.target.closest("[data-fx-id]"); if (!i) return;
  const id = i.dataset.fxId, p = Number(i.dataset.padrao);
  i.value = p;
  if (id === "dw") fxMudar(fxM.definirDw(fx.est, n, p), n);
  else if (id === "nivel") fxMudar(fxM.definirNivelEnvio(fx.est, n, p), n);
  else if (id[0] === "p") fxMudar(fxM.definirParametro(fx.est, n, Number(id.slice(1)), p), n);
  else if (id[0] === "s") fxMudar(fxM.resetarSlot(fx.est, n, Number(id.slice(1))), n);
}

VbMxUI.aoIniciar(() => {
  for (let n = 1; n <= fxM.UNIDADES; n++) {
    const el = fxRaiz(n); if (!el) continue;
    el.addEventListener("click", e => fxAoClicar(n, e));
    el.addEventListener("input", e => fxAoMexer(n, e));
    el.addEventListener("change", e => fxAoTrocar(n, e));
    el.addEventListener("dblclick", e => fxAoDuploClique(n, e));
    fxDesenhar(n);
  }
  fx.timer = setInterval(() => { fxLigarAoGrafo(); fxTempo(); }, 250);
});

// ---------- ações (teclado/MIDI) ----------
for (let n = 1; n <= VbMxFx.UNIDADES; n++) {
  const A = (nome, fn) => VbMxUI.registrar("acao", `fx${n}.${nome}`, fn);
  A("liga", () => fxMudar(fxM.ligar(fx.est, n), n));
  A("canalA", () => fxMudar(fxM.atribuir(fx.est, n, "A"), n));
  A("canalB", () => fxMudar(fxM.atribuir(fx.est, n, "B"), n));
  A("rota", () => fxMudar(fxM.proximaRota(fx.est, n), n, true));
  A("modo", () => fxMudar(fxM.trocarModo(fx.est, n, fxUnidade(n).modo === "unico" ? "grupo" : "unico"), n, true));
}

const VbMxFxUI = { definirObterBpm: fxDefinirObterBpm, estado: () => fx.est };
