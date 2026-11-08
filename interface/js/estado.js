// ===================== CORES POR CASA =====================
// 12 matizes na roda; A (menor) um pouco mais escuro que B (maior), mesma matiz.
function corCamelot(tom){
  const n = parseInt(tom,10), letra = tom.slice(-1);
  const h = ((n-1)*30 + 100) % 360;
  return letra==="A" ? `hsl(${h} 55% 52%)` : `hsl(${h} 70% 68%)`;
}
const CASAS = [];
for (let i=1;i<=12;i++) for (const l of ["A","B"]) CASAS.push(i+l);

// ===================== ESTADO =====================
let atual = BIBLIOTECA.find(f=>f.titulo==="Maré Baixa");
let filtroCasa = null;     // casa Camelot escolhida na roda, ou null
let rodaAberta = false;

// Decks: cada um recebe a faixa ARRASTADA para ele (ou pelos botões A/B da faixa). `atual` é a
// faixa de REFERÊNCIA do motor: o que o clique seleciona, ou a última carregada/tocada num deck.
// Pitch em % (−15 … +15, motor/pitch.js); `aviso` é o que o SYNC disse por último.
// O transporte (tocando, posição, taxa, loop) NÃO mora aqui: é de VbMxTocador (js/tocador.js, VB-11);
// leia com tocandoDeck(letra), VbMxTocador.posicao(letra) e VbMxTocador.estado(letra).
function deckNovo(){ return { faixa: null, pitch: 0, aviso: "", avisoCls: "", buffer: null, carga: "", cargaCls: "",
  token: 0, picos: null, cue: 0, previa: false, cacheGeral: null }; }
function tocandoDeck(letra){ return VbMxTocador.estado(letra).tocando; }
// CUE por faixa, só em memória durante a sessão (persistência em disco ficou de fora, de propósito).
const cuesPorFaixa = new Map();
function chaveCue(f){ return `${f.id}|${f.caminho||""}`; }
function guardarCue(d){ if (d.faixa) cuesPorFaixa.set(chaveCue(d.faixa), d.cue); }
const decks = { A: deckNovo(), B: deckNovo() };
function faixaDoDeck(letra){ return decks[letra].faixa; }
function bpmEfetivoDeck(letra){ const f = faixaDoDeck(letra); return f ? VbMxPitch.bpmEfetivo(f.bpm, decks[letra].pitch, VbMxPitch.faixaDe(letra)) : null; }
function zerarDeck(letra){ decks[letra].pitch = 0; decks[letra].aviso = ""; decks[letra].avisoCls = ""; aplicarTaxa(letra); }

