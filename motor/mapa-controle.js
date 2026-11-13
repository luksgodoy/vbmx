// ===================== VbMxMapaControle — mapa de controle: tecla/MIDI → ação de VbMxUI =====================
// VB-25 + VB-40. Lógica pura (UMD), testada em Node por motor/testar-mapa-controle.js. Sem modificadores
// M1–M8 (decisão do Lucas, 2026-10-26). Spec: docs/especificacao-comportamento.md §9.
//
// Modelo: mapeamento {id, nome, ativo, atribuicoes[]}; vários ficam ativos ao mesmo tempo. Atribuição =
//   {id, fisico:{tipo:'nota'|'cc'|'tecla', canal?, numero? | codigo?}, comando, alvo:'A'|'B'|null,
//    tipo:'botao'|'fader'|'encoder', modo, opcoes}
// O estado de interação de cada atribuição (est) é um objeto simples devolvido a cada chamada, nunca mutado.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMapaControle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TIPOS = ['botao', 'fader', 'encoder'];
  const MODOS_BOTAO = ['hold', 'toggle', 'invert', 'direct'];       // hold é o padrão
  const MODOS_FADER = ['direct', 'relative'];
  const CODIFICACOES = ['7f01', '3f41'];                            // 7Fh/01h (−1/+1) e 3Fh/41h (−1/+1 em torno de 40h)
  const FORMATO = 'vbmx-mapa-controle';
  const VERSAO = 1;
  const TOLERANCIA_TOMADA = 0.03;                                    // soft takeover: distância (0–1) que conta como "pegou"

  // ---------------------------------------------------------------- tabela de comandos
  // tipoAcao: 'gatilho' = a ação roda uma vez por acionamento (play, sync, loop…); 'pressionar' = a ação
  // recebe (true) ao apertar e (false) ao soltar (cue, cup, hotcue, reverso); 'booleano' = recebe o valor
  // lógico (kill); 'valor' = recebe o valor do parâmetro na faixa dele (volume, EQ, crossfader); 'delta' = encoder
  // relativo que manda o giro com sinal, sem faixa nem valor atual (jog: passos de 1/128 de volta, VB-57/58).
  // alvo: 'deck' (A/B) · 'canal' (mixer do canal A/B) · 'global'. nome = nome da ação em VbMxUI sem o prefixo.
  const TAMANHOS_LOOP = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
  function rotuloTamanho(n) { return n < 1 ? '1/' + Math.round(1 / n) : String(n); }
  function nomeTamanho(n) { return n < 1 ? '1_' + Math.round(1 / n) : String(n); }

  const COMANDOS = [];
  const C = (o) => COMANDOS.push(Object.freeze(Object.assign({ tipos: ['botao'], tipoAcao: 'gatilho' }, o)));
  C({ id: 'play', rotulo: 'Play/Pausa', alvo: 'deck', nome: 'play', temEstado: true });
  C({ id: 'cue', rotulo: 'CUE', alvo: 'deck', nome: 'cue', tipoAcao: 'pressionar' });
  C({ id: 'cup', rotulo: 'CUP', alvo: 'deck', nome: 'cup', tipoAcao: 'pressionar' });
  C({ id: 'reverso', rotulo: 'Reverso', alvo: 'deck', nome: 'reverso', tipoAcao: 'pressionar' });
  C({ id: 'sync', rotulo: 'SYNC', alvo: 'deck', nome: 'sync' });
  C({ id: 'mestre', rotulo: 'Mestre do SYNC', alvo: 'deck', nome: 'mestre' });
  C({ id: 'inicio', rotulo: 'Voltar ao início', alvo: 'deck', nome: 'inicio' });
  C({ id: 'carregar', rotulo: 'Carregar a faixa selecionada', alvo: 'deck', nome: 'carregar' });
  // pitch em passos: o tamanho vem do parâmetro do mapa (parametros.pitchPasso, % por clique); sem ele, 0,1 %.
  // soltaSync: com o SYNC ligado o passo vale mesmo assim e desliga o SYNC do deck (como no Traktor; decisão
  // do Lucas, 2026-11-13) — a regra é passoDePitch, abaixo.
  C({ id: 'pitchMais', rotulo: 'Pitch + (passo)', alvo: 'deck', nome: 'pitchMais', parametro: 'pitchPasso', soltaSync: true });
  C({ id: 'pitchMenos', rotulo: 'Pitch − (passo)', alvo: 'deck', nome: 'pitchMenos', parametro: 'pitchPasso', soltaSync: true });
  C({ id: 'bendMais', rotulo: 'Bend + (segurar)', alvo: 'deck', nome: 'bendMais', tipoAcao: 'pressionar' });
  C({ id: 'bendMenos', rotulo: 'Bend − (segurar)', alvo: 'deck', nome: 'bendMenos', tipoAcao: 'pressionar' });
  for (let n = 1; n <= 8; n++) C({ id: 'hotcue' + n, rotulo: 'Hotcue ' + n, alvo: 'deck', nome: 'hotcue' + n, tipoAcao: 'pressionar' });
  C({ id: 'loopIn', rotulo: 'Loop IN', alvo: 'deck', nome: 'loopIn' });
  C({ id: 'loopOut', rotulo: 'Loop OUT', alvo: 'deck', nome: 'loopOut' });
  C({ id: 'loopAuto', rotulo: 'Loop liga/desliga', alvo: 'deck', nome: 'loopAuto', temEstado: true });
  C({ id: 'loopMetade', rotulo: 'Loop ÷2', alvo: 'deck', nome: 'loopMetade' });
  C({ id: 'loopDobro', rotulo: 'Loop ×2', alvo: 'deck', nome: 'loopDobro' });
  C({ id: 'loopTamanho', rotulo: 'Tamanho do loop (encoder)', alvo: 'deck', nome: 'loopMais', tipos: ['encoder'], passos: ['loopMais', 'loopMenos'] });
  for (const n of TAMANHOS_LOOP) C({ id: 'loopTam' + nomeTamanho(n), rotulo: 'Loop de ' + rotuloTamanho(n) + (n === 1 ? ' batida' : ' batidas'), alvo: 'deck', nome: 'loopTam' + nomeTamanho(n) });
  C({ id: 'beatjumpMais', rotulo: 'Beatjump →', alvo: 'deck', nome: 'beatjumpMais' });
  C({ id: 'beatjumpMenos', rotulo: 'Beatjump ←', alvo: 'deck', nome: 'beatjumpMenos' });
  C({ id: 'beatjump', rotulo: 'Beatjump (encoder)', alvo: 'deck', nome: 'beatjumpMais', tipos: ['encoder'], passos: ['beatjumpMais', 'beatjumpMenos'] });
  // Jog (VB-58): o gesto e o som são de js/scratch.js (ações deckX.jogScratch/jogBend, delta em passos de encoder).
  C({ id: 'jogScratch', rotulo: 'Jog: scratch (encoder)', alvo: 'deck', nome: 'jogScratch', tipos: ['encoder'], tipoAcao: 'delta' });
  C({ id: 'jogBend', rotulo: 'Jog: tempo bend (encoder)', alvo: 'deck', nome: 'jogBend', tipos: ['encoder'], tipoAcao: 'delta' });
  C({ id: 'flux', rotulo: 'Flux', alvo: 'deck', nome: 'flux', temEstado: true });
  C({ id: 'gradeBpmMais', rotulo: 'BPM da grade +0,01', alvo: 'deck', nome: 'gradeBpmMais' });
  C({ id: 'gradeBpmMenos', rotulo: 'BPM da grade −0,01', alvo: 'deck', nome: 'gradeBpmMenos' });
  C({ id: 'gradeBpm', rotulo: 'BPM da grade (encoder)', alvo: 'deck', nome: 'gradeBpmMais', tipos: ['encoder'], passos: ['gradeBpmMais', 'gradeBpmMenos'] });
  for (const [c, r, faixa] of [['vol', 'Volume', [0, 100]], ['trim', 'Ganho', [-12, 12]], ['hi', 'EQ alto', [-12, 12]],
    ['mid', 'EQ médio', [-12, 12]], ['low', 'EQ grave', [-12, 12]], ['filtro', 'Filtro', [-100, 100]]]) {
    C({ id: 'mixer.' + c, rotulo: r, alvo: 'canal', nome: c, tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa });
  }
  for (const b of ['hi', 'mid', 'low']) C({ id: 'mixer.kill-' + b, rotulo: 'Kill ' + b, alvo: 'canal', nome: 'kill-' + b, tipoAcao: 'booleano' });
  C({ id: 'mixer.xfade', rotulo: 'Crossfader', alvo: 'global', nome: 'mixer.xfade', tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [-100, 100] });
  C({ id: 'mixer.master-vol', rotulo: 'Volume master', alvo: 'global', nome: 'mixer.master-vol', tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [0, 100] });
  // FX globais (js/fx.js registra fx1/fx2.liga; VbMxFx.UNIDADES = 2): o SHIFT+atribuição ◀/▶ da X1 MK3.
  C({ id: 'biblio.mover', rotulo: 'Biblioteca: mover a seleção (encoder)', alvo: 'global', nome: 'biblio.mover', tipos: ['encoder'], tipoAcao: 'delta' });
  C({ id: 'biblio.lista', rotulo: 'Biblioteca: trocar de lista (encoder)', alvo: 'global', nome: 'biblio.lista', tipos: ['encoder'], tipoAcao: 'delta' });
  for (let n = 1; n <= 2; n++) C({ id: 'fx' + n + '.liga', rotulo: 'FX ' + n + ' liga/desliga', alvo: 'global', nome: 'fx' + n + '.liga' });

  // Stems dos decks (VB-stems-atalhos): 4 vozes × (mudo, solo, volume, EQ, filtro, fx). Alvo 'deck', então a ação em
  // VbMxUI é `deckA.stem.<voz>.<controle>` (registrada em js/stems-tela.js). `stem` e `campo` dizem de onde ler o
  // valor atual (valorDoStem) e como virar o parcial de VbMxStems.definir (parcialDoStem).
  const STEMS_VOZES = [['vocals', 'vocals'], ['drums', 'drums'], ['bass', 'bass'], ['instrumental', 'outros']];
  for (const [v, r] of STEMS_VOZES) {
    const S = (id, rotulo, extra) => C(Object.assign({ id: 'stem.' + v + '.' + id, rotulo: 'Stem ' + r + ': ' + rotulo, alvo: 'deck', nome: 'stem.' + v + '.' + id, stem: v, campo: id }, extra));
    S('mudo', 'mudo (alterna)', {});
    S('solo', 'solo (alterna)', {});
    S('volume', 'volume', { tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [0, 150] });
    for (const b of ['hi', 'mid', 'low']) S(b, 'EQ ' + b, { tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [-26, 6] });
    S('filtro', 'filtro', { tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [-100, 100] });
    S('fxProx', 'próximo efeito', {});
    S('fxParam', 'efeito: parâmetro', { tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [0, 100] });
    S('fxMix', 'efeito: mix', { tipos: ['fader', 'encoder'], tipoAcao: 'valor', faixa: [0, 100] });
  }
  // Modo stems do deck (X1-STEMS, docs/midi-x1-mk3.md § 3.1): ligar = o botão STEMS da faixa (separa se ainda não há stems);
  // restaurar = o reset da faixa (mudo/solo desligados, volume 1, EQ 0, filtro 0, sem fx). Ações em js/stems-tela.js.
  C({ id: 'stems.ligar', rotulo: 'Stems: liga/desliga o modo', alvo: 'deck', nome: 'stems.ligar' });
  C({ id: 'stems.restaurar', rotulo: 'Stems: restaurar (faixa inteira)', alvo: 'deck', nome: 'stems.restaurar' });
  // Valor atual do campo do comando de stem, na escala do comando (para fader direct/soft takeover e encoder).
  function valorDoStem(cmd, est) {
    est = est || {};
    const c = cmd.campo, n = (x, p) => (typeof x === 'number' && isFinite(x) ? x : p);
    if (c === 'volume') return n(est.volume, 1) * 100;
    if (c === 'hi' || c === 'mid' || c === 'low') return n(est.eq && est.eq[c], 0);
    if (c === 'filtro') return n(est.filtro, 0) * 100;
    if (c === 'fxParam') return n(est.fx && est.fx.param, 0.5) * 100;
    if (c === 'fxMix') return n(est.fx && est.fx.mix, 0.5) * 100;
    return 0;
  }
  // Valor na escala do comando → parcial de VbMxStems.definir; null se não há o que definir (fx sem efeito escolhido).
  function parcialDoStem(cmd, v, est) {
    const c = cmd.campo; v = Number(v);
    if (!isFinite(v)) return null;
    if (c === 'volume') return { volume: v / 100 };
    if (c === 'hi' || c === 'mid' || c === 'low') return { eq: { [c]: v } };
    if (c === 'filtro') return { filtro: v / 100 };
    if (c === 'fxParam' || c === 'fxMix') {
      const fx = est && est.fx; if (!fx) return null;
      return { fx: { id: fx.id, param: c === 'fxParam' ? v / 100 : fx.param, mix: c === 'fxMix' ? v / 100 : fx.mix } };
    }
    return null;
  }

  const comandoPorId = (id) => COMANDOS.find((c) => c.id === id) || null;

  // Nome da ação em VbMxUI para um comando e um alvo ('A'|'B'|null). `passo` ('mais'|'menos') escolhe o
  // lado de um comando de encoder com `passos`.
  function nomeDaAcao(cmd, alvo, passo) {
    if (typeof cmd === 'string') cmd = comandoPorId(cmd);
    if (!cmd) return null;
    const nome = cmd.passos ? cmd.passos[passo === 'menos' ? 1 : 0] : cmd.nome;
    if (cmd.alvo === 'global') return nome;
    if (alvo !== 'A' && alvo !== 'B') return null;
    return (cmd.alvo === 'deck' ? 'deck' : 'mixer') + alvo + '.' + nome;
  }

  // ---------------------------------------------------------------- entrada física
  const chaveFisico = (f) => f.tipo === 'tecla' ? 'tecla:' + f.codigo : f.tipo + ':' + (f.canal | 0) + ':' + (f.numero | 0);

  // Bytes MIDI → {fisico:{tipo,canal,numero}, valor 0–127} ou null (relógio, sysex, pitch bend e afins).
  // Nota On com velocidade 0 vale Nota Off (valor 0).
  function interpretarMidi(bytes) {
    if (!bytes || bytes.length < 3) return null;
    const s = bytes[0] & 0xF0, canal = bytes[0] & 0x0F;
    if (s === 0x90) return { fisico: { tipo: 'nota', canal, numero: bytes[1] & 0x7F }, valor: bytes[2] & 0x7F };
    if (s === 0x80) return { fisico: { tipo: 'nota', canal, numero: bytes[1] & 0x7F }, valor: 0 };
    if (s === 0xB0) return { fisico: { tipo: 'cc', canal, numero: bytes[1] & 0x7F }, valor: bytes[2] & 0x7F };
    return null;
  }

  // ---------------------------------------------------------------- botão (VB-40)
  const estBotaoInicial = () => ({ ativo: false, premido: false });

  // Entrada de botão: `valor` 0–127 (>0 = apertado). Devolve {est, eventos, repetir}.
  // eventos[i] = {op:'disparar'} | {op:'descer'} | {op:'subir'} | {op:'definir', valor:0|1}
  //   disparar: roda a ação uma vez · descer/subir: ação "pressionar" (true/false) · definir: valor lógico.
  // `tipoAcao` ('gatilho'|'pressionar'|'booleano') diz como converter o acionamento em eventos.
  // `repetir`: true enquanto o botão está apertado e a opção "repetir ao segurar" está ligada.
  function processarBotao(est, modo, valor, { tipoAcao = 'gatilho', valorFixo = 1, repetir = false, inverter = false } = {}) {
    est = est || estBotaoInicial();
    const bruto = valor > 0;
    if (bruto === est.premido) return { est, eventos: [], repetir: bruto && !!repetir };   // nada mudou (Note On repetido)
    const premido = inverter ? !bruto : bruto;                    // "inverter" troca apertar por soltar
    const proximo = Object.assign({}, est, { premido: bruto });
    const ev = [];
    const sobe = (v) => ev.push(tipoAcao === 'pressionar' ? { op: v ? 'descer' : 'subir' } : tipoAcao === 'booleano' ? { op: 'definir', valor: v ? 1 : 0 } : { op: 'disparar' });
    modo = MODOS_BOTAO.includes(modo) ? modo : 'hold';
    if (modo === 'direct') {
      if (premido) ev.push({ op: 'definir', valor: valorFixo ? 1 : 0 });   // grava o valor fixo; soltar não faz nada
    } else if (modo === 'toggle') {
      if (premido) {
        proximo.ativo = !est.ativo;
        if (tipoAcao === 'gatilho') ev.push({ op: 'disparar' }); else sobe(proximo.ativo);
      }
    } else if (modo === 'invert') {
      // age ao soltar; em "pressionar"/"booleano" o estado é o contrário do botão físico
      if (tipoAcao === 'gatilho') { if (!premido) ev.push({ op: 'disparar' }); } else sobe(!premido);
    } else {                                                      // hold
      if (tipoAcao === 'gatilho') { if (premido) ev.push({ op: 'disparar' }); } else sobe(premido);
    }
    return { est: proximo, eventos: ev, repetir: bruto && !!repetir };
  }

  // Direct nunca alterna: só dispara se o estado atual for diferente do pedido (Play com 1 nunca pausa).
  function deveAplicarDireto(desejado, atual) { return !!desejado !== !!atual; }

  // ---------------------------------------------------------------- fader/knob (VB-40)
  const estFaderInicial = () => ({ ultimo: null, pegou: false, lado: 0 });
  const limita01 = (x) => Math.min(1, Math.max(0, x));
  // Resolução: 'fina' mantém os 128 passos; 'grossa' agrupa em 16 degraus (p.ex. fader de tempo).
  function aplicarResolucao(v01, resolucao) { return resolucao === 'grossa' ? Math.round(v01 * 15) / 15 : v01; }

  // Entrada de fader/knob. `valor` 0–127. opcoes: {inverter, resolucao, softTakeover, sensibilidade}.
  // `atual01` = valor atual do parâmetro normalizado (0–1). Devolve {est, alvo01} — alvo01 é o novo valor do
  // parâmetro, ou null quando não deve mexer nele (soft takeover ainda não pegou; primeira mensagem relative).
  //  direct: a posição física vira o parâmetro. Com softTakeover, só começa a valer depois que o controle
  //          chega ao valor atual (dentro da tolerância) ou o atravessa; antes disso nada muda.
  //          Se o parâmetro mudou por fora depois da tomada (mouse, reset, outro controle), a tomada recomeça:
  //          `est.alvo` guarda o último valor que este controle escreveu.
  //  relative: aplica só o deslocamento físico desde a última mensagem (sem saltos).
  function processarFader(est, modo, valor, atual01, { inverter = false, resolucao = 'fina', softTakeover = true, sensibilidade = 1 } = {}) {
    est = est || estFaderInicial();
    let fis = limita01(valor / 127);
    if (inverter) fis = 1 - fis;
    if (modo === 'relative') {
      const proximo = Object.assign({}, est, { ultimo: fis });
      if (est.ultimo === null) return { est: proximo, alvo01: null };
      const d = (fis - est.ultimo) * sensibilidade;
      return { est: proximo, alvo01: aplicarResolucao(limita01(atual01 + d), resolucao) };
    }
    // direct
    const proximo = Object.assign({}, est, { ultimo: fis });
    if (softTakeover && est.pegou && typeof est.alvo === 'number' && Math.abs(atual01 - est.alvo) > TOLERANCIA_TOMADA) {
      est = Object.assign({}, est, { pegou: false, lado: 0 });    // mexeram no parâmetro por fora: pegar de novo
      Object.assign(proximo, { pegou: false, lado: 0 });
    }
    if (softTakeover && !est.pegou) {
      const lado = Math.sign(fis - atual01);
      const atravessou = est.lado !== 0 && lado !== 0 && lado !== est.lado;
      proximo.lado = lado || est.lado;
      if (!(Math.abs(fis - atual01) <= TOLERANCIA_TOMADA || atravessou)) return { est: proximo, alvo01: null };
    }
    proximo.pegou = true;
    proximo.alvo = aplicarResolucao(fis, resolucao);
    return { est: proximo, alvo01: proximo.alvo };
  }
  // Troca de alvo/parâmetro compartilhado: o soft takeover recomeça.
  function soltarTomada(est) { return Object.assign({}, est || estFaderInicial(), { pegou: false, lado: 0, ultimo: null, alvo: null }); }

  // Camadas por canal (perfil de controlador): `camadas` = {canal da camada: canal-base}, ex. a X1 MK3 manda o mesmo knob
  // no canal 0 e, com SHIFT, no 2 → {"2": 0, "3": 1}. Duas entradas com a mesma chaveBase são o MESMO controle físico:
  // quando uma camada move o knob, a tomada da outra tem de recomeçar (senão, ao soltar o SHIFT, o parâmetro pula).
  function canalBase(canal, camadas) {
    const c = canal | 0, b = camadas && camadas[String(c)];
    return Number.isInteger(b) ? b : c;
  }
  function chaveBase(f, camadas) {
    return f.tipo === 'tecla' ? chaveFisico(f) : f.tipo + ':' + canalBase(f.canal, camadas) + ':' + (f.numero | 0);
  }

  // ---------------------------------------------------------------- encoder (VB-40)
  // '7f01': 1..63 = +n, 127..65 = −(128−v) (7Fh = −1, 01h = +1). '3f41': centro 40h; 41h = +1, 3Fh = −1.
  function decodificarEncoder(codificacao, bruto) {
    const v = bruto & 0x7F;
    if (codificacao === '3f41') return v - 0x40;
    return v < 64 ? v : v - 128;
  }
  const estEncoderInicial = () => ({ t: null });
  // Passo = delta × sensibilidade × fator de aceleração. A aceleração (0 = desligada, até ~1) multiplica o
  // passo quando os giros chegam em menos de 80 ms um do outro (fator até 1 + 4×aceleração).
  function processarEncoder(est, codificacao, bruto, tMs, { sensibilidade = 1, aceleracao = 0, inverter = false } = {}) {
    est = est || estEncoderInicial();
    let delta = decodificarEncoder(codificacao, bruto);
    if (inverter) delta = -delta;
    let fator = 1;
    if (aceleracao > 0 && est.t !== null && tMs - est.t < 80) fator = 1 + 4 * aceleracao * (1 - (tMs - est.t) / 80);
    return { est: { t: tMs }, delta, passo: delta * sensibilidade * fator };
  }

  // Um giro de encoder (passo de processarEncoder, com sinal) vira chamadas de ação: [{nome, args}].
  //   'delta' (jog)  uma chamada com o passo: deckA.jogScratch(passo)
  //   passos         um gatilho por clique, do lado do sinal (beatjump, tamanho do loop, BPM da grade)
  //   'valor'        null: o parâmetro anda 1/64 da faixa por clique e isso pede o valor atual (quem chama)
  function despachoDoEncoder(cmd, alvo, passo) {
    if (typeof cmd === 'string') cmd = comandoPorId(cmd);
    if (!cmd || typeof passo !== 'number' || !Number.isFinite(passo) || passo === 0) return [];
    if (cmd.tipoAcao === 'delta') { const nome = nomeDaAcao(cmd, alvo); return nome ? [{ nome, args: [passo] }] : []; }
    if (cmd.passos) {
      const nome = nomeDaAcao(cmd, alvo, passo > 0 ? 'mais' : 'menos');
      if (!nome) return [];
      const r = [];
      for (let i = 0, k = Math.max(1, Math.round(Math.abs(passo))); i < k; i++) r.push({ nome, args: [] });
      return r;
    }
    return null;
  }

  // Um passo de pitch (pitchMais/pitchMenos): soma sinal × passo (% do motor; passo inválido ou ≤ 0 = 0,1) ao
  // pitch atual, arredondado ao milésimo para não acumular erro de ponto flutuante. Com SYNC ligado o passo
  // vale do pitch em que o SYNC deixou o deck e pede para soltar o SYNC: → {pitch, soltarSync}.
  const PASSO_PITCH_PADRAO = 0.1;
  function passoDePitch(pitch, sinal, passo, sync) {
    const p = Number(passo) > 0 ? Number(passo) : PASSO_PITCH_PADRAO;
    const atual = Number(pitch) || 0;
    const s = Number(sinal) < 0 ? -1 : 1;
    return { pitch: Math.round((atual + s * p) * 1000) / 1000, soltarSync: !!sync };
  }

  // ---------------------------------------------------------------- atribuições e mapeamentos
  const opcoesPadrao = () => ({ inverter: false, repetir: false, repetirMs: 150, resolucao: 'fina', valorFixo: 1,
    softTakeover: true, sensibilidade: 1, aceleracao: 0, codificacao: '7f01' });
  const modoPadrao = (tipo) => tipo === 'fader' ? 'direct' : tipo === 'botao' ? 'hold' : 'relative';

  let _id = 0;
  const novoId = (p) => p + '-' + Date.now().toString(36) + '-' + (++_id).toString(36);

  function novaAtribuicao({ fisico, comando, alvo = null, tipo, modo, opcoes = {} }) {
    const cmd = comandoPorId(comando);
    const t = tipo || (cmd && cmd.tipos[0]) || 'botao';
    return { id: novoId('at'), fisico, comando, alvo, tipo: t, modo: modo || modoPadrao(t), opcoes: Object.assign(opcoesPadrao(), opcoes) };
  }
  const novoMapeamento = (nome) => ({ id: novoId('mapa'), nome: nome || 'Novo mapeamento', ativo: true, atribuicoes: [] });

  // Erros de uma atribuição (lista vazia = válida).
  function validarAtribuicao(a) {
    const e = [];
    if (!a || typeof a !== 'object') return ['atribuição não é objeto'];
    const f = a.fisico;
    if (!f || !['nota', 'cc', 'tecla'].includes(f.tipo)) e.push('controle físico inválido');
    else if (f.tipo === 'tecla' ? typeof f.codigo !== 'string' || !f.codigo : !Number.isInteger(f.numero) || f.numero < 0 || f.numero > 127) e.push('controle físico incompleto');
    const cmd = comandoPorId(a.comando);
    if (!cmd) e.push('comando desconhecido: ' + a.comando);
    if (!TIPOS.includes(a.tipo)) e.push('tipo desconhecido: ' + a.tipo);
    else if (cmd && !cmd.tipos.includes(a.tipo)) e.push(`o comando ${cmd.id} não aceita o tipo ${a.tipo}`);
    if (cmd && cmd.alvo !== 'global' && a.alvo !== 'A' && a.alvo !== 'B') e.push('alvo precisa ser A ou B');
    if (a.tipo === 'botao' && !MODOS_BOTAO.includes(a.modo)) e.push('modo de botão inválido: ' + a.modo);
    if (a.tipo === 'fader' && !MODOS_FADER.includes(a.modo)) e.push('modo de fader inválido: ' + a.modo);
    if (a.tipo === 'encoder' && a.opcoes && a.opcoes.codificacao && !CODIFICACOES.includes(a.opcoes.codificacao)) e.push('codificação inválida');
    return e;
  }

  // Atribuições de todos os mapeamentos ATIVOS que respondem a este controle físico. Vários mapeamentos
  // ativos ao mesmo tempo: cada um que tiver o controle recebe a entrada.
  function achar(mapeamentos, fisico) {
    const k = chaveFisico(fisico), r = [];
    for (const m of mapeamentos || []) {
      if (!m.ativo) continue;
      for (const a of m.atribuicoes) if (chaveFisico(a.fisico) === k) r.push({ mapeamento: m, atribuicao: a });
    }
    return r;
  }

  // ---------------------------------------------------------------- exportar / importar (JSON próprio)
  function exportar(mapeamentos) {
    return JSON.stringify({ formato: FORMATO, versao: VERSAO, mapeamentos }, null, 2);
  }
  // → {ok, mapeamentos, erros[]}. Atribuição inválida é descartada e vira erro; o resto entra.
  function importar(texto) {
    let o;
    try { o = JSON.parse(texto); } catch (_) { return { ok: false, mapeamentos: [], erros: ['JSON inválido'] }; }
    if (!o || o.formato !== FORMATO) return { ok: false, mapeamentos: [], erros: ['não é um arquivo de mapeamento do VbMx'] };
    if (o.versao !== VERSAO) return { ok: false, mapeamentos: [], erros: ['versão não suportada: ' + o.versao] };
    if (!Array.isArray(o.mapeamentos)) return { ok: false, mapeamentos: [], erros: ['sem lista de mapeamentos'] };
    const erros = [], mapas = [];
    for (const m of o.mapeamentos) {
      if (!m || typeof m.nome !== 'string' || !Array.isArray(m.atribuicoes)) { erros.push('mapeamento malformado'); continue; }
      const novo = { id: novoId('mapa'), nome: m.nome, ativo: m.ativo !== false, atribuicoes: [] };
      for (const a of m.atribuicoes) {
        const e = validarAtribuicao(a);
        if (e.length) { erros.push(`${m.nome}: ${e.join('; ')}`); continue; }
        novo.atribuicoes.push(Object.assign({}, a, { id: novoId('at'), opcoes: Object.assign(opcoesPadrao(), a.opcoes) }));
      }
      mapas.push(novo);
    }
    return { ok: true, mapeamentos: mapas, erros };
  }

  return {
    COMANDOS, STEMS_VOZES, valorDoStem, parcialDoStem, TIPOS, MODOS_BOTAO, MODOS_FADER, CODIFICACOES, TAMANHOS_LOOP, TOLERANCIA_TOMADA, FORMATO, VERSAO,
    comandoPorId, nomeDaAcao, nomeTamanho, rotuloTamanho, chaveFisico, interpretarMidi,
    estBotaoInicial, processarBotao, deveAplicarDireto,
    estFaderInicial, processarFader, soltarTomada, aplicarResolucao, canalBase, chaveBase,
    estEncoderInicial, decodificarEncoder, processarEncoder, despachoDoEncoder, passoDePitch, PASSO_PITCH_PADRAO,
    opcoesPadrao, modoPadrao, novaAtribuicao, novoMapeamento, validarAtribuicao, achar, exportar, importar,
  };
});
