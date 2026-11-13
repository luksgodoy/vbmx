function renderDeck(div, faixa, letra){
  const d = decks[letra];
  const efetivo = faixa ? VbMxPitch.bpmEfetivo(faixa.bpm, d.pitch, VbMxPitch.faixaDe(letra)) : null;
  const L = VbMxPitch.faixaDe(letra);
  if (typeof VbMxPecas !== "undefined") VbMxPecas.destruirEm(div);   // peças vestidas (pitch) saem antes do innerHTML
  div.innerHTML = `
    <div class="deck-cab">
      <span class="letra">${letra}</span>
      ${faixa ? `<span class="titulo">${esc(faixa.titulo)}</span><span class="artista">${esc(faixa.artista)}</span>`
              : `<span class="vazio">deck vazio · arraste uma faixa para cá</span>`}
      <button type="button" class="deck-recolher" data-recolher="mini-${letra}" aria-pressed="false" title="Recolher o deck ${letra} para o mini deck (uma linha); de novo para expandir" aria-label="Recolher ou expandir o deck ${letra} (mini deck)"></button>
    </div>
    <div class="ondas">
      <div class="onda-caixa"><canvas class="onda zoom" data-onda="zoom" aria-label="Onda do deck ${letra}, rolando com a faixa. Clique define o CUE; Shift+clique pula para o ponto"></canvas></div>
      <canvas class="onda geral" data-onda="geral" aria-label="Faixa inteira do deck ${letra}. Clique define o CUE; Shift+clique pula para o ponto"></canvas>
      <div class="dica-onda">clique na onda = define o CUE · Shift+clique = pula para ali · arraste = scratch · <span class="cue-info"></span></div>
    </div>
    <div class="deck-corpo">
      <div class="deck-prato">
        <div class="prato" aria-hidden="true" title="Prato: segure o centro e gire para fazer scratch · tocando, gire a borda para acelerar/frear (bend) · parado, gire para a busca fina">
          <div class="prato-giro"></div>
          ${faixa ? `<div class="prato-miolo" style="--cor:${corCamelot(faixa.camelot)}">${tomTexto(faixa.camelot)}</div>` : `<div class="prato-miolo vazio">—</div>`}
        </div>
        <div class="deck-info">
          <div class="dado"><span class="rotulo">BPM</span><span class="valor valor-bpm">${faixa?fmtBpm(efetivo):"—"}</span><span class="orig">${faixa&&d.pitch?`orig. ${fmtBpm(faixa.bpm)}`:""}</span></div>
          <div class="dado"><span class="rotulo">Tom</span>${faixa?chave(faixa.camelot):`<span class="valor">—</span>`}<span class="tom-res" hidden></span></div>
          <span class="tempo"></span>
          <div class="transporte"><button class="botao pc-botao pc-botao--cue pc-compacto" data-cue="${letra}" ${d.buffer?"":"disabled"} title="CUE: tocando, volta ao ponto de cue e para · parado fora dele, define o cue aqui · parado no cue, segure para ouvir e solte para voltar" aria-label="Cue do deck ${letra}">CUE</button><button class="botao pc-botao pc-botao--cue pc-compacto" data-cup="${letra}" ${d.buffer?"":"disabled"} title="CUP: segure para saltar ao ponto de cue; ao soltar, toca dali" aria-label="CUP do deck ${letra}">CUP</button><button class="botao pc-botao pc-botao--play pc-compacto ${tocandoDeck(letra)?"tocando":""}" data-play="${letra}" ${faixa?"":"disabled"} title="Tocar / pausar" aria-label="${tocandoDeck(letra)?"Pausar":"Tocar"} o deck ${letra}">${tocandoDeck(letra)?"❚❚":"▶"}</button><button class="botao pc-botao pc-botao--neutro pc-compacto" data-reverso="${letra}" ${d.buffer?"":"disabled"} aria-pressed="false" title="Reverso: toca de trás para frente enquanto estiver apertado; ao soltar, volta ao normal" aria-label="Reverso do deck ${letra}">REV</button><button class="botao sync pc-botao pc-botao--sync pc-compacto" data-sync="${letra}" ${faixa?"":"disabled"} title="Igualar o BPM deste deck ao do outro ajustando o pitch (até ±${L}%)">SYNC</button><button class="botao bend pc-botao pc-botao--neutro pc-compacto" data-bend="${letra}" data-sinal="-1" ${d.buffer?"":"disabled"} title="Tempo bend: segure para frear por um instante (corrige a fase)" aria-label="Bend do deck ${letra}, frear">◀</button><button class="botao bend pc-botao pc-botao--neutro pc-compacto" data-bend="${letra}" data-sinal="1" ${d.buffer?"":"disabled"} title="Tempo bend: segure para acelerar por um instante (corrige a fase)" aria-label="Bend do deck ${letra}, acelerar">▶</button><span class="medidor-fase mono" data-fase title="Fase contra o deck mestre, em batidas" aria-label="Fase do deck ${letra} contra o mestre, em batidas">—</span><button class="botao master pc-botao pc-botao--master pc-compacto" data-master="${letra}" aria-pressed="false" title="MASTER: este deck vira o tempo mestre (só um por vez)" aria-label="Deck ${letra} como tempo mestre">MASTER</button></div>
        </div>
      </div>
      <div class="pitch-v">
        <label class="rotulo" for="pitch-${letra}">Pitch</label>
        <span class="pitch-valor mono">${VbMxPitch.formatarPitch(d.pitch)}</span>
        <div class="pitch-corpo">
          <div class="marcas" aria-hidden="true"><span class="marca-pm">−${L}</span><span class="marca-pm">0</span><span class="marca-pm">+${L}</span></div>
          <input type="range" id="pitch-${letra}" min="-${L}" max="${L}" step="0.1" value="${d.pitch}" data-pitch="${letra}" aria-orientation="vertical" ${faixa?"":"disabled"} aria-label="Pitch do deck ${letra}, de −${L}% a +${L}%; para baixo aumenta o andamento, para cima diminui">
        </div>
        <span class="pitch-bpm mono">${faixa?`→ ${fmtBpm(efetivo)} BPM`:""}</span>
        <button class="zerar" data-zerar="${letra}" ${faixa?"":"disabled"} title="Pitch de volta a 0%">0</button>
        <button class="zerar keylock" data-keylock="${letra}" aria-pressed="${!!d.keyLock}" title="Key lock: ligado, o pitch muda o andamento sem mudar o tom" aria-label="Key lock do deck ${letra}">KEY LOCK</button>
        <div class="key-ctl" style="display:grid;justify-items:center;gap:2px">
          <input type="range" id="key-${letra}" min="-12" max="12" step="1" value="${d.semitons||0}" data-key="${letra}" style="writing-mode:horizontal-tb;direction:ltr;width:52px;height:auto" title="KEY: muda o tom em semitons sem mudar o andamento · duplo clique volta a 0" aria-label="KEY do deck ${letra}: tom em semitons, de −12 a +12, sem mudar o andamento; duplo clique volta a 0">
          <span class="key-valor mono" style="font-size:10px"></span>
        </div>
      </div>
    </div>
    <div class="carga-deck ${d.cargaCls}" role="status">${esc(d.carga)}</div>
    <div class="aviso-sync ${d.avisoCls}" role="status">${esc(d.aviso)}</div>`;
    div.querySelector("input[data-pitch]").addEventListener("input", e=>mudarPitch(letra, e.target.value));
  if (typeof VbMxPecas !== "undefined") VbMxPecas.vestir(div.querySelector("input[data-pitch]"), { fabrica: "fader", tipo: "pitch", orientacao: "vertical", invertido: true, padrao: 0, comprimento: 150, marcas: 9 });   // proposta B: pele por cima, o input fica por baixo
  div.querySelector("[data-zerar]").addEventListener("click", ()=>{ zerarDeck(letra); atualizarNumerosDoDeck(letra); });
  div.querySelector("[data-sync]").addEventListener("click", ()=>sincronizar(letra));
  div.querySelector("[data-master]").addEventListener("click", ()=>mestreAlternar(letra));
  div.querySelector("[data-keylock]").addEventListener("click", ()=>alternarKeyLock(letra));
  keyLockPintar(letra, div);
  const key = div.querySelector("input[data-key]");
  key.addEventListener("input", e=>mudarKey(letra, e.target.value));
  key.addEventListener("dblclick", ()=>mudarKey(letra, 0));
  if (typeof VbMxPecas !== "undefined") VbMxPecas.vestir(key, { fabrica: "knob", padrao: 0, tamPx: 30 });   // KEY: knob bipolar; duplo clique da peça volta ao padrão 0
  keyPintar(letra, div);
  div.querySelector("[data-play]").addEventListener("click", ()=>tocarPausar(letra));
  ligarCue(div.querySelector("[data-cue]"), letra);
  ligarSegurar(div.querySelector("[data-cup]"), letra, apertarCupDeck, soltarCupDeck);
  for (const bb of div.querySelectorAll("[data-bend]")) {
    const sinal = Number(bb.dataset.sinal);
    bb.addEventListener("pointerdown", e=>{ if (e.button!==0) return; try { bb.setPointerCapture(e.pointerId); } catch(_){} syncBendApertar(letra, sinal); });
    for (const ev of ["pointerup","pointercancel","lostpointercapture","blur"]) bb.addEventListener(ev, ()=>syncBendSoltar(letra));
  }
  ligarSegurar(div.querySelector("[data-reverso]"), letra, apertarReversoDeck, soltarReversoDeck);
  for (const cv of div.querySelectorAll("canvas.onda")) cv.addEventListener("pointerdown", e=>aoClicarNaOnda(letra, cv.dataset.onda, e));
  if (typeof scratchLigarPrato === "function") scratchLigarPrato(div.querySelector(".prato"), letra);   // VB-57: scratch, bend e busca fina
  div.classList.toggle("rodando", tocandoDeck(letra));
  if (faixa) pintarTomResultante(div, faixa, d);
  pintarPosicao(letra);
  mestrePintarBotao(letra);
  if (typeof dispAplicar === "function") dispAplicar();
}
// Key lock (VB-21): por deck, padrão desligado, atravessa a troca de faixa. Ligado, o pitch muda o
// andamento e não o tom (VbMxTocador passa a tocar pelo worklet de time-stretch); o tom
// resultante e a sugestão (relida no deck:pitch) passam a usar o tom da faixa.
function alternarKeyLock(letra){
  const d = decks[letra], pedido = !d.keyLock;
  d.keyLock = pedido;
  garantirAudio();   // é um clique: pode criar o AudioContext, e o worklet já começa a carregar
  VbMxTocador.definirKeyLock(letra, pedido).then(r=>{
    if (r.ok || d.keyLock !== pedido) return;
    d.keyLock = false; VbMxTocador.definirKeyLock(letra, false);
    d.aviso = `KEY LOCK indisponível: ${r.motivo}`; d.avisoCls = "erro";
    keyLockPintar(letra); atualizarNumerosDoDeck(letra);
  });
  keyLockPintar(letra);
  atualizarNumerosDoDeck(letra);   // tom resultante + deck:pitch
}
function keyLockPintar(letra, div){
  const raizDeck = div || document.querySelector(`[data-deck="${letra}"]`);
  const el = raizDeck && raizDeck.querySelector("[data-keylock]");
  if (!el) return;
  const d = decks[letra], ligado = !!d.keyLock;
  // VB-38: em modo scratch fora de −30%…+50% o key lock fica ligado mas solto (o tom segue o tempo)
  const solto = ligado && !VbMxTom.keyLockAtivo(true, VbMxPrefs.ler("deck.keylock-modo"), 1 + (d.pitch || 0) / 100);
  el.setAttribute("aria-pressed", String(ligado));
  el.style.color = ligado ? "var(--acento)" : "";
  el.style.borderColor = ligado ? "var(--acento)" : "";
  el.style.borderStyle = solto ? "dashed" : "";
  el.title = solto ? "Key lock ligado, mas solto: no modo scratch ele não vale abaixo de −30% nem acima de +50% de velocidade"
    : "Key lock: ligado, o pitch muda o andamento sem mudar o tom";
}

