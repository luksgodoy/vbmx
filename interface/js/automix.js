// ===================== automix.js — mixagem automática no Profissional (modo opcional, 2026-11-14) =====================
// Desligada (o padrão, e não é lembrada entre recargas): este arquivo não toca em deck, mixer nem árvore — o modo manual
// fica como era. Ligada (botão "Auto" no cabeçalho da biblioteca, na vista de árvore): escolhe a próxima faixa, carrega
// no deck livre e faz a transição operando os controles que o DJ já tem — pitch do deck que entra, play e crossfader.
// Nada de áudio novo: a regra é a do Friends (motor/automix.js → VbMxAutomix), agora com CRITÉRIOS marcáveis:
//   automix.criterio-bpm | -tom | -pitch | -estilo   (booleanas, padrão: todas marcadas)
// A árvore de caminhos (js/arvore-vista.js) passa a ser montada por esses critérios: só os marcados filtram/ordenam, e os
// desmarcados continuam desenhados, tracejados, no ponto em que entrariam, com o que mudariam (amxArvore abaixo).
//
// O ciclo (amxDecidir é a decisão PURA, testada em Node por interface/testar-automix-classico.js; amxTick a executa):
//   ninguém tocando → espera · os dois tocando sem ser transição minha → a mixagem é do DJ · deck livre vazio, com a
//   faixa que já saiu ou com erro → escolher e carregar · próxima pronta (minha ou posta à mão) → planejar · chegou
//   ANTECEDENCIA_S antes do ponto → próxima entra muda (crossfader inteiro no lado de quem toca), já na posição e no
//   pitch do plano · durante o cruzamento o crossfader segue o progresso · no fim a antiga pausa e o ciclo recomeça.
// O ganho de cada lado é o do crossfader do mixer (curva escolhida lá), não a curva do plano; canal fora do crossfader
// (lado "–") faz o modo esperar e dizer por quê.
const AMX_CRITERIOS = ["bpm", "tom", "pitch", "estilo"];
const AMX_ROTULOS = { bpm: "BPM", get tom() { return tr("pro.amx.tom"); }, pitch: "Pitch", get estilo() { return tr("pro.amx.estilo"); } };
const AMX_DICAS = {  // getters: o texto segue o idioma ativo
  get bpm() { return tr("pro.amx.dica-bpm"); },
  get tom() { return tr("pro.amx.dica-tom"); },
  get pitch() { return tr("pro.amx.dica-pitch"); },
  get estilo() { return tr("pro.amx.dica-estilo"); }
};
const AMX_TICK_MS = 50, AMX_MAX_FALHAS = 4;
for (const k of AMX_CRITERIOS) {
  VbMxPrefs.declarar(`automix.criterio-${k}`, true, { tipo: "booleano", modulo: "automix", rotulo: `pro.pref.amx-crit-${k}` });
}

const amx = { ligado: false, timer: null, baseId: null, plano: null, planoPara: "", mixando: null, carregando: false,
  escolha: null, tocadas: [], puladas: [], falhas: 0, status: "", replanejou: false };

function amxLigado() { return amx.ligado; }
function amxCriterios() { const o = {}; for (const k of AMX_CRITERIOS) o[k] = VbMxPrefs.ler(`automix.criterio-${k}`) !== false; return o; }
function amxOutra(letra) { return letra === "A" ? "B" : "A"; }
function amxTempo(s) { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; }

