// ===================== VbMxUI: barramento de eventos e registros (VB-11) =====================
// PRIMEIRO script da página (logo depois de motor/ e biblioteca/): todo módulo de js/ pode usar
// VbMxUI no próprio carregamento. Contrato completo: docs/contratos.md. Testado em Node por
// interface/testar-contratos.js. Na onda 1 este arquivo é intocável: evento novo se declara com
// `declararEvento`, no módulo que o emite.
//
// Eventos (emitir(evento, dados) / ouvir(evento, fn) → fn para desligar):
//   deck:carregado   {letra, faixa, duracao}        a faixa decodificou e está pronta no deck
//   deck:descarregado {letra}                       o deck esvaziou (troca de biblioteca)
//   deck:tocou       {letra, faixa, posicao}
//   deck:pausou      {letra, faixa, posicao}
//   deck:posicao     {letra, posicao, duracao, tocando}   a cada quadro com o deck tocando, e a cada busca
//   deck:fim         {letra, faixa}                 a faixa acabou sozinha
//   deck:pitch       {letra, pitch, taxa, bpmEfetivo}
//   deck:cue         {letra, faixa, cue}            o cue principal mudou
//   mixer:mudou      {mixer, canal, controle, valor}   canal "A"|"B"|null (crossfader: null)
//   biblioteca:mudou {faixas, ehExemplo}
//   selecao:mudou    {faixa}                        a faixa que guia a sugestão (`atual`) mudou
//   ar:faixa         {letra, faixa, desde}          a faixa entrou no ar (regra P10; quem emite é o VB-18)
//
// Registros (registrar(tipo, …); registrados(tipo) devolve a lista na ordem de registro):
//   registrar('card-acao', {id, rotulo, titulo?, fazer(faixa)})   botão extra nos cards da sugestão
//                                                                 e nas linhas da biblioteca
//   registrar('acao', nome, fn)            ação nomeada ("deckA.play", "mixer.xfade"); acao(nome, …args)
//   registrar('camada-onda', fn(c, deck, janela))   desenha por cima das ondas, a cada quadro:
//        c      = {g, w, h, dpr, qual: "zoom"|"geral"}  (g = CanvasRenderingContext2D)
//        deck   = {letra, d, pos}      (d = decks[letra], pos = s da faixa agora)
//        janela = {inicio, fim, x(t)}  s da faixa visíveis e a coluna (px do canvas) de um tempo
//   registrar('guarda-carga', fn(letra, faixa) → motivo | null)   pode recusar carregar um deck
//                                                                 (o motivo aparece na linha de estado)
// Página:
//   slot(nome)        o elemento [data-slot=nome] (null fora do navegador ou se não existir)
//   aoIniciar(fn)     roda fn no boot (principal.js chama iniciar() depois de renderTudo); se o boot
//                     já passou, roda na hora. É aqui que um módulo mexe no DOM pela 1ª vez.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const EVENTOS = new Set(['deck:carregado', 'deck:descarregado', 'deck:tocou', 'deck:pausou', 'deck:posicao',
    'deck:fim', 'deck:pitch', 'deck:cue', 'mixer:mudou', 'biblioteca:mudou', 'selecao:mudou', 'ar:faixa']);
  const TIPOS = new Set(['card-acao', 'acao', 'camada-onda', 'guarda-carga']);
  const ouvintes = new Map();
  const registros = new Map([...TIPOS].map(t => [t, []]));
  const acoes = new Map();
  const noBoot = [];
  let iniciado = false;

  function relatar(onde, e) { if (raiz.console) raiz.console.error(`VbMxUI: ${onde} falhou:`, e); }
  function conferirEvento(ev) { if (!EVENTOS.has(ev)) throw new Error(`VbMxUI: evento desconhecido "${ev}" (declare com declararEvento)`); }

  function declararEvento(ev) {
    if (typeof ev !== 'string' || !/^[a-z]+:[a-z-]+$/.test(ev)) throw new Error(`VbMxUI: nome de evento inválido "${ev}" (use área:nome)`);
    EVENTOS.add(ev);
  }
  function ouvir(ev, fn) {
    conferirEvento(ev);
    if (typeof fn !== 'function') throw new Error(`VbMxUI.ouvir("${ev}"): fn não é função`);
    if (!ouvintes.has(ev)) ouvintes.set(ev, []);
    ouvintes.get(ev).push(fn);
    return () => { const l = ouvintes.get(ev); const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  }
  // Síncrono, na ordem de inscrição; um ouvinte que quebra não derruba os outros nem quem emitiu.
  function emitir(ev, dados) {
    conferirEvento(ev);
    for (const fn of [...(ouvintes.get(ev) || [])]) { try { fn(dados); } catch (e) { relatar(`ouvinte de ${ev}`, e); } }
  }

  function registrar(tipo, a, b) {
    if (!TIPOS.has(tipo)) throw new Error(`VbMxUI.registrar: tipo desconhecido "${tipo}"`);
    if (tipo === 'acao') {
      if (typeof a !== 'string' || typeof b !== 'function') throw new Error('VbMxUI.registrar("acao", nome, fn)');
      if (acoes.has(a)) throw new Error(`VbMxUI: ação "${a}" já registrada`);
      acoes.set(a, b); registros.get('acao').push(a); return;
    }
    if (tipo === 'card-acao') {
      if (!a || typeof a.id !== 'string' || typeof a.rotulo !== 'string' || typeof a.fazer !== 'function') throw new Error('VbMxUI.registrar("card-acao", {id, rotulo, fazer})');
      if (registros.get(tipo).some(x => x.id === a.id)) throw new Error(`VbMxUI: card-acao "${a.id}" já registrada`);
      registros.get(tipo).push(a); return;
    }
    if (typeof a !== 'function') throw new Error(`VbMxUI.registrar("${tipo}", fn)`);
    registros.get(tipo).push(a);
  }
  function registrados(tipo) {
    if (!TIPOS.has(tipo)) throw new Error(`VbMxUI.registrados: tipo desconhecido "${tipo}"`);
    return [...registros.get(tipo)];
  }
  function acao(nome, ...args) {
    const fn = acoes.get(nome);
    if (!fn) throw new Error(`VbMxUI: ação desconhecida "${nome}"`);
    return fn(...args);
  }
  // Primeiro motivo de recusa de carga, ou null. Uma guarda que quebra não trava a carga.
  function motivoParaNaoCarregar(letra, faixa) {
    for (const fn of registros.get('guarda-carga')) {
      try { const m = fn(letra, faixa); if (m) return String(m); } catch (e) { relatar('guarda-carga', e); }
    }
    return null;
  }
  // Chamado por ondas.js depois de desenhar cada canvas. Uma camada que quebra não apaga a onda.
  function desenharCamadas(c, deck, janela) {
    for (const fn of registros.get('camada-onda')) {
      try { c.g.save(); fn(c, deck, janela); } catch (e) { relatar('camada-onda', e); } finally { c.g.restore(); }
    }
  }

  function slot(nome) {
    const doc = raiz.document;
    return doc ? doc.querySelector(`[data-slot="${nome}"]`) : null;
  }
  function aoIniciar(fn) {
    if (typeof fn !== 'function') throw new Error('VbMxUI.aoIniciar(fn)');
    if (iniciado) { try { fn(); } catch (e) { relatar('aoIniciar', e); } } else noBoot.push(fn);
  }
  function iniciar() {
    if (iniciado) return;
    iniciado = true;
    for (const fn of noBoot.splice(0)) { try { fn(); } catch (e) { relatar('aoIniciar', e); } }
  }

  return { eventos: () => [...EVENTOS], declararEvento, ouvir, emitir, registrar, registrados, acao,
    motivoParaNaoCarregar, desenharCamadas, slot, aoIniciar, iniciar };
});
