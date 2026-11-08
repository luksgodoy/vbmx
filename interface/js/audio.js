// ===================== ÁUDIO (Web Audio) =====================
// O AudioContext nasce no primeiro gesto (soltar faixa / play) com latencyHint 0 (decisão do VB-01).
// O grafo (fonte → gain → EQ → filtro → fx → fader → crossfader → master) é de VbMxCadeia
// (js/cadeia.js) e quem toca é VbMxTocador (js/tocador.js): este arquivo só os liga ao estado da
// página. Contrato: docs/contratos.md.
let ctxAudio = null;
function garantirAudio(){
  if (ctxAudio) return ctxAudio;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctxAudio = new AC({ latencyHint: 0 });
  VbMxCadeia.montar(ctxAudio);
  VbMxTocador.configurar({ ctx: ctxAudio, destino: l=>VbMxCadeia.entradaDoCanal(l), aoTerminar: aoTerminarFaixa });
  if (typeof VbMxStems !== "undefined") VbMxStems.configurar({ ctx: ctxAudio, destino: l=>VbMxCadeia.entradaDoCanal(l), tocador: VbMxTocador });
  aplicarMixerAoAudio();
  return ctxAudio;
}
function aplicarMixerAoAudio(){ VbMxCadeia.aplicarMixer(mixer); }
function agoraCtx(){ return ctxAudio ? ctxAudio.currentTime : 0; }
function aoTerminarFaixa(letra){
  atualizarTransporte(letra);
  VbMxUI.emitir("deck:fim", { letra, faixa: decks[letra].faixa });
}
// Pitch → velocidade de reprodução (playbackRate = 1 + pitch/100), com a posição preservada.
// bpmEfetivo do evento = BPM da GRADE × taxa (VB-20): é o que o SYNC iguala, sem o arredondamento
// de 0,1 do BPM da análise.
function aplicarTaxa(letra){
  const d = decks[letra], taxa = VbMxReproducao.taxaDoPitch(d.pitch, VbMxPitch.faixaDe(letra));
  VbMxTocador.definirTaxa(letra, taxa);
  VbMxUI.emitir("deck:pitch", { letra, pitch: d.pitch, taxa, bpmEfetivo: syncBpmEfetivo(letra) });
}
function descarregarDeck(letra){
  VbMxTocador.descarregar(letra);
  const d = decks[letra]; d.token += 1;
  Object.assign(d, { faixa: null, pitch: 0, sync: false, aviso: "", avisoCls: "", buffer: null, carga: "", cargaCls: "", picos: null, cue: 0, previa: false, cacheGeral: null });
  VbMxUI.emitir("deck:descarregado", { letra });
}