// ---------- decisão pura ----------
// v = { base: {letra, id, posicao, taxa} | null, outra: {id, pronto, tocando, carregando, erro, foraDoXfade},
//       baseForaDoXfade, mixando: {de, para, progresso, deTocando, paraTocando} | null, plano: {inicioMix} | null,
//       planoVale, tocadas: [ids], antecedencia }
function amxDecidir(v) {
  if (v.mixando) {
    const m = v.mixando;
    if (!m.paraTocando) return { acao: "abandonar", status: tr("pro.amx.st-interrompida") };
    if (!m.deTocando || m.progresso >= 1) return { acao: "concluir", status: tr("pro.amx.st-concluida") };
    return { acao: "seguir", status: `mixando ${m.de} → ${m.para} · ${Math.round(m.progresso * 100)}%` };
  }
  if (!v.base) return { acao: "esperar", status: tr("pro.amx.st-play") };
  const o = v.outra;
  if (o.tocando) return { acao: "esperar", status: tr("pro.amx.st-dois") };
  if (v.baseForaDoXfade || o.foraDoXfade) return { acao: "esperar", status: tr("pro.amx.st-fora-xfade") };
  if (o.carregando) return { acao: "esperar", status: tr("pro.amx.st-abrindo") };
  if (o.id == null || o.id === v.base.id || (v.tocadas || []).includes(o.id)) return { acao: "escolher", status: tr("pro.amx.st-escolhendo") };
  if (o.erro || !o.pronto) return { acao: "escolher", pular: o.id, status: tr("pro.amx.st-nao-abriu") };
  if (!v.plano || !v.planoVale) return { acao: "planejar", status: tr("pro.amx.st-planejando") };
  const falta = (v.plano.inicioMix - v.base.posicao) / v.base.taxa;
  if (falta <= v.antecedencia) return { acao: "iniciar", status: tr("pro.amx.st-entrando") };
  return { acao: "aguardar", falta, status: "" };
}

// ---------- a árvore pelos critérios ----------
// O que a vista da árvore pede (js/arvore-vista.js): a avaliação de `faixa` (a base, com o tom efetivo, ou a candidata)
// no formato do motor, mais o resumo por critério para a fileira de nós.
function amxAvaliar(faixa, taxa, limite, tocadas) {
  return VbMxAutomix.avaliar(faixa, BIBLIOTECA, { criterios: amxCriterios(), taxaAtual: taxa, limitePitch: limite, tocadas });
}
function amxRelacoes() { return VbMxArvore.RELACOES.concat([VbMxAutomix.RELACAO_FORA]); }
function amxCriteriosHTML(resumo, H) {
  const pos = VbMxArvore.posicoesCriterios(AMX_CRITERIOS, H);
  const nos = pos.nos.map(n => {
    const r = resumo[n.id] || { marcado: true, texto: "" };
    return `<div class="no-crit${r.marcado ? "" : " fora"}" data-crit="${n.id}" style="left:${n.x}px;top:${n.y}px;width:${n.l}px;height:${n.a}px" title="${esc(r.texto)}" aria-label="${esc(r.texto)}">
      <span class="crit-nome">${AMX_ROTULOS[n.id]}</span><span class="crit-n mono">${r.marcado ? (n.id === "estilo" ? tr("pro.amx.ordem") : `−${r.corta}`) : (n.id === "estilo" ? `~${r.corta}` : `(−${r.corta})`)}</span></div>`;
  }).join("");
  const fora = AMX_CRITERIOS.filter(k => resumo[k] && !resumo[k].marcado);
  const legenda = `<span class="crit-legenda" style="left:${pos.nos[0].x}px;top:${pos.y - 15}px">${tr("pro.amx.legenda")}${fora.length ? ` · ${tr("pro.amx.tracejado")}` : ""}</span>`;
  return { nos: nos + legenda, caminho: `<path class="lig crit" d="${pos.caminho}"/>` };
}
// Etiqueta do nó que só entra porque um critério está desmarcado ("sairia se BPM estivesse marcado: …").
function amxSairiaHTML(c) {
  if (!c.sairiaCom || !c.sairiaCom.length) return { classe: "", dica: "", etiqueta: "" };
  const dica = c.sairiaCom.map(k => tr("pro.amx.sairia",{k:AMX_ROTULOS[k],r:c.razoes[k]})).join("; ");
  return { classe: " sairia", dica: ` · ${dica}`, etiqueta: `<span class="no-sairia mono" aria-hidden="true">${c.sairiaCom.map(k => AMX_ROTULOS[k][0]).join("")}</span>` };
}

