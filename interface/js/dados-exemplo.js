// ===================== DADOS FICTÍCIOS =====================
// 40 faixas inventadas: título, artista, BPM, tom Camelot. Nenhuma é da biblioteca real.
// O campo `camelot` é o que o motor lê.
const FAIXAS = [
  ["Maré Baixa","Dona Sereia",124,"8A"],["Ponte Aérea","Trio Volt",126,"9A"],["Café Preto","Lira & Lima",122,"7A"],
  ["Noite de Sexta","Bando Pixel",128,"8B"],["Vento Norte","Clara Onda",125,"8A"],["Rua 12","Os Terminais",118,"6A"],
  ["Girassol","Nina Vale",120,"12A"],["Primeiro Trem","DJ Horta",121,"1A"],["Zero Hora","Mares Altos",124,"11A"],
  ["Lanterna","Kiko Bruma",62,"8A"],["Asfalto Molhado","Coletivo Faro",130,"9B"],["Último Bonde","Sr. Cardume",126,"7B"],
  ["Caipira Noturno","Fábio Som",174,"8A"],["Jardim de Inverno","Lúcia Norte",124,"3A"],["Quarteirão","Bloco 9",127,"8A"],
  ["Seiva","Mina Terra",122,"9A"],["Pouso","Avoar",86,"8A"],["Céu de Chumbo","Trovão Mudo",138,"10A"],
  ["Labirinto","Pedra & Pó",124,"8B"],["Trégua","Dueto Sal",119,"7A"],["Pista Molhada","Rita Faísca",128,"1A"],
  ["Doze Badaladas","Relógio Torto",123,"12A"],["Alvorada","Serena B.",116,"5A"],["Marola","Tubo & Cia",125,"12B"],
  ["Feira Livre","Barraca Sonora",132,"2A"],["Contramão","Gui Sinal",124,"6B"],["Cais","Beira-Rio",120,"1B"],
  ["Verão Tardio","Pérola Negra",126,"9A"],["Garagem 4","Óleo Quente",140,"4A"],["Lua Cheia","Marília Vento",63,"9A"],
  ["Nó Cego","Trama",124,"7A"],["Horizonte","Ponto Final",100,"8A"],["Brasa","Carvão Vivo",127,"8A"],
  ["Linha 3","Metrô Fantasma",125,"7B"],["Sopro","Ana Flauta",110,"11B"],["Madrugada Suja","Bar do Zé",129,"8B"],
  ["Pedra de Sal","Ilha Nua",121,"8A"],["Compasso","Dois Pontos",134,"10B"],["Varanda","Cadeira de Balanço",96,"3B"],
  ["Rolê","Esquina Viva",124,"5B"]
].map((f,i)=>({id:i+1,titulo:f[0],artista:f[1],bpm:f[2],camelot:f[3]}));

// Biblioteca em uso: os exemplos acima até o usuário indicar uma pasta; depois, a real (VB-07).
let BIBLIOTECA = FAIXAS;
let ehExemplo = true;
// biblioteca.js que o navegador guardou em cache de uma versão antiga (sem `obter`) deixa as faixas
// reais mudas, e a tela diria "exemplo". Confere no carregamento e fala (causa do VB-09, 2026-10-25).
const MODULO_VELHO = (()=>{
  try {
    const t = VbMxBiblioteca.paraMotor([{ item: { nome: "a - b.mp3", caminho: "x", obter(){} }, resultado: { analisavel: true, bpm: 120, camelot: "8A" } }], 1)[0];
    return typeof t.obter !== "function";
  } catch(_){ return true; }
})();
const AVISO_MODULO = "biblioteca.js desatualizado no cache do navegador: as faixas das pastas não tocam. Recarregue com Cmd+Shift+R (ou sirva com servir.py).";