// ---------------- VB-38: modo do key lock (preferência) e knob KEY ----------------
// Modo "normal": o key lock vale em toda a faixa de velocidade; "scratch": solta abaixo de −30% e acima de
// +50% (motor/tom.js keyLockAtivo; o tocador aplica no worklet). O KEY muda o tom em semitons (±12) sem
// mudar o andamento (VbMxTocador.definirSemitons); duplo clique volta a 0. O tom exibido e o da sugestão
// usam os dois (opcoesDoTom).
VbMxPrefs.declarar("deck.keylock-modo", "normal", { tipo: "opcao", modulo: "deck", rotulo: "Modo do key lock",
  opcoes: [{ valor: "normal", rotulo: "normal (vale em toda a faixa de tempo)" }, { valor: "scratch", rotulo: "scratch (solta abaixo de −30% e acima de +50%)" }] });
VbMxUI.aoIniciar(()=>{
  VbMxTocador.definirModoKeyLock(VbMxPrefs.ler("deck.keylock-modo"));
  VbMxPrefs.ouvir("deck.keylock-modo", modo=>{
    VbMxTocador.definirModoKeyLock(modo);
    for (const l of ["A","B"]) { keyLockPintar(l); if (faixaDoDeck(l)) atualizarNumerosDoDeck(l); }
  });
});
// Opções do motor/tom.js para o tom resultante deste deck (tela e sugestão).
function opcoesDoTom(d){
  return { keyLock: !!d.keyLock, modo: VbMxPrefs.ler("deck.keylock-modo"), semitons: d.semitons || 0 };
}
function mudarKey(letra, valor){
  const d = decks[letra], st = VbMxTom.limitarKey(Number(valor));
  if ((d.semitons || 0) === st) { keyPintar(letra); return; }
  d.semitons = st;
  garantirAudio();   // é um gesto: pode criar o AudioContext e começar a carregar o worklet
  VbMxTocador.definirSemitons(letra, st).then(r=>{
    if (r.ok || d.semitons !== st || st === 0) return;
    d.semitons = 0; VbMxTocador.definirSemitons(letra, 0);
    d.aviso = `KEY indisponível: ${r.motivo}`; d.avisoCls = "erro";
    keyPintar(letra); atualizarNumerosDoDeck(letra);
  });
  keyPintar(letra);
  atualizarNumerosDoDeck(letra);   // tom resultante + deck:pitch (a sugestão relê)
}
function keyPintar(letra, div){
  const raizDeck = div || document.querySelector(`[data-deck="${letra}"]`);
  if (!raizDeck) return;
  const st = decks[letra].semitons || 0, inp = raizDeck.querySelector("input[data-key]"), txt = raizDeck.querySelector(".key-valor");
  if (inp && Number(inp.value) !== st) { inp.value = st; if (inp._peca) inp._peca.definir(st, { silencioso: true }); }
  if (txt) { txt.textContent = `KEY ${st > 0 ? "+" : st < 0 ? "−" : ""}${Math.abs(st)} st`; txt.style.color = st ? "var(--acento)" : ""; }
}