// ---------- barra (dentro da vista de árvore) ----------
function amxBotaoHTML() {
  return `<button type="button" class="alternador" id="amx-ligar" aria-pressed="${amx.ligado}" title="${amx.ligado ? tr("pro.amx.desligar-t") : tr("pro.amx.ligar-t")}">${tr("pro.amx.auto")}</button>`;
}
function amxBarraHTML() {
  if (!amx.ligado) return "";
  const cr = amxCriterios();
  return `<div class="amx-barra" id="amx-barra">
    <span class="amx-titulo">${tr("pro.amx.titulo")}</span>
    <span class="amx-criterios" role="group" aria-label="${tr("pro.amx.criterios-aria")}">
      ${AMX_CRITERIOS.map(k => `<label class="amx-crit" title="${esc(AMX_DICAS[k])}"><input type="checkbox" data-amx-criterio="${k}"${cr[k] ? " checked" : ""}> ${AMX_ROTULOS[k]}</label>`).join("")}
    </span>
    <button type="button" class="alternador" id="amx-outra" title="${tr("pro.amx.outra-t")}">${tr("pro.amx.outra")}</button>
    <button type="button" class="alternador" id="amx-agora" title="${tr("pro.amx.agora-t")}">${tr("pro.amx.agora")}</button>
    <span class="amx-status" id="amx-status" role="status" aria-live="polite">${esc(amx.status)}</span>
  </div>`;
}
function amxStatus(texto) {
  if (texto === amx.status) return;
  amx.status = texto;
  const el = document.getElementById("amx-status");
  if (el) el.textContent = texto;
}
function amxRedesenhar() { if (typeof arvvAtualizar === "function") arvvAtualizar(true); }

// ---------- execução ----------
function amxBibliotecaTocavel() { return BIBLIOTECA.filter(f => typeof f.obter === "function"); }
function amxRef(base) { return Object.assign({}, base.faixa, { camelot: arvvEfetiva(base).camelot }); }   // tom efetivo (pitch sem key lock)
function amxTaxa(letra) { const e = VbMxTocador.estado(letra); return e.taxa > 0 ? e.taxa : 1; }
function amxJaTocadas() { return [...new Set(arvvHistoricoIds().concat(amx.tocadas))]; }

// A faixa que a mixagem automática vai tocar a seguir (a do deck livre, se parado e já com faixa) — a árvore a destaca.
function amxProximaId(base) {
  if (!amx.ligado || !base || amx.mixando) return null;
  const outra = amxOutra(base.letra), d = decks[outra];
  return d.faixa && !tocandoDeck(outra) && d.faixa.id !== base.faixa.id ? d.faixa.id : null;
}
// O que, do estado deste módulo, muda o desenho da árvore (entra na assinatura da vista).
function amxAssinatura(base) {
  const cr = amxCriterios();
  return `${AMX_CRITERIOS.map(k => (cr[k] ? 1 : 0)).join("")}|${amxProximaId(base)}|${amx.tocadas.join(",")}|${base ? amxTaxa(base.letra).toFixed(3) : ""}`;
}

function amxVisao() {
  const base = amx.mixando ? null : arvvBase();
  let mixando = null;
  if (amx.mixando) {
    const m = amx.mixando, e = VbMxTocador.estado(m.de);
    mixando = { de: m.de, para: m.para, deTocando: tocandoDeck(m.de), paraTocando: tocandoDeck(m.para),
      progresso: VbMxAutomix.progresso(m.plano, e.posicao, e.taxa > 0 ? e.taxa : 1) };
  }
  if (!base) return { base: null, mixando };
  const outra = amxOutra(base.letra), d = decks[outra], e = VbMxTocador.estado(base.letra);
  return { mixando,
    base: { letra: base.letra, id: base.faixa.id, posicao: e.posicao, taxa: e.taxa > 0 ? e.taxa : 1 },
    outra: { id: d.faixa ? d.faixa.id : null, pronto: !!d.buffer, tocando: tocandoDeck(outra), carregando: amx.carregando || d.carga === "carregando…",
      erro: d.cargaCls === "erro", foraDoXfade: mixer[outra].lado === "off" },
    baseForaDoXfade: mixer[base.letra].lado === "off",
    plano: amx.plano, planoVale: !!d.faixa && amx.planoPara === `${base.faixa.id}>${d.faixa.id}`,
    tocadas: amx.tocadas, antecedencia: VbMxAutomix.ANTECEDENCIA_S };
}

