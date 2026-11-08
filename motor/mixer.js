// ===================== VbMxMixer — mixer: trim, EQ (atual e isolador), filtro, crossfader, limitador, medidores =====================
// Dono: VB-16 (onda 1). Lógica pura (UMD), testada em Node por motor/testar-mixer.js. Sem DOM nem Web Audio:
// js/cadeia.js liga estes números aos nós, js/mixer.js à tela, js/medidores.js aos medidores.
// Contrato: docs/contratos.md. Decisão P6: o EQ atual (shelf/peaking, ±12 dB) é o padrão; o isolador
// (crossover Linkwitz-Riley de 3 vias, kill total) é opção. O kill do EQ atual também zera a banda (VB-47):
// com algum kill ligado o canal passa pela via do isolador (viaDoEq), com a banda morta em ganho 0.
//
// Estado do mixer (o objeto `mixer` de js/mixer.js; campos que faltam valem o padrão, `normalizar`):
//   mixer[A|B] = { hi, mid, low (dB, ±12), vol (0…100), trim (dB, ±12), filtro (−100…+100, 0 = aberto),
//                  kill: { hi, mid, low } (bool) }
//   mixer.xfade (−100…+100), mixer.curva ('corte'|'suave'), mixer.reverso (bool), mixer.eqModo ('atual'|'isolador'),
//   mixer.master = { vol (0…100), limiter (bool) }
// VB-16b/VB-41: por canal também pan (−100…+100, 0 = centro), lado do crossfader ('A' | 'B' | 'off'; padrão: canal A
// no lado A, canal B no lado B), auto (bool, auto gain ligado por padrão) e autoDb (dB que o auto gain aplica, calculado
// da faixa carregada; 0 sem faixa). Globais: mixer.curvaFader ('linear'|'quadratica'|'db'), mixer.afiada (0…100, usada
// com curva 'ajustavel'), mixer.fadeTempo (s) e mixer.xfadePasso (passo do botão, em unidades do crossfader).
// Evento: `mixer:mudou` {mixer, canal, controle, valor} (js/mixer.js emite; canal null para crossfader e globais).
//
// Com o estado padrão o som é o de antes do VB-16: ganho trim 1, EQ em 0 dB, filtro fora do caminho,
// fader × crossfader = VbMxReproducao.ganhoDoCanal, master 1, limitador transparente abaixo de −1 dBFS.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMixer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const R = raiz.VbMxReproducao || (typeof require === 'function' ? require('./reproducao.js') : null);

  const CANAIS = ['A', 'B'];
  const BANDAS = ['hi', 'mid', 'low'];
  const MODOS_EQ = ['atual', 'isolador'];
  const CURVAS = R.CURVAS.slice().concat('ajustavel');     // 'ajustavel': suave→afiada pela fórmula de ganhoCrossfader
  const LADOS = ['A', 'B', 'off'];
  const CURVAS_FADER = ['linear', 'quadratica', 'db'];
  const AUTOGAIN = { alvoDb: -16, maxDb: 12, minDb: -12 };   // alvo: RMS da faixa em dBFS; o ajuste fica em ±12 dB
  const FADE = { tempoPadrao: 2, tempoMin: 0.1, tempoMax: 30, passoPadrao: 10 };
  const FAIXAS = {                       // controle → [mín, máx]
    hi: [-12, 12], mid: [-12, 12], low: [-12, 12], vol: [0, 100], trim: [-12, 12], filtro: [-100, 100], fxQtd: [0, 100],
    xfade: [-100, 100], 'master-vol': [0, 100], pan: [-100, 100], afiada: [0, 100],
    fadeTempo: [0.1, 30], xfadePasso: [1, 100],
  };
  const CRUZAMENTO = { baixo: 250, alto: 3200 };   // Hz: LOW | MID | HI do isolador (as frequências do EQ atual)
  const Q_BUTTERWORTH = Math.SQRT1_2;    // dois biquads Butterworth em cascata = um Linkwitz-Riley de 4ª ordem
  const FILTRO = { zonaMorta: 3, lpAberto: 20000, lpMin: 150, hpAberto: 20, hpMax: 8000, ressonancia: 0.9 };
  const LIMITADOR = { limiar: Math.pow(10, -1 / 20), alcance: 2 };   // linear até −1 dBFS; a curva cobre ±alcance

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const trava = (x, min, max) => Math.min(max, Math.max(min, x));

  // ---------- estado ----------
  function canalPadrao() { return { pan: 0, lado: 'A', auto: true, autoDb: 0, hi: 0, mid: 0, low: 0, vol: 100, trim: 0, filtro: 0, fx: 'filtro', fxQtd: 0, kill: { hi: false, mid: false, low: false } }; }
  function estadoPadrao() {
    return { A: canalPadrao(), B: Object.assign(canalPadrao(), { lado: 'B' }), xfade: 0, curva: 'corte', afiada: 50, curvaFader: 'linear',
      fadeTempo: FADE.tempoPadrao, xfadePasso: FADE.passoPadrao, reverso: false, eqModo: 'atual', master: { vol: 100, limiter: true } };
  }
  function travar(controle, v) {
    const f = FAIXAS[controle];
    if (!f) return v;
    return num(v) ? trava(v, f[0], f[1]) : (controle === 'vol' || controle === 'master-vol' ? f[1] : controle === 'fadeTempo' ? FADE.tempoPadrao : controle === 'xfadePasso' ? FADE.passoPadrao : controle === 'afiada' ? 50 : 0);
  }
  // Cópia com todos os campos presentes e travados; o que não vem usa o padrão (o mixer da v1 não tinha trim, filtro etc.).
  function normalizar(m) {
    const p = estadoPadrao(), o = m || {};
    for (const l of CANAIS) {
      const c = o[l] || {}, k = c.kill || {}, r = p[l];
      for (const b of BANDAS) { r[b] = c[b] === undefined ? r[b] : travar(b, c[b]); r.kill[b] = !!k[b]; }
      r.vol = c.vol === undefined ? r.vol : travar('vol', c.vol);
      r.trim = c.trim === undefined ? 0 : travar('trim', c.trim);
      r.filtro = c.filtro === undefined ? 0 : travar('filtro', c.filtro);
      r.pan = c.pan === undefined ? 0 : travar('pan', c.pan);
      r.fx = FX_IDS.includes(c.fx) ? c.fx : 'filtro';
      r.fxQtd = c.fxQtd === undefined ? 0 : travar('fxQtd', c.fxQtd);
      r.lado = LADOS.includes(c.lado) ? c.lado : r.lado;
      r.auto = c.auto === undefined ? true : !!c.auto;
      r.autoDb = num(c.autoDb) ? trava(c.autoDb, AUTOGAIN.minDb, AUTOGAIN.maxDb) : 0;
    }
    p.xfade = o.xfade === undefined ? 0 : travar('xfade', o.xfade);
    p.curva = CURVAS.includes(o.curva) ? o.curva : 'corte';
    p.afiada = o.afiada === undefined ? 50 : travar('afiada', o.afiada);
    p.curvaFader = CURVAS_FADER.includes(o.curvaFader) ? o.curvaFader : 'linear';
    p.fadeTempo = o.fadeTempo === undefined ? FADE.tempoPadrao : travar('fadeTempo', o.fadeTempo);
    p.xfadePasso = o.xfadePasso === undefined ? FADE.passoPadrao : travar('xfadePasso', o.xfadePasso);
    p.reverso = !!o.reverso;
    p.eqModo = MODOS_EQ.includes(o.eqModo) ? o.eqModo : 'atual';
    const ms = o.master || {};
    p.master = { vol: ms.vol === undefined ? 100 : travar('master-vol', ms.vol), limiter: ms.limiter === undefined ? true : !!ms.limiter };
    return p;
  }

  // ---------- trim e master ----------
  const linearDeDb = (db) => Math.pow(10, db / 20);
  function ganhoTrim(db) { return linearDeDb(travar('trim', db)); }       // 0 dB → 1 exato
  function ganhoMaster(vol) { return travar('master-vol', vol) / 100; }

  // ---------- EQ ----------
  // EQ atual: dB para o BiquadFilter da banda = VbMxReproducao.dbDoEq. O kill NÃO passa por aqui: shelf/peaking tem
  // ganho finito e o shelf ainda deixa passar o outro lado, então nunca chega a silêncio. Com kill (VB-47) o
  // canal vai pela via do isolador (ver viaDoEq), onde a banda morta tem ganho 0. O 2º argumento é ignorado.
  function dbBandaAtual(db) { return R.dbDoEq(db); }
  // Qual via do EQ do canal processa: 'isolador' se o modo é isolador ou se há algum kill; senão 'atual'.
  function viaDoEq(canal, eqModo) {
    const k = (canal && canal.kill) || {};
    return eqModo === 'isolador' || BANDAS.some((b) => k[b]) ? 'isolador' : 'atual';
  }
  // Ganhos lineares das duas vias (a cadeia leva uma a 1 e a outra a 0, com rampa curta, sem estalo).
  function viasDoEq(canal, eqModo) { const v = viaDoEq(canal, eqModo); return { atual: v === 'atual' ? 1 : 0, isolador: v === 'isolador' ? 1 : 0 }; }
  // Isolador: ganho LINEAR da banda. Kill = 0 (total).
  function ganhoBandaIsolador(db, kill) { return kill ? 0 : linearDeDb(R.dbDoEq(db)); }

  // ---------- filtro por canal (um botão: esquerda passa-baixa, direita passa-alta) ----------
  // 0 (±zona morta) = fora do caminho. Esquerda fecha de 20 kHz a 150 Hz; direita abre de 20 Hz a 8 kHz;
  // ambos em escala exponencial (percepção de oitava).
  function filtroDoBotao(valor) {
    const v = num(valor) ? trava(valor, -100, 100) : 0;
    if (Math.abs(v) <= FILTRO.zonaMorta) return { ativo: false, tipo: 'nenhum', lp: FILTRO.lpAberto, hp: FILTRO.hpAberto, q: Q_BUTTERWORTH };
    const t = (Math.abs(v) - FILTRO.zonaMorta) / (100 - FILTRO.zonaMorta);   // 0…1 fora da zona morta
    if (v < 0) return { ativo: true, tipo: 'passa-baixa', lp: FILTRO.lpAberto * Math.pow(FILTRO.lpMin / FILTRO.lpAberto, t), hp: FILTRO.hpAberto, q: FILTRO.ressonancia };
    return { ativo: true, tipo: 'passa-alta', lp: FILTRO.lpAberto, hp: FILTRO.hpAberto * Math.pow(FILTRO.hpMax / FILTRO.hpAberto, t), q: FILTRO.ressonancia };
  }

  // ---------- efeitos de mixer por canal (VB-60; spec §6: 1 botão + 1 knob de quantidade, filtro selecionado, +7 opções) ----------
  // O seletor do canal oferece o filtro e 4 dos 7 efeitos abaixo (preferência `mixer.fx-canal-lista`). Todos de 1 knob
  // (`fxQtd`, 0…100); 0 deixa o som passar intacto. Nomes e receitas são do VbMx (nós nativos da Web Audio, sem amostra de
  // terceiros); js/fx-canal.js monta os nós a partir destes números. Os de tempo seguem o BPM do mestre (`mestreBpm`).
  //   sopro     ruído branco filtrado (passa-banda) somado ao canal; o knob sobe o volume e a frequência do filtro.
  //   picote    gate rítmico: corta o canal em semicolcheias do BPM do mestre; o knob é a profundidade do corte.
  //   rebate    eco curto de uma colcheia sincronizada, 2 a 3 repetições; o knob é a quantidade do eco.
  //   camara    reverb curto (1,2 s) com impulso gerado por código; o knob é a mistura.
  //   granulado redutor de resolução (16 → 3 bits) por WaveShaper em escada; o knob reduz os bits e mistura o efeito.
  //   vaivem    flanger curto: atraso de 1…5 ms varrido por LFO lento, com realimentação; o knob é a mistura.
  //   caverna   eco com realimentação filtrada (passa-baixa + passa-alta no laço, "dub echo") em colcheia pontuada.
  const FX_FILTRO = { id: 'filtro', nome: 'Filtro', descricao: 'passa-baixa à esquerda, passa-alta à direita (o botão do canal)' };
  const FX_CANAL = [
    { id: 'sopro', nome: 'Sopro', descricao: 'ruído branco filtrado somado ao canal' },
    { id: 'picote', nome: 'Picote', descricao: 'gate rítmico em semicolcheias do BPM do mestre' },
    { id: 'rebate', nome: 'Rebate', descricao: 'eco curto de colcheia sincronizado ao BPM do mestre' },
    { id: 'camara', nome: 'Câmara', descricao: 'reverb curto com impulso gerado por código' },
    { id: 'granulado', nome: 'Granulado', descricao: 'redutor de resolução (16 a 3 bits) por WaveShaper' },
    { id: 'vaivem', nome: 'Vaivém', descricao: 'flanger curto (atraso de 1 a 5 ms com LFO lento)' },
    { id: 'caverna', nome: 'Caverna', descricao: 'eco com realimentação filtrada (dub echo), colcheia pontuada' },
  ];
  const FX_IDS = [FX_FILTRO.id].concat(FX_CANAL.map((e) => e.id));
  const FX_QTD_PORTAS = 4;                                  // quantos dos 7 aparecem no seletor
  const FX_LISTA_PADRAO = 'sopro,picote,rebate,camara';     // padrão da preferência `mixer.fx-canal-lista`
  const FX_ZONA_MORTA = 1;                                  // fxQtd ≤ 1 = efeito neutro
  const FX_BPM_PADRAO = 120;
  function nomeDoFx(id) { const e = FX_ID_MAP[id]; return e ? e.nome : FX_FILTRO.nome; }
  function descricaoDoFx(id) { const e = FX_ID_MAP[id]; return e ? e.descricao : FX_FILTRO.descricao; }
  const FX_ID_MAP = Object.fromEntries([FX_FILTRO].concat(FX_CANAL).map((e) => [e.id, e]));
  // Lista de ids dos efeitos oferecidos (sem o filtro): exatamente 4 válidos e únicos, na ordem escrita; o que falta
  // ou vem inválido é completado pela ordem do catálogo. Texto da preferência: ids separados por vírgula.
  function fxEscolhidos(texto) {
    const lido = typeof texto === 'string' ? texto.split(',').map((x) => x.trim()) : [];
    const ids = [];
    for (const id of lido.concat(FX_LISTA_PADRAO.split(','), FX_CANAL.map((e) => e.id))) {
      if (FX_ID_MAP[id] && id !== 'filtro' && !ids.includes(id)) ids.push(id);
      if (ids.length === FX_QTD_PORTAS) break;
    }
    return ids;
  }
  // O que o seletor do canal mostra: o filtro primeiro, mais os 4 escolhidos (5 opções).
  function fxDisponiveis(texto) { return [FX_FILTRO.id].concat(fxEscolhidos(texto)); }
  function bpmValido(bpm) { return num(bpm) && bpm > 20 && bpm < 400 ? bpm : FX_BPM_PADRAO; }
  // Números que js/fx-canal.js leva aos nós. `ativo` falso = efeito neutro (o som passa intacto). t = fxQtd/100.
  function fxParametros(id, qtd, bpm) {
    const q = num(qtd) ? trava(qtd, 0, 100) : 0, t = q / 100, b = bpmValido(bpm), batida = 60 / b;
    const neutro = { id, ativo: false };
    if (!FX_ID_MAP[id] || id === 'filtro' || q <= FX_ZONA_MORTA) return neutro;
    switch (id) {
      case 'sopro': return { id, ativo: true, nivel: 0.35 * t * t, freq: 400 * Math.pow(20, t), q: 0.8 };
      case 'picote': return { id, ativo: true, profundidade: t, freq: 2 / batida, base: 1 - t / 2, modulacao: t / 2 };   // quadrada: 1/16 ligada, 1/16 cortada
      case 'rebate': return { id, ativo: true, atraso: batida / 2, realimentacao: 0.25 + 0.3 * t, molhado: 0.8 * t };
      case 'camara': return { id, ativo: true, duracao: 1.2, molhado: 0.6 * t };
      case 'granulado': { const bits = Math.round(16 - 13 * t); return { id, ativo: true, bits, passos: Math.pow(2, bits), molhado: Math.min(1, t * 5) }; }
      case 'vaivem': return { id, ativo: true, atrasoBase: 0.003, profundidade: 0.002, taxa: 0.3, realimentacao: 0.5 * t, molhado: 0.9 * t };
      case 'caverna': return { id, ativo: true, atraso: batida * 0.75, realimentacao: 0.3 + 0.45 * t, passaBaixa: 2800 - 1800 * t, passaAlta: 200, molhado: 0.85 * t };
      default: return neutro;
    }
  }
  // Curva do WaveShaper do granulado: escada com `passos` degraus em −1…1 (x → round(x·p/2)·2/p), n pontos.
  function curvaGranulado(passos, n) {
    const pts = n || 2049, p = Math.max(2, passos), c = new Array(pts);
    for (let i = 0; i < pts; i++) { const x = (i / (pts - 1)) * 2 - 1; c[i] = trava(Math.round(x * p / 2) * 2 / p, -1, 1); }
    return c;
  }
  // Efeito do canal: { id, qtd } já normalizados; o filtro segue o botão `filtro`, os outros o `fxQtd`.
  function fxDoCanal(canalEstado) {
    const c = canalEstado || {}, id = FX_IDS.includes(c.fx) ? c.fx : 'filtro';
    return { id, qtd: id === 'filtro' ? 0 : travar('fxQtd', c.fxQtd === undefined ? 0 : c.fxQtd) };
  }

  // ---------- crossfader ----------
  // Curva 'ajustavel' (VB-16b; a spec só diz "de suave a afiada", a fórmula é do VbMx). t = posição 0…1 do crossfader
  // (0 = tudo A, 1 = tudo B; `reverso` inverte), a = afiada/100. Ganho do lado A: min(1, m × cos(t·π/2)), com
  // m = 1 + 49·a; o lado B é o espelho (t → 1−t). a = 0: potência constante (0,707 no meio); a = 1: os dois cheios quase
  // o curso todo e corte só no último ~1,3 % (o "corte" de scratch). Sempre 1 numa ponta, 0 na outra, monótona.
  function ganhoAjustavel(lado, x, afiada, reverso) {
    let v = num(x) ? trava(x, -100, 100) : 0;
    if (reverso) v = -v;
    const t = lado === 'A' ? (v + 100) / 200 : (100 - v) / 200;
    const m = 1 + 49 * trava(num(afiada) ? afiada : 50, 0, 100) / 100;
    const g = Math.min(1, m * Math.cos(t * Math.PI / 2));
    return g < 1e-12 ? 0 : g;
  }
  // `afiada` numérico escolhe a curva ajustável; sem ele vale `curva` ('corte'|'suave') como antes.
  function ganhoCrossfader(canal, x, curva, reverso, afiada) {
    if (curva === 'ajustavel' && (canal === 'A' || canal === 'B')) return ganhoAjustavel(canal, x, afiada, reverso);
    return R.ganhoCrossfader(canal, x, curva === 'ajustavel' ? 'corte' : curva, reverso);
  }
  // Ganho do crossfader para um canal do mixer: o lado atribuído decide a curva ('off' não passa pelo crossfader).
  function ganhoCrossfaderDoCanal(canalEstado, mixer) {
    const lado = canalEstado && canalEstado.lado;
    if (lado === 'off') return 1;
    return ganhoCrossfader(lado === 'B' ? 'B' : 'A', mixer.xfade, mixer.curva, mixer.reverso, mixer.afiada);
  }
  // Fader de volume (0…100 → 0…1). 'linear' é o de sempre; 'quadratica' = (v/100)² (mais fino embaixo);
  // 'db' = escala em dB, −60 dB no zero ao fim do curso (piso: 0 só em vol 0).
  function ganhoFader(vol, curva) {
    const v = num(vol) ? trava(vol, 0, 100) / 100 : 0;
    if (curva === 'quadratica') return v * v;
    if (curva === 'db') return v <= 0 ? 0 : Math.pow(10, (-60 * (1 - v)) / 20);
    return v;
  }
  function ganhoDoCanal(canal, vol, x, curva, reverso, afiada, curvaFader) {
    if (curvaFader === undefined && afiada === undefined) return R.ganhoDoCanal(canal, vol, x, curva, reverso);
    return ganhoFader(vol, curvaFader) * ganhoCrossfader(canal, x, curva, reverso, afiada);
  }

  // ---------- pan e auto gain ----------
  function valorPan(v) { return num(v) ? trava(v, -100, 100) / 100 : 0; }     // −100…100 → −1…1 do StereoPannerNode
  // Nível de uma faixa: `canais` = lista de Float32Array; lê 1 amostra a cada `passo`. → {rms, pico} lineares.
  function medirNivel(canais, passo) {
    const p = passo > 0 ? Math.floor(passo) : 1;
    let soma = 0, n = 0, pico = 0;
    for (const c of canais || []) for (let i = 0; i < c.length; i += p) { const a = c[i]; soma += a * a; n += 1; if (Math.abs(a) > pico) pico = Math.abs(a); }
    return { rms: n ? Math.sqrt(soma / n) : 0, pico };
  }
  // Auto gain (spec §1): dB que levam o RMS da faixa ao alvo (−16 dBFS), em ±12 dB, sem deixar o pico passar de 0 dBFS.
  // Sem dado (rms 0) = 0 dB.
  function autoGainDb(rms, pico) {
    if (!(rms > 0)) return 0;
    let db = AUTOGAIN.alvoDb - 20 * Math.log10(rms);
    if (pico > 0) db = Math.min(db, -20 * Math.log10(pico));
    return trava(db, AUTOGAIN.minDb, AUTOGAIN.maxDb);
  }
  // Ganho linear antes do fader: trim × auto gain (quando ligado).
  function ganhoDeEntrada(canalEstado) {
    return ganhoTrim(canalEstado.trim) * (canalEstado.auto ? linearDeDb(canalEstado.autoDb || 0) : 1);
  }

  // ---------- passo e fade automático do crossfader (VB-41) ----------
  // Passo: anda `passo` unidades para a direção (−1 = lado A, +1 = lado B), travado em ±100.
  function passoXfade(x, direcao, passo) {
    const p = num(passo) ? trava(passo, 1, 100) : FADE.passoPadrao;
    return trava((num(x) ? x : 0) + (direcao < 0 ? -p : p), -100, 100);
  }
  // Fade: linear no tempo de `de` a `para` em `duracaoMs`. valorEm(ms desde o início) chega EXATAMENTE a `para`
  // quando ms ≥ duracaoMs (e fica lá); `fim(ms)` diz se acabou.
  function criarFade(de, para, duracaoMs) {
    const d0 = num(de) ? trava(de, -100, 100) : 0, d1 = num(para) ? trava(para, -100, 100) : 0;
    const dur = num(duracaoMs) && duracaoMs > 0 ? duracaoMs : 0;
    return {
      de: d0, para: d1, duracaoMs: dur,
      valorEm(ms) { return dur === 0 || ms >= dur ? d1 : ms <= 0 ? d0 : d0 + (d1 - d0) * (ms / dur); },
      fim(ms) { return dur === 0 || ms >= dur; },
    };
  }

  // ---------- limitador de pico (master) ----------
  // Curva do WaveShaper: idêntica à entrada até −1 dBFS e, acima, uma tangente hiperbólica que encosta em 1
  // sem passar. A cadeia põe um ganho 0,5 antes e a curva cobre ±2 (a soma de dois canais com EQ +12 passa de 1).
  function limitar(x) {
    const T = LIMITADOR.limiar, a = Math.abs(x);
    if (!(a > T)) return x;
    return Math.sign(x) * (T + (1 - T) * Math.tanh((a - T) / (1 - T)));
  }
  function curvaLimitador(n) {
    const N = n === undefined ? 4097 : n, c = new Array(N);
    for (let i = 0; i < N; i++) c[i] = limitar(((i / (N - 1)) * 2 - 1) * LIMITADOR.alcance);
    return c;
  }

  // ---------- medidores ----------
  // pico e RMS de um bloco de amostras (Float32Array do AnalyserNode).
  function nivelDeAmostras(a) {
    let pico = 0, soma = 0;
    const n = a ? a.length : 0;
    for (let i = 0; i < n; i++) { const v = Math.abs(a[i]); if (v > pico) pico = v; soma += a[i] * a[i]; }
    return { pico, rms: n ? Math.sqrt(soma / n) : 0 };
  }
  const PISO_DB = -60;
  function emDb(x) { return x > 0 ? Math.max(PISO_DB, 20 * Math.log10(x)) : PISO_DB; }
  function alturaDoMedidor(db) { return trava((db - PISO_DB) / -PISO_DB, 0, 1); }   // −60 dB → 0, 0 dB → 1
  // Balística: sobe na hora, cai a `queda` dB/s; o marcador de pico segura `retencaoMs` e cai; o clipe
  // acende com pico ≥ 0,999 e fica `clipeMs`. Um por medidor; `atualizar(pico, agoraMs)` →
  // {db, altura, picoAltura, clip}.
  function criarMedidor(op) {
    const o = Object.assign({ queda: 30, retencaoMs: 1200, clipeMs: 2000 }, op);
    let db = PISO_DB, marca = PISO_DB, marcaDesde = 0, clipeAte = -Infinity, antes = null;
    return {
      atualizar(pico, agoraMs) {
        const dt = antes === null ? 0 : Math.max(0, agoraMs - antes) / 1000;
        antes = agoraMs;
        const d = emDb(pico);
        db = Math.max(d, db - o.queda * dt);
        if (d >= marca) { marca = d; marcaDesde = agoraMs; }
        else if (agoraMs - marcaDesde > o.retencaoMs) marca = Math.max(d, marca - o.queda * dt);
        if (pico >= 0.999) clipeAte = agoraMs + o.clipeMs;
        return { db, altura: alturaDoMedidor(db), picoAltura: alturaDoMedidor(marca), clip: agoraMs < clipeAte };
      },
      zerar() { db = marca = PISO_DB; clipeAte = -Infinity; antes = null; },
      limparClipe() { clipeAte = -Infinity; },   // só apaga o clipe (clipeMs: Infinity é pegajoso); o nível e o marcador de pico seguem
    };
  }

  // Medidor de LEDs (proposta C): 18 limiares em dBFS; a zona útil (−12 a 0) ocupa mais da metade da altura.
  // Verde até −8, âmbar de −6 a −3, vermelho de −2 a 0 (ver docs/proposta-ui-c-medidores-tabela.md).
  const LEDS_DB = [-40, -36, -32, -28, -24, -21, -18, -15, -12, -10, -8, -6, -5, -4, -3, -2, -1, 0];
  function ledsAcesos(db) { let n = 0; for (const l of LEDS_DB) if (db >= l) n += 1; return n; }   // quantos LEDs (de baixo) acendem para esse nível
  function zonaDoLed(i) { const d = LEDS_DB[i]; return d >= -2 ? "vermelho" : d >= -6 ? "ambar" : "verde"; }

  return { CANAIS, BANDAS, MODOS_EQ, CURVAS, LADOS, CURVAS_FADER, AUTOGAIN, FADE, FAIXAS, CRUZAMENTO, Q_BUTTERWORTH, FILTRO, LIMITADOR, PISO_DB,
    canalPadrao, estadoPadrao, travar, normalizar, ganhoTrim, ganhoMaster, dbBandaAtual, viaDoEq, viasDoEq, ganhoBandaIsolador,
    FX_FILTRO, FX_CANAL, FX_IDS, FX_QTD_PORTAS, FX_LISTA_PADRAO, nomeDoFx, descricaoDoFx, fxEscolhidos, fxDisponiveis, fxParametros, curvaGranulado, fxDoCanal,
    filtroDoBotao, ganhoCrossfader, ganhoAjustavel, ganhoCrossfaderDoCanal, ganhoFader, ganhoDoCanal, valorPan, medirNivel, autoGainDb,
    ganhoDeEntrada, passoXfade, criarFade, limitar, curvaLimitador, nivelDeAmostras, emDb, alturaDoMedidor, criarMedidor, LEDS_DB, ledsAcesos, zonaDoLed };
});
