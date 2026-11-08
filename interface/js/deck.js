// Seleção por clique: só guia as sugestões, não carrega deck nenhum.
function selecionar(id){
  const nova = BIBLIOTECA.find(f=>f.id===id);
  if (!nova || nova.analisavel===false) return;
  atual = nova; filtroCasa = null;
  renderBiblio(); renderSugestao(); atualizarEstadoGlobal();
  VbMxUI.emitir("selecao:mudou", { faixa: atual });
}
// Soltar/“A”/“B”: carrega SÓ aquele deck e decodifica o arquivo; a faixa vira a referência do motor.
async function carregarNoDeck(letra, id){
  const nova = BIBLIOTECA.find(f=>f.id===id);
  if (!nova || nova.analisavel===false) {
    const d0 = decks[letra];
    d0.carga = nova ? `faixa sem análise não carrega: ${nova.erro || "não analisada"}` : "faixa não está mais na biblioteca (a lista mudou); arraste de novo";
    d0.cargaCls = "erro"; atualizarTransporte(letra); return;
  }
  const recusa = VbMxUI.motivoParaNaoCarregar(letra, nova);   // guardas registradas (ex.: trava de carga no ar)
  if (recusa) { decks[letra].carga = recusa; decks[letra].cargaCls = "erro"; atualizarTransporte(letra); return; }
  VbMxTocador.carregar(letra, null);
  const d = decks[letra], meu = ++d.token;
  Object.assign(d, { faixa: nova, pitch: 0, sync: false, aviso: "", avisoCls: "", buffer: null, cupApertado: false, reverso: false,
    picos: null, cue: cuesPorFaixa.get(chaveCue(nova)) || 0, previa: false, cacheGeral: null });
  syncSoltar(letra==="A" ? "B" : "A", `o deck ${letra} trocou de faixa`);   // o seguidor não muda de andamento sozinho
  if (atual!==nova) { atual = nova; VbMxUI.emitir("selecao:mudou", { faixa: atual }); }
  filtroCasa = null;
  if (typeof nova.obter !== "function") {
    d.carga = ehExemplo ? "sem áudio (faixa de exemplo)" : `erro: esta faixa não tem acesso ao arquivo${MODULO_VELHO ? " — " + AVISO_MODULO : " (recarregue a pasta)"}`;
    d.cargaCls = "erro"; renderTudo(); return;
  }
  d.carga = "carregando…"; d.cargaCls = "";
  renderTudo();
  try {
    const ctx = garantirAudio();
    if (!ctx) throw new Error("este navegador não tem Web Audio");
    const arq = await nova.obter();
    const buf = await ctx.decodeAudioData(await arq.arrayBuffer());
    if (meu!==d.token) return;
    d.buffer = buf; d.picos = VbMxWaveform.picosDoBuffer(buf);   // picos uma vez só, na carga; o quadro só lê
    d.cue = VbMxWaveform.travarCue(d.cue, buf.duration); d.cacheGeral = null;
    VbMxTocador.carregar(letra, buf); VbMxTocador.buscar(letra, d.cue);   // a cabeça nasce no cue
    d.carga = `pronto · ${VbMxReproducao.formatarTempo(buf.duration)}`; d.cargaCls = "ok";
  } catch(e){
    if (meu!==d.token) return;
    d.carga = `erro ao carregar: ${(e && e.message) || e}`; d.cargaCls = "erro";
  }
  atualizarNumerosDoDeck(letra);   // aplica a taxa e já mostra o BPM da grade (o que o SYNC usa)
  atualizarTransporte(letra);
  if (d.buffer) VbMxUI.emitir("deck:carregado", { letra, faixa: nova, duracao: d.buffer.duration });
}
function tocarPausar(letra){
  const d = decks[letra];
  if (!d.faixa) return;
  if (!d.buffer) { atualizarTransporte(letra); return; }   // exemplo, carregando ou erro: a linha de estado já diz
  if (d.previa) { d.previa = false; atualizarTransporte(letra); return; }   // ▶ durante a prévia do CUE: segue tocando ao soltar
  const ctx = garantirAudio();
  if (!ctx) { d.carga = "erro: este navegador não tem Web Audio"; d.cargaCls = "erro"; atualizarTransporte(letra); return; }
  if (ctx.state !== "running") {                         // dentro do gesto do clique; se o navegador negar, a tela diz
    ctx.resume().then(()=>{ if (ctx.state!=="running") avisoSaida(letra, "o navegador não liberou o áudio (clique de novo na página)"); },
                      e=>avisoSaida(letra, `o navegador recusou iniciar o áudio: ${(e && e.message) || e}`));
  }
  if (tocandoDeck(letra)) {
    VbMxTocador.pausar(letra);
    VbMxUI.emitir("deck:pausou", { letra, faixa: d.faixa, posicao: VbMxTocador.posicao(letra) });
  } else {
    VbMxTocador.tocar(letra);
    if (atual!==d.faixa) {   // quem tocou por último guia as sugestões
      atual = d.faixa; filtroCasa = null; renderBiblio(); renderSugestao();
      VbMxUI.emitir("selecao:mudou", { faixa: atual });
    }
    VbMxUI.emitir("deck:tocou", { letra, faixa: d.faixa, posicao: VbMxTocador.posicao(letra) });
  }
  atualizarTransporte(letra);
}
function avisoSaida(letra, texto){
  const d = decks[letra]; d.carga = `erro: ${texto}`; d.cargaCls = "erro"; atualizarTransporte(letra);
}
// CUE clássico (regra em docs/decisoes.md, 2026-10-25): tocando → volta ao cue e para; parado fora do
// cue → define o cue aqui; parado no cue → segure para ouvir (prévia), solte para voltar.
function apertarCueDeck(letra){
  const d = decks[letra];
  if (!d.buffer) return;
  const ctx = garantirAudio(); if (!ctx) return;
  const cueAntes = d.cue;
  const r = VbMxWaveform.apertarCue(VbMxTocador.estado(letra), d.cue, ctx.currentTime);
  d.cue = r.cue !== cueAntes ? syncPonto(letra, r.cue) : r.cue; guardarCue(d);   // SNAP: cue novo cai na batida
  if (r.acao === "voltar") { VbMxTocador.pausar(letra); VbMxTocador.buscar(letra, r.cue); d.previa = false; }
  else if (r.acao === "previa") {
    if (ctx.state !== "running") ctx.resume().catch(()=>{});
    VbMxTocador.buscar(letra, r.cue); VbMxTocador.tocar(letra); d.previa = true;
  }
  if (d.cue !== cueAntes) VbMxUI.emitir("deck:cue", { letra, faixa: d.faixa, cue: d.cue });
  atualizarTransporte(letra);
}
function soltarCueDeck(letra){
  const d = decks[letra];
  if (!d.previa) return;
  d.previa = false;
  const r = VbMxWaveform.soltarCue(VbMxTocador.estado(letra), d.cue, true);
  if (r.acao === "voltar") { VbMxTocador.pausar(letra); VbMxTocador.buscar(letra, r.rep.posicao); }
  atualizarTransporte(letra);
}
function ligarCue(btn, letra){
  btn.addEventListener("pointerdown", e=>{ if (e.button!==0) return; try { btn.setPointerCapture(e.pointerId); } catch(_){} apertarCueDeck(letra); });
  for (const ev of ["pointerup","pointercancel","lostpointercapture"]) btn.addEventListener(ev, ()=>soltarCueDeck(letra));
  btn.addEventListener("keydown", e=>{ if ((e.key==="Enter"||e.key===" ") && !e.repeat) { e.preventDefault(); apertarCueDeck(letra); } });
  btn.addEventListener("keyup", e=>{ if (e.key==="Enter"||e.key===" ") soltarCueDeck(letra); });
}
// CUP (VB-37, spec §1): apertar salta ao cue e fica parado; soltar toca dali.
function apertarCupDeck(letra){
  const d = decks[letra];
  if (!d.buffer || d.cupApertado) return;
  const ctx = garantirAudio(); if (!ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(()=>{});
  const eraTocando = tocandoDeck(letra);
  d.cupApertado = true; d.previa = false;
  VbMxTocador.apertarCup(letra, d.cue);
  if (eraTocando) VbMxUI.emitir("deck:pausou", { letra, faixa: d.faixa, posicao: VbMxTocador.posicao(letra) });
  atualizarTransporte(letra); emitirPosicao(letra);
}
function soltarCupDeck(letra){
  const d = decks[letra];
  if (!d.cupApertado) return;
  d.cupApertado = false;
  VbMxTocador.soltarCup(letra);
  if (tocandoDeck(letra)) {
    if (atual!==d.faixa) { atual = d.faixa; filtroCasa = null; renderBiblio(); renderSugestao(); VbMxUI.emitir("selecao:mudou", { faixa: atual }); }
    VbMxUI.emitir("deck:tocou", { letra, faixa: d.faixa, posicao: VbMxTocador.posicao(letra) });
  }
  atualizarTransporte(letra);
}
// Reverso (VB-37, spec §1): toca de trás para frente enquanto o botão está apertado.
function apertarReversoDeck(letra){
  const d = decks[letra];
  if (!d.buffer || d.reverso) return;
  const ctx = garantirAudio(); if (!ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(()=>{});
  d.reverso = true; d.previa = false;
  VbMxTocador.definirReverso(letra, true);
  atualizarTransporte(letra);
}
function soltarReversoDeck(letra){
  const d = decks[letra];
  if (!d.reverso) return;
  d.reverso = false;
  VbMxTocador.definirReverso(letra, false);
  atualizarTransporte(letra);
  emitirPosicao(letra);
}
// botão de segurar: ponteiro (com captura, para soltar fora do botão também vale) e teclado
function ligarSegurar(btn, letra, apertar, soltar){
  btn.addEventListener("pointerdown", e=>{ if (e.button!==0) return; try { btn.setPointerCapture(e.pointerId); } catch(_){} apertar(letra); });
  for (const ev of ["pointerup","pointercancel","lostpointercapture"]) btn.addEventListener(ev, ()=>soltar(letra));
  btn.addEventListener("keydown", e=>{ if ((e.key==="Enter"||e.key===" ") && !e.repeat) { e.preventDefault(); apertar(letra); } });
  btn.addEventListener("keyup", e=>{ if (e.key==="Enter"||e.key===" ") soltar(letra); });
  btn.addEventListener("blur", ()=>soltar(letra));
}
// Clique na onda (zoom ou visão geral): define o CUE; com Shift, pula para o ponto.
function aoClicarNaOnda(letra, qual, ev){
  const d = decks[letra];
  if (!d.buffer || ev.button>0) return;
  const cv = ev.currentTarget, rc = cv.getBoundingClientRect(), x = ev.clientX - rc.left, agora = agoraCtx();
  const e = VbMxTocador.estado(letra), cueAntes = d.cue;
  // o zoom está desenhado em torno da posição da TELA (o que soa): o clique se lê na mesma posição
  const t = qual==="geral" ? VbMxWaveform.colunaParaTempo(x, e.duracao, rc.width)
                           : VbMxWaveform.tempoNoZoom(x, VbMxTocador.posicaoNaTela(letra), rc.width, VbMxWaveform.JANELA_SEG);
  const r = VbMxWaveform.cliqueNaOnda(e, d.cue, agora, t, ev.shiftKey);
  d.cue = r.cue !== cueAntes ? syncPonto(letra, r.cue) : r.cue; guardarCue(d);   // SNAP
  if (r.rep !== e) VbMxTocador.buscar(letra, d.cue !== cueAntes && !e.tocando ? d.cue : syncDestino(letra, r.rep.posicao));   // seek, ou cue com o deck parado (a cabeça acompanha)
  if (d.cue !== cueAntes) VbMxUI.emitir("deck:cue", { letra, faixa: d.faixa, cue: d.cue });
  atualizarTransporte(letra);
  if (r.rep !== e) emitirPosicao(letra);
}
// Define o CUE em `t` (VB-55: Shift+clique na faixa inteira). Como o clique na onda: o SNAP ajusta o ponto e,
// com o deck parado, a cabeça acompanha; tocando, segue tocando.
function definirCueNoTempo(letra, t){
  const d = decks[letra];
  if (!d.buffer) return;
  const e = VbMxTocador.estado(letra), cueAntes = d.cue;
  d.cue = syncPonto(letra, VbMxWaveform.travarCue(t, e.duracao)); guardarCue(d);
  if (!e.tocando) VbMxTocador.buscar(letra, d.cue);
  if (d.cue !== cueAntes) VbMxUI.emitir("deck:cue", { letra, faixa: d.faixa, cue: d.cue });
  atualizarTransporte(letra); emitirPosicao(letra);
}
// Botões, tempo e prato de um deck + a faixa “Tocando:” do topo.
let rafId = 0;
function atualizarTransporte(letra){
  const div = document.querySelector(`[data-deck="${letra}"]`), d = decks[letra], tocando = tocandoDeck(letra);
  if (div) {
    div.classList.toggle("rodando", tocando);
    const play = div.querySelector("[data-play]");
    if (play) { play.textContent = tocando ? "❚❚" : "▶"; play.classList.toggle("tocando", tocando); play.setAttribute("aria-label", tocando ? `Pausar o deck ${letra}` : `Tocar o deck ${letra}`); }
    const bc = div.querySelector("[data-cue]");
    if (bc) { bc.disabled = !d.buffer; bc.classList.toggle("cue-ativo", d.previa); }
    const bp = div.querySelector("[data-cup]");
    if (bp) { bp.disabled = !d.buffer; bp.classList.toggle("cue-ativo", !!d.cupApertado); }
    const br = div.querySelector("[data-reverso]");
    if (br) { br.disabled = !d.buffer; br.classList.toggle("cue-ativo", !!d.reverso); br.setAttribute("aria-pressed", String(!!d.reverso)); }
    if (typeof syncBendPintar === "function") syncBendPintar(letra);   // ◀ ▶ do bend: habilitam quando o buffer chega (sync.js)
    const c = div.querySelector(".carga-deck");
    if (c) { c.textContent = d.carga; c.className = `carga-deck ${d.cargaCls}`; }
    pintarPosicao(letra);
  }
  atualizarEstadoGlobal();
  if (!rafId && (tocandoDeck("A") || tocandoDeck("B"))) rafId = requestAnimationFrame(quadro);
}
// A tela mostra o que SOA (VbMxTocador.posicaoNaTela: o instante ouvido, já sem a latência de saída) — a cabeça, a
// grade e os cues caem no bumbo que se ouve, não ~20 ms adiante dele. Comando e SYNC usam posicao/estado.
function pintarPosicao(letra){
  const div = document.querySelector(`[data-deck="${letra}"]`), d = decks[letra];
  if (!div) return;
  const pos = VbMxTocador.posicaoNaTela(letra);
  const giro = div.querySelector(".prato-giro"); if (giro) giro.style.transform = `rotate(${VbMxReproducao.anguloDoPrato(pos)}deg)`;
  pintarOndas(div, d, pos);
  const t = div.querySelector(".tempo"); if (t) t.textContent = d.buffer ? `${VbMxReproducao.formatarTempo(pos)} / ${VbMxReproducao.formatarTempo(VbMxTocador.estado(letra).duracao)}` : "";
}
function quadro(){
  rafId = 0;
  for (const l of ["A","B"]) if (tocandoDeck(l)) { pintarPosicao(l); emitirPosicao(l); }
  if (tocandoDeck("A") || tocandoDeck("B")) rafId = requestAnimationFrame(quadro);
}
function emitirPosicao(letra){
  const e = VbMxTocador.estado(letra);
  VbMxUI.emitir("deck:posicao", { letra, posicao: e.posicao, duracao: e.duracao, tocando: e.tocando });
}
function atualizarEstadoGlobal(){
  const tocando = ["A","B"].filter(l=>tocandoDeck(l) && decks[l].faixa);
  document.getElementById("estado-tocando").textContent = tocando.length
    ? tocando.map(l=>`${l}: ${decks[l].faixa.titulo}`).join(" · ")
    : "—";
}
// Pitch mexido na mão: atualiza os números do próprio deck sem redesenhar (o arrasto do
// controle não pode perder o elemento).
function mudarPitch(letra, valor){
  decks[letra].pitch = VbMxPitch.limitarPitch(Number(valor), VbMxPitch.faixaDe(letra));
  if (decks[letra].sync) { syncReaplicar(letra); return; }   // VB-56: o seguidor continua em SYNC; o pitch volta ao que iguala o mestre (sync.js)
  decks[letra].aviso = ""; decks[letra].avisoCls = "";
  atualizarNumerosDoDeck(letra);
}
// Tom resultante (VB-12): o tom depois do pitch, com o desvio em semitons e cents. Só aparece quando o
// pitch muda o tom; com key lock (VB-21, d.keyLock) o tom não mexe e some. VB-38: soma o KEY e respeita o
// modo do key lock (opcoesDoTom, js/deck-tela.js).
function pintarTomResultante(div, faixa, d){
  const el = div.querySelector(".tom-res"); if (!el) return;
  const tom = VbMxTom.tomEfetivo(faixa.camelot, d.pitch, opcoesDoTom(d));
  const mostrar = !!tom && (tom.mudou || tom.cents !== 0 || tom.deslocamento !== 0);
  el.hidden = !mostrar;
  if (!mostrar) { el.innerHTML = ""; return; }
  el.innerHTML = `${chave(tom.camelot)}<span class="tom-desvio">${VbMxTom.formatarDesvio(tom)}</span>`;
  el.title = `Tom resultante com o pitch e o KEY (${tomTexto(tom.original)} → ${tomTexto(tom.camelot)}): a sugestão usa este tom`;
}
function atualizarNumerosDoDeck(letra){
  aplicarTaxa(letra);
  const div = document.querySelector(`[data-deck="${letra}"]`);
  const faixa = faixaDoDeck(letra), d = decks[letra];
  if (!div || !faixa) return;
  // BPM da grade (VB-20): o mesmo número que o SYNC iguala; sem grade analisada é o da análise
  const base = VbMxFase.bpmDaFaixa(faixa), efetivo = VbMxPitch.bpmEfetivo(base, d.pitch, VbMxPitch.faixaDe(letra));
  div.querySelector(".valor-bpm").textContent = fmtBpm(efetivo);
  pintarTomResultante(div, faixa, d);
  keyLockPintar(letra, div);   // VB-38: em scratch o key lock solta conforme o pitch
  div.querySelector(".orig").textContent = d.pitch ? `orig. ${fmtBpm(base)}` : "";
  const bs = div.querySelector("[data-sync]");
  if (bs) { bs.classList.toggle("tocando", !!d.sync); bs.setAttribute("aria-pressed", String(!!d.sync)); }
  div.querySelector(".pitch-valor").textContent = VbMxPitch.formatarPitch(d.pitch);
  div.querySelector(".pitch-bpm").textContent = `→ ${fmtBpm(efetivo)} BPM`;
  const range = div.querySelector("input[data-pitch]");
  if (range && Number(range.value)!==d.pitch) { range.value = d.pitch; if (range._peca) range._peca.definir(d.pitch, { silencioso: true }); }
  const av = div.querySelector(".aviso-sync");
  av.textContent = d.aviso; av.className = `aviso-sync ${d.avisoCls}`;
}
// SYNC (VB-20): iguala o BPM efetivo deste deck ao do líder pela GRADE (motor/fase.js sobre
// motor/pitch.js; considera dobro/metade) — o outro deck, ou o relógio quando ele é o mestre declarado
// (js/mestre.js) —, leva a batida 1 do compasso à do líder se os dois tocam (VB-56) e liga o sync: este
// deck segue o líder (andamento e fase, js/sync.js) até apertar SYNC no outro deck ou trocar a faixa;
// mexer no pitch não o solta. Fora da faixa do pitch do deck (±8/±15/±50) não aplica, avisa e desliga.
// O aviso nomeia o líder de verdade (o relógio não é "o deck B"): interface/testar-mestre.js.
function sincronizar(letra){
  const outra = letra==="A" ? "B" : "A";
  const d = decks[letra];
  // Toggle: SYNC já aceso → apertar de novo só desliga (syncSoltar mantém pitch, mestre, quantização e faixa do pitch).
  if (d.sync) { syncSoltar(letra, "apertado de novo (o pitch fica onde está)"); return; }
  if (!faixaDoDeck(letra)) { d.aviso = "SYNC: este deck está vazio"; d.avisoCls = "erro"; atualizarNumerosDoDeck(letra); return; }
  if (!faixaDoDeck(outra)) {
    d.aviso = `SYNC: o deck ${outra} está vazio — arraste uma faixa para ele`; d.avisoCls = "erro";
    atualizarNumerosDoDeck(letra); return;
  }
  mestreAoSincronizar(letra);   // VB-35: o líder do SYNC vira o mestre (AUTO) e o mestre nunca segue
  decks[outra].sync = false;   // um líder só: quem apertou SYNC segue o outro (antes de mexer no pitch)
  syncPintarBotao(outra);
  const r = syncAplicar(letra);
  if (!r.ok) { d.sync = false; d.aviso = `SYNC com ${syncLider(letra) === "relogio" ? `o relógio (${fmtBpm(mestreBpm())} BPM)` : `o deck ${outra}`} não aplicado: ${r.motivo}`; d.avisoCls = "erro"; atualizarNumerosDoDeck(letra); return; }
  d.sync = true;
  const fase = syncAlinharFase(letra);
  const ms = fase ? Math.round(Math.abs(fase.erro.relogio) * 1000) : 0;
  const peloRelogio = syncLider(letra) === "relogio";   // o relógio sempre "toca": a fase alinha no play deste deck
  d.aviso = `SYNC com ${peloRelogio ? "o relógio" : outra}: pitch ${VbMxPitch.formatarPitch(r.pitch)} → ${fmtBpm(r.bpmResultante)} BPM${r.fator!==1 ? ` (${r.razao} ${peloRelogio ? "do relógio" : `do deck ${outra}`})` : ""}`
    + (fase ? ` · fase alinhada (estava ${ms} ms ${fase.erro.relogio > 0 ? "adiantado" : "atrasado"})`
            : (peloRelogio || tocandoDeck(outra) ? " · a fase alinha ao dar play" : ""));
  d.avisoCls = "ok";
  atualizarNumerosDoDeck(letra);
}

// ---------- ações (teclado/MIDI), VB-48 ----------
// "Pressionar": sem argumento ou true aperta; false solta. Os mesmos nomes que o teclado.js registrava.
for (const l of ["A", "B"]) {
  VbMxUI.registrar("acao", `deck${l}.play`, () => tocarPausar(l));
  VbMxUI.registrar("acao", `deck${l}.cue`, (v) => (v === false ? soltarCueDeck(l) : apertarCueDeck(l)));
  VbMxUI.registrar("acao", `deck${l}.cup`, (v) => (v === false ? soltarCupDeck(l) : apertarCupDeck(l)));
  VbMxUI.registrar("acao", `deck${l}.reverso`, (v) => (v === false ? soltarReversoDeck(l) : apertarReversoDeck(l)));
}