function amxEscolher(base, pular) {
  if (pular != null && !amx.puladas.includes(pular)) { amx.puladas.push(pular); amx.falhas += 1; }
  if (amx.falhas >= AMX_MAX_FALHAS) { amxStatus(tr("pro.amx.st-falhas",{n:amx.falhas,l:amxOutra(base.letra)})); return; }
  const lib = amxBibliotecaTocavel();
  if (!lib.length) { amxStatus(tr("pro.amx.st-sem-audio")); return; }
  const outra = amxOutra(base.letra);
  const r = VbMxAutomix.escolherProxima(amxRef(base), lib, { criterios: amxCriterios(), tocadas: amxJaTocadas(), excluir: amx.puladas,
    taxaAtual: amxTaxa(base.letra), limitePitch: VbMxPitch.faixaDe(outra) });
  if (!r.faixa) { amxStatus(trm(r.motivo)); return; }
  if (r.reiniciar) amx.tocadas = [base.faixa.id];
  amx.escolha = r; amx.carregando = true; amx.plano = null;
  amxStatus(tr("pro.amx.st-abrindo-deck",{l:outra,t:r.faixa.titulo}));
  Promise.resolve(carregarNoDeck(outra, r.faixa.id)).catch(() => {}).then(() => { amx.carregando = false; amxRedesenhar(); });
}

function amxPlanejar(base, aPartirDe) {
  const outra = amxOutra(base.letra), d = decks[outra], dB = decks[base.letra];
  amx.plano = VbMxAutomix.planejarTransicao({ atual: base.faixa, duracaoAtual: dB.buffer.duration, taxaAtual: amxTaxa(base.letra),
    proxima: d.faixa, duracaoProxima: d.buffer.duration, limitePitch: VbMxPitch.faixaDe(outra), criterios: amxCriterios(), aPartirDe });
  amx.planoPara = `${base.faixa.id}>${d.faixa.id}`;
  amx.falhas = 0;
}

function amxIniciar(base) {
  const outra = amxOutra(base.letra), e = VbMxTocador.estado(base.letra), taxa = e.taxa > 0 ? e.taxa : 1;
  if (e.posicao > amx.plano.inicioMix + 1e-3) {   // ligado tarde ou o laço atrasou: o próximo compasso possível
    if (amx.plano.sincroniza && !amx.replanejou) { amx.replanejou = true; amxPlanejar(base, e.posicao + VbMxAutomix.ANTECEDENCIA_S * taxa); return; }
    amx.plano = Object.assign({}, amx.plano, { inicioMix: e.posicao, duracaoMix: Math.min(amx.plano.duracaoMix, Math.max(0.5, (e.duracao - e.posicao) / taxa)) });
  }
  amx.replanejou = false;
  const plano = amx.plano;
  if (plano.sincroniza) mudarPitch(outra, plano.pitchProxima);   // pitch desmarcado: o plano não sincroniza e o pitch fica onde está
  VbMxTocador.buscar(outra, Math.max(0, VbMxAutomix.posicaoDaProxima(plano, e.posicao, taxa)));
  mixerCancelarFade();
  mixerDefinir(null, "xfade", base.letra === "A" ? -100 : 100);   // a próxima entra muda
  amx.mixando = { de: base.letra, para: outra, plano, deId: base.faixa.id, xfade: null };
  tocarPausar(outra);
  amxRedesenhar();
}

function amxSeguir(progresso) {
  const m = amx.mixando, v = Math.round(m.de === "A" ? -100 + 200 * progresso : 100 - 200 * progresso);
  if (v === m.xfade) return;
  m.xfade = v;
  mixerDefinir(null, "xfade", v);
}

function amxConcluir() {
  const m = amx.mixando;
  amxSeguir(1);
  if (tocandoDeck(m.de)) tocarPausar(m.de);
  if (!amx.tocadas.includes(m.deId)) amx.tocadas.push(m.deId);
  amx.mixando = null; amx.plano = null; amx.planoPara = ""; amx.puladas = []; amx.escolha = null;
  amxRedesenhar();
}

function amxTick() {
  if (!amx.ligado) return;
  const v = amxVisao(), r = amxDecidir(v);
  if (r.acao === "seguir") amxSeguir(v.mixando.progresso);
  else if (r.acao === "concluir") amxConcluir();
  else if (r.acao === "abandonar") { amx.mixando = null; amx.plano = null; amx.planoPara = ""; }
  if (v.mixando || !v.base) { amxStatus(r.status); return; }
  const base = arvvBase();
  if (amx.baseId !== base.faixa.id) { amx.baseId = base.faixa.id; amx.puladas = []; amx.falhas = 0; amx.replanejou = false; }
  if (r.acao === "escolher") { amxEscolher(base, r.pular); return; }
  if (r.acao === "planejar") { amxPlanejar(base); amxRedesenhar(); return; }
  if (r.acao === "iniciar") { amxIniciar(base); return; }
  if (r.acao === "aguardar") {
    const d = decks[amxOutra(base.letra)], minha = amx.escolha && d.faixa && amx.escolha.faixa.id === d.faixa.id;
    amxStatus(tr(minha ? "pro.amx.st-proxima" : "pro.amx.st-proxima-mao",{t:d.faixa.titulo,l:amxOutra(base.letra),tempo:amxTempo(r.falta)}) + ` · ${trm(amx.plano.motivo)}${minha ? ` · ${trm(amx.escolha.motivo)}` : ""}`);
    return;
  }
  amxStatus(r.status);
}

function amxLigar(ligado) {
  amx.ligado = !!ligado;
  if (amx.timer) { clearInterval(amx.timer); amx.timer = null; }
  Object.assign(amx, { baseId: null, plano: null, planoPara: "", mixando: null, carregando: false, escolha: null, puladas: [], falhas: 0, replanejou: false, status: "" });
  if (amx.ligado) { amx.timer = setInterval(amxTick, AMX_TICK_MS); amxTick(); }
  if (typeof renderBiblio === "function") renderBiblio();   // o botão do cabeçalho e a barra mudam
}
function amxOutraSugestao() {
  const base = !amx.mixando && arvvBase();
  if (!base) return;
  const d = decks[amxOutra(base.letra)];
  if (tocandoDeck(amxOutra(base.letra))) return;
  amx.falhas = 0;
  if (d.faixa && !amx.puladas.includes(d.faixa.id)) amx.puladas.push(d.faixa.id);
  amxEscolher(base, null);
}
function amxMixarAgora() {
  const base = !amx.mixando && arvvBase();
  if (!base || !amx.plano) return;
  const e = VbMxTocador.estado(base.letra), taxa = e.taxa > 0 ? e.taxa : 1;
  amxPlanejar(base, e.posicao + VbMxAutomix.ANTECEDENCIA_S * taxa);
  amx.replanejou = true;
  amxTick();
}

VbMxUI.aoIniciar(() => {
  const div = document.getElementById("biblio");
  div.addEventListener("click", e => {
    const alvo = e.target.closest && e.target.closest("#amx-ligar,#amx-outra,#amx-agora");
    if (!alvo) return;
    e.stopPropagation();
    if (alvo.id === "amx-ligar") amxLigar(!amx.ligado);
    else if (alvo.id === "amx-outra") amxOutraSugestao();
    else amxMixarAgora();
  });
  div.addEventListener("change", e => {
    const k = e.target && e.target.dataset ? e.target.dataset.amxCriterio : null;
    if (!k || !AMX_CRITERIOS.includes(k)) return;
    VbMxPrefs.gravar(`automix.criterio-${k}`, !!e.target.checked);
  });
  for (const k of AMX_CRITERIOS) VbMxPrefs.ouvir(`automix.criterio-${k}`, () => { amx.plano = null; amx.planoPara = ""; amxRedesenhar(); });
  VbMxUI.registrar("acao", "automix.alternar", () => amxLigar(!amx.ligado));
});
if (typeof module !== "undefined") module.exports = { amxDecidir, amxTempo, AMX_CRITERIOS, AMX_ROTULOS };
if (typeof VbMxUI !== "undefined") VbMxUI.aoIdioma(() => { amx.status = ""; if (typeof amxRedesenhar === "function") amxRedesenhar(); });
