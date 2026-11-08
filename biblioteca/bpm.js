// VbMx — escolha e refinamento do BPM (VB-bpm): a parte LÓGICA, sem DOM e sem áudio decodificado.
// O worker (painel.js) roda os estimadores do Essentia (RhythmExtractor2013 multifeature e
// degara, PercivalBpmEstimator), entrega candidatos { nome, bpm, ticks? } e o envelope de graves
// da faixa (envelopeGrave, calculado no próprio worker). Aqui se decide:
//   1. a OITAVA: todo candidato é dobrado/dividido para a faixa de DJ [70, 180) e o consenso
//      (mediana) manda — um estimador que cai em 62 ou 186 não arrasta a faixa;
//   2. a GRADE GROSSA: reta tick = fase + k·período nos ticks da faixa inteira. Os ticks são
//      numerados em SEGMENTOS coerentes (um trecho em contratempo, em dobro ou com buraco abre outro
//      segmento) e os segmentos se juntam ao maior só se caem na mesma fase — antes, um tick de meia
//      batida contava como batida inteira e deslocava a contagem de tudo o que vinha depois;
//   3. a GRADE FINA, no BUMBO: com o envelope de graves, cada batida da grade grossa procura o
//      ataque do bumbo perto dela; a reta é refeita nesses ataques (resolução de ~1 ms, contra os
//      11,6 ms de passo dos ticks e o atraso próprio de cada estimador). A âncora sai do ataque, não
//      do tick;
//   4. o 1 do COMPASSO: entre as 4 fases possíveis, a de mais energia de grave (média por batida);
//      2+ entradas do bumbo (depois de 8+ batidas sem ele) que concordam mandam; sem elas (faixa sem intro
//      nem break), a troca de harmonia do baixo, se for clara; com margem pequena, 1 entrada desempata;
//   5. a COERÊNCIA: o BPM da faixa e o da grade são o MESMO número, guardado com 6 casas (o
//      arredondamento a 0,01 deixava até ±7 ms na ponta de uma faixa de 8 min).
// Roda no navegador (global `VbMxBpm`) e no Node (`require`). Teste: biblioteca/testar-bpm.js.
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxBpm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FAIXA_DJ = { min: 70, max: 180 };
  // Desvio máximo da reta, em fração do período: acima disso o andamento não é constante (banda ao
  // vivo, rubato, ticks do extrator em oitavas misturadas) e uma grade fixa erraria mais de 1/5 de
  // batida no meio da faixa. Medido na pasta de teste: 13 de 56 faixas passam desse ponto.
  const LIMITE_DESVIO = 0.2;
  const CASAS_BPM = 6;      // como o TEMPO@BPM do .nml: 5e-7 BPM não desloca nada em 10 min
  const CASAS_TEMPO = 6;    // primeira batida em µs
  const ehNum = v => typeof v === 'number' && Number.isFinite(v);
  const arred = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
  const modulo = (a, m) => ((a % m) + m) % m;
  const mediana = (v) => {
    const o = v.slice().sort((a, b) => a - b), n = o.length;
    return n ? (n % 2 ? o[(n - 1) / 2] : (o[n / 2 - 1] + o[n / 2]) / 2) : NaN;
  };
  const quantil = (v, q) => { const o = v.slice().sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.max(0, Math.round(q * (o.length - 1))))] : NaN; };

  // Dobra/divide por 2 até cair em [min, max). BPM inválido → NaN.
  function dobrarParaFaixa(bpm, min, max) {
    const lo = ehNum(min) ? min : FAIXA_DJ.min, hi = ehNum(max) ? max : FAIXA_DJ.max;
    if (!ehNum(bpm) || bpm <= 0) return NaN;
    let b = bpm;
    while (b < lo) b *= 2;
    while (b >= hi) b /= 2;
    return b;
  }

  // Quantas batidas-alvo há em cada tick (potência de 2): 1 = ticks nas batidas; 2 = os ticks
  // vêm a cada 2 batidas (extrator em meio tempo); 0.5 = a cada meia batida (dobro). null se os
  // intervalos não casam com nenhuma potência (tick bagunçado).
  function multiploDosTicks(ticks, periodoAlvo) {
    if (!(ticks && ticks.length >= 4) || !(periodoAlvo > 0)) return null;
    const iv = [];
    for (let i = 1; i < ticks.length; i++) iv.push(ticks[i] - ticks[i - 1]);
    const r = mediana(iv) / periodoAlvo;
    for (const n of [0.25, 0.5, 1, 2, 4]) if (Math.abs(r - n) / n <= 0.08) return n;
    return null;
  }

  // Reta t = fase + periodo·k por mínimos quadrados com índices CONHECIDOS, descartando (até 4
  // vezes) o que foge de 3 desvios-MAD. `piso` (s): resíduo abaixo do qual nada é jogado fora.
  // Devolve { periodo, fase, desvioMs, k, t, centro: {t, k} } ou null.
  function retaPorIndices(kIn, tIn, piso) {
    let k = kIn.slice(), t = tIn.slice();
    if (t.length < 4) return null;
    let periodo = NaN, fase = NaN, res = [];
    for (let it = 0; it < 5; it++) {
      const n = t.length, mk = k.reduce((a, b) => a + b, 0) / n, mt = t.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sxy += (k[i] - mk) * (t[i] - mt); sxx += (k[i] - mk) ** 2; }
      if (!(sxx > 0)) return null;
      periodo = sxy / sxx; fase = mt - periodo * mk;
      res = t.map((x, i) => x - (fase + periodo * k[i]));
      const corte = 3 * mediana(res.map(Math.abs)) * 1.4826 + (ehNum(piso) ? piso : 0.01);
      const ficam = res.map((r, i) => i).filter(i => Math.abs(res[i]) <= corte);
      if (ficam.length === t.length || ficam.length < 4) break;
      t = ficam.map(i => t[i]); k = ficam.map(i => k[i]); res = ficam.map(i => res[i]);
    }
    const dp = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
    const mk = k.reduce((a, b) => a + b, 0) / k.length, mt = t.reduce((a, b) => a + b, 0) / t.length;
    return { periodo, fase, desvioMs: dp * 1000, k, t, centro: { t: mt, k: mk } };
  }

  // Numera os ticks em segmentos coerentes: um tick entra no segmento aberto cuja RETA (mínimos
  // quadrados dos ticks que ele já tem) o põe a um número inteiro de batidas (±TOL); senão abre outro
  // segmento. Comparar com a reta, e não com o último tick, é o que separa a transição gradual do
  // Essentia (medida no Chrome: 3 a 6 intervalos de 1,05–1,17 batida levam o tick para o contratempo
  // na intro e no break): de tick em tick cada passo "parece" 1 batida, mas contra a reta o desvio
  // acumula e passa da tolerância. Até 8 ticks o segmento usa `periodoAprox`; depois, a própria reta.
  // Devolve [{ k: [], t: [] }], do maior para o menor.
  function segmentar(t, periodoAprox) {
    const TOL = 0.12, MAX_ABERTOS = 8, abertos = [], todos = [];
    const reta = (s) => {
      const n = s.k.length;
      let b = periodoAprox;
      if (n >= 8 && s.ultK - s.k[0] >= 8) {
        const den = n * s.skk - s.sk * s.sk, p = den > 0 ? (n * s.skt - s.sk * s.st) / den : NaN;
        if (p > 0 && Math.abs(p - periodoAprox) / periodoAprox < 0.05) b = p;
      }
      return { a: s.t0 + (s.st - b * s.sk) / n, b }; // t ≈ a + b·k
    };
    for (const x of t) {
      let melhor = null, erro = TOL, kk = 0;
      for (const s of abertos) {
        const { a, b } = reta(s), f = (x - a) / b, r = Math.round(f);
        if (r <= s.ultK) continue; // mesma batida de um tick que já está lá
        const e = Math.abs(f - r);
        if (e <= erro) { melhor = s; erro = e; kk = r; }
      }
      if (!melhor) {
        melhor = { k: [], t: [], ultK: -1, sk: 0, st: 0, skk: 0, skt: 0, t0: x };
        abertos.push(melhor); todos.push(melhor); kk = 0;
        if (abertos.length > MAX_ABERTOS) abertos.splice(abertos.indexOf(abertos.reduce((p, q) => (p.t[p.t.length - 1] < q.t[q.t.length - 1] ? p : q))), 1);
      }
      const s = melhor, dt = x - s.t0;
      s.k.push(kk); s.t.push(x); s.ultK = kk;
      s.sk += kk; s.st += dt; s.skk += kk * kk; s.skt += kk * dt;
    }
    return todos.map(s => ({ k: s.k, t: s.t })).sort((a, b) => b.t.length - a.t.length);
  }

  // Ajusta tick = fase + k·período nos ticks da faixa inteira, robusto a trechos em contratempo, em
  // dobro, a ticks faltando e a outliers. `ticks` em s; `periodoAprox` em s.
  // Devolve { periodo, fase, desvioMs, usados, vao, centro: {t, k}, cobertura, extensao, desvioTodosMs }
  // ou null (menos de 4 ticks úteis).
  function ajustarReta(ticks, periodoAprox) {
    const t = Array.from(ticks || []).filter(ehNum).sort((a, b) => a - b);
    if (t.length < 4 || !(periodoAprox > 0)) return null;
    const segs = segmentar(t, periodoAprox);
    if (!segs.length || segs[0].t.length < 4) return null;
    let r = retaPorIndices(segs[0].k, segs[0].t);
    if (!r) return null;
    // junta os outros segmentos que caem na MESMA fase da reta do maior (contratempo fica de fora)
    let K = r.k.slice(), T = r.t.slice();
    for (const s of segs.slice(1)) {
      if (s.t.length < 3) continue;
      const fr = s.t.map(x => (x - r.fase) / r.periodo);
      const dif = fr.map(f => f - Math.round(f));
      // o segmento inteiro tem de cair na batida da reta (não só na média): andamento que oscila faz
      // trechos que "acertam" a fase por acaso, com metade dos ticks adiantada e metade atrasada
      if (Math.abs(mediana(dif)) > 0.06 || mediana(dif.map(Math.abs)) > 0.1) continue;
      for (let i = 0; i < s.t.length; i++) if (Math.abs(dif[i]) <= 0.2) { K.push(Math.round(fr[i])); T.push(s.t[i]); }
      const r2 = retaPorIndices(K, T);
      if (r2) { r = r2; K = r.k.slice(); T = r.t.slice(); }
    }
    // índices repetidos (dois ticks na mesma batida) ficam só uma vez: o mais perto da reta
    const porK = new Map();
    for (let i = 0; i < K.length; i++) {
      const e = Math.abs(T[i] - (r.fase + r.periodo * K[i])), j = porK.get(K[i]);
      if (j === undefined || e < Math.abs(T[j] - (r.fase + r.periodo * K[j]))) porK.set(K[i], i);
    }
    const idx = Array.from(porK.values());
    const fim = retaPorIndices(idx.map(i => K[i]), idx.map(i => T[i])) || r;
    const ks = fim.k, vao = Math.max(...ks) - Math.min(...ks);
    // quanto da faixa a reta explica: fração dos ticks e do tempo entre o 1º e o último tick. Andamento
    // que oscila dá retas boas só em trechos (cobertura baixa); o desvio de TODOS os ticks contra a reta
    // (cada um na batida mais perto) mostra o quanto uma grade fixa erraria
    const res = t.map(x => { const f = (x - fim.fase) / fim.periodo; return (f - Math.round(f)) * fim.periodo; });
    const desvioTodosMs = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length) * 1000;
    return { periodo: fim.periodo, fase: fim.fase, desvioMs: fim.desvioMs, usados: fim.t.length, vao, centro: fim.centro,
      cobertura: fim.t.length / t.length, extensao: vao * fim.periodo / ((t[t.length - 1] - t[0]) || 1), desvioTodosMs };
  }

  // Consenso de oitava: dobra cada candidato para a faixa de DJ e devolve a mediana. Candidatos
  // fora de 4% da mediana ficam em `divergentes` (nome) — informação, não veto.
  function consenso(candidatos, faixa) {
    const f = faixa || FAIXA_DJ;
    const v = (candidatos || []).filter(c => c && ehNum(c.bpm) && c.bpm > 0)
      .map(c => ({ nome: c.nome, bruto: c.bpm, dobrado: dobrarParaFaixa(c.bpm, f.min, f.max) }));
    if (!v.length) return null;
    const alvo = mediana(v.map(x => x.dobrado));
    return { alvo, divergentes: v.filter(x => Math.abs(x.dobrado - alvo) / alvo > 0.04).map(x => x.nome), considerados: v.length };
  }

  // ---- envelope de graves e ajuste fino no bumbo ---------------------------------------------
  // Envelope RMS dos graves (passa-baixa de 2 polos em 150 Hz), 1 valor por ~1 ms, cada um a
  // média de 10 ms centrada nele; e `sinal`, o grave filtrado em si, 1 amostra por ~1 ms. Roda no
  // WORKER (painel.js injeta o texto desta função no Blob): por isso não usa nada de fora dela.
  // `atraso`: atraso de grupo do filtro em baixa frequência (s); `janela`: largura da média (s). Os
  // dois são descontados na hora de achar o ataque (ataqueEm).
  function envelopeGrave(pcm, taxa) {
    var fc = 150, hop = Math.max(1, Math.round(taxa / 1000));
    var a = Math.exp(-2 * Math.PI * fc / taxa), b = 1 - a;
    var n = Math.floor(pcm.length / hop), quadro = new Float64Array(n), out = new Float32Array(n), sinal = new Float32Array(n);
    var y1 = 0, y2 = 0, i = 0, j;
    for (j = 0; j < n; j++) {
      var s = 0, m = 0;
      for (var q = 0; q < hop; q++, i++) { y1 = b * pcm[i] + a * y1; y2 = b * y1 + a * y2; s += y2 * y2; m += y2; }
      quadro[j] = s; sinal[j] = m / hop; // o próprio grave a ~1 kHz: a altura da nota do baixo (harmoniaPorFase)
    }
    // média CENTRADA de 10 quadros (10 ms ≈ meio ciclo de 50 Hz): sem ela o RMS de 1 ms ondula com
    // a própria senoide do bumbo e o "ataque" cai num vale qualquer; centrada, não atrasa
    var M = 10, h = M >> 1, soma = 0;
    for (j = 0; j < Math.min(n, M - h); j++) soma += quadro[j];
    for (j = 0; j < n; j++) {
      var cont = Math.min(n, j + M - h) - Math.max(0, j - h);
      out[j] = Math.sqrt(soma / (cont * hop));
      if (j + M - h < n) soma += quadro[j + M - h];
      if (j - h >= 0) soma -= quadro[j - h];
    }
    return { valores: out, sinal: sinal, passo: hop / taxa, atraso: 2 * a / b / taxa, janela: M * hop / taxa };
  }

  // Envelope válido? { valores (array-like), passo > 0, atraso? }
  const LIMIAR = 0.3; // fração da subida (base → pico) que marca o ataque
  const envelopeOk = e => !!e && e.valores && e.valores.length > 16 && e.passo > 0;

  // Ataque do bumbo perto de `centro` (s): o pico do envelope em [centro − meia, centro + meia] e,
  // a partir do mínimo antes dele, o ponto em que o envelope cruza LIMIAR da subida (base → pico), interpolado.
  // Devolve { t, forca } (forca = pico − base) ou null.
  function ataqueEm(env, centro, meia) {
    const v = env.valores, dt = env.passo, atr = ehNum(env.atraso) ? env.atraso : 0;
    const j0 = Math.max(1, Math.ceil((centro - meia + atr) / dt - 0.5)), j1 = Math.min(v.length - 1, Math.floor((centro + meia + atr) / dt - 0.5));
    if (j1 - j0 < 3) return null;
    let jp = j0;
    for (let j = j0 + 1; j <= j1; j++) if (v[j] > v[jp]) jp = j;
    if (jp === j0) return null; // ainda subindo da janela anterior: não é ataque aqui
    // base: o mínimo nos ~60 ms antes do pico (sem sair da janela por mais de meia)
    const jMin = Math.max(0, jp - Math.max(6, Math.round(0.06 / dt)), j0 - Math.round(meia / dt));
    let jb = jp;
    for (let j = jp - 1; j >= jMin; j--) if (v[j] <= v[jb]) jb = j;
    const pico = v[jp], base = v[jb], forca = pico - base;
    if (!(forca > 0) || jb === jp) return null;
    // da base para FRENTE até cruzar LIMIAR da subida (andar para trás do pico pararia num vale da
    // ondulação que sobra no envelope de um bumbo de 60–70 Hz)
    const lim = base + LIMIAR * forca;
    let j = jb + 1;
    while (j < jp && v[j] < lim) j++;
    // v[j-1] < lim <= v[j]: interpola dentro do quadro
    const fr = (lim - v[j - 1]) / ((v[j] - v[j - 1]) || 1);
    // a média centrada adianta o cruzamento: num degrau, a energia sobe em rampa por toda a janela e
    // o RMS passa de LIMIAR quando a energia passa de LIMIAR² — (½ − LIMIAR²)·janela antes do degrau
    const adianto = ehNum(env.janela) ? (0.5 - LIMIAR * LIMIAR) * env.janela : 0;
    const t = (j - 1 + fr + 0.5) * dt - atr + adianto;
    if (Math.abs(t - centro) > meia) return null; // o pico está aqui, mas a subida começou antes: é da batida vizinha
    return { t, forca };
  }

  // Fase do bumbo perto da batida dos ticks: dobra o fluxo positivo do envelope (só subidas) sobre a
  // grade e devolve o deslocamento (s) de maior subida em relação a `fase`, procurado só em ±P/4.
  // O bumbo REFINA a batida dos ticks, não a troca pelo contratempo: numa faixa sem bumbo o baixo
  // no contratempo ganharia e a grade sairia meia batida fora (caso medido no banco sintético).
  function faseDoBumbo(env, periodo, fase) {
    const v = env.valores, dt = env.passo, atr = ehNum(env.atraso) ? env.atraso : 0;
    const nb = Math.max(16, Math.round(periodo / 0.001)), h = new Float64Array(nb);
    for (let j = 1; j < v.length; j++) {
      const d = v[j] - v[j - 1];
      if (d <= 0) continue;
      const t = j * dt - atr;
      h[Math.floor(modulo(t - fase, periodo) / periodo * nb) % nb] += d;
    }
    const L = Math.max(1, Math.round(nb / 200)); // suaviza ~0,5% do período
    let melhor = 0, bm = -1;
    for (let b = 0; b < nb; b++) {
      if (b > nb / 4 && b < nb - nb / 4) continue; // só ±P/4 em volta da batida dos ticks
      let s = 0;
      for (let q = -L; q <= L; q++) s += h[(b + q + nb) % nb];
      if (s > bm) { bm = s; melhor = b; }
    }
    let off = (melhor + 0.5) / nb * periodo;
    if (off >= periodo / 2) off -= periodo;
    return off;
  }

  // Refina a grade (periodo, fase) nos ataques do bumbo. `fase`/ticks e envelope no mesmo relógio
  // (s desde o início do trecho analisado). Devolve
  //   { periodo, fase, desvioMs, bumbos, vao, ajusteMs, centro: {t, k}, compasso: {d, fonte, margem} } ou null
  // (null: menos de 16 bumbos fortes, ou a reta nos bumbos fugiu da dos ticks). `compasso.d`: qual
  // batida (k mod 4, com k = 0 em `fase` devolvida) é o 1 do compasso.
  function refinarNoBumbo(env, periodo, fase) {
    if (!envelopeOk(env) || !(periodo > 0) || !ehNum(fase)) return null;
    let melhor = lacoNoBumbo(env, periodo, fase, fase + faseDoBumbo(env, periodo, fase), 0.4);
    // falhou, ou ancorou em pouca coisa (menos de 1/3 das batidas): o bumbo pode estar no contratempo dos ticks
    if (!melhor || melhor.bumbos < CONTRATEMPO.cobertura * env.valores.length * env.passo / periodo) {
      const ct = bumboNoContratempo(env, periodo, fase);
      if (ct && (!melhor || ct.bumbos > melhor.bumbos)) melhor = ct;
    }
    if (melhor) {
      melhor.compasso = escolherCompasso(env, melhor);
      delete melhor.fortes; delete melhor.kIni; delete melhor.kFim;
    }
    return melhor;
  }

  // BUMBO NO CONTRATEMPO DOS TICKS (2026-11-08, "Dancin (Mastered)", Arturo Garces, 122 BPM): o Essentia trava a
  // faixa INTEIRA no transiente agudo do contratempo (887 de 902 ticks meia batida fora do bumbo) e o faseDoBumbo,
  // que só anda ±P/4, não alcança o bumbo; o refinamento desistia, a grade ficava nos ticks (no contratempo) e o
  // CUE e o SYNC caíam meia batida fora. Só se tenta quando o refinamento na batida dos ticks FALHOU (faixa em que
  // ele funciona não muda nada) e só se aceita com quatro provas de bumbo: (1) a subida do grave perto do contratempo
  // dos ticks é `razao` vezes a de perto dos ticks (nesta faixa, 2,35); (2) a grade refeita lá passa no mesmo crivo
  // do refinamento normal (período, desvio); (3) os bumbos cobrem 1/3+ das batidas; (4) o som que bate lá VARRE
  // PARA BAIXO, como bumbo: a frequência do grave nos 15 ms depois do ataque é `varre` vezes a de 60–120 ms depois
  // (nesta faixa 92 → 56 Hz, 1,64; bumbo do banco sintético 4,1). É a prova que separa o bumbo da nota de baixo no
  // contratempo de uma faixa SEM bumbo (banco sintético "sem bumbo": 87 → 80 Hz, 1,09), que tem o mesmo desenho de
  // grave: sem ela a grade pulava meia batida para o baixo. Com bumbo forte/fraco alternado (o fraco atrasado
  // ~25 ms, como nesta faixa), a reta com os dois fica frouxa (15,8 ms): tenta de novo só com os fortes (corte 0,7).
  const CONTRATEMPO = { razao: 2, cobertura: 1 / 3, cortes: [0.4, 0.7], varre: 1.25 };
  // Frequência média do grave (cruzamentos de zero de `env.sinal`) em [0, 15) ms e [60, 120) ms depois do ataque de
  // até 200 bumbos da grade `m`; devolve a razão da primeira pela segunda (NaN sem `sinal` ou sem bumbos).
  function varredura(env, m) {
    const x = env.sinal, dt = env.passo, atr = ehNum(env.atraso) ? env.atraso : 0;
    if (!x || x.length !== env.valores.length) return NaN;
    const ks = Array.from(m.fortes.keys()), passo = Math.max(1, Math.floor(ks.length / 200)), soma = [0, 0], cont = [0, 0];
    const freq = (j0, j1) => {
      let pri = NaN, ult = NaN, n = 0;
      for (let j = Math.max(1, j0); j < Math.min(x.length, j1); j++) {
        if ((x[j - 1] < 0) === (x[j] < 0)) continue;
        const z = j - 1 + x[j - 1] / (x[j - 1] - x[j]);
        if (!n) pri = z;
        ult = z; n += 1;
      }
      return n >= 2 ? (n - 1) / (2 * (ult - pri) * dt) : NaN;
    };
    for (let i = 0; i < ks.length; i += passo) {
      const a = ataqueEm(env, m.fase + ks[i] * m.periodo, m.periodo / 10);
      if (!a) continue;
      const j0 = Math.round((a.t + atr) / dt);
      [[0, 0.015], [0.06, 0.12]].forEach(([de, ate], w) => {
        const f = freq(j0 + Math.round(de / dt), j0 + Math.round(ate / dt));
        if (ehNum(f)) { soma[w] += f; cont[w] += 1; }
      });
    }
    return cont[0] && cont[1] ? (soma[0] / cont[0]) / (soma[1] / cont[1]) : NaN;
  }
  function subidaPerto(env, periodo, fase) {
    const v = env.valores, dt = env.passo, atr = ehNum(env.atraso) ? env.atraso : 0;
    let s = 0;
    for (let j = 1; j < v.length; j++) {
      const d = v[j] - v[j - 1];
      if (d <= 0) continue;
      if (Math.abs(modulo(j * dt - atr - fase + periodo / 2, periodo) - periodo / 2) <= periodo / 8) s += d;
    }
    return s;
  }
  function bumboNoContratempo(env, periodo, fase) {
    const meio = fase + periodo / 2;
    if (!(subidaPerto(env, periodo, meio) >= CONTRATEMPO.razao * subidaPerto(env, periodo, fase))) return null;
    const F0 = meio + faseDoBumbo(env, periodo, meio), batidas = env.valores.length * env.passo / periodo;
    for (const corte of CONTRATEMPO.cortes) {
      const m = lacoNoBumbo(env, periodo, meio, F0, corte);
      if (!m || m.bumbos < CONTRATEMPO.cobertura * batidas) continue;
      if (!(varredura(env, m) >= CONTRATEMPO.varre)) return null; // não varre: é nota de baixo, não bumbo
      m.contratempo = true;
      return m;
    }
    return null;
  }

  // As 3 voltas do refinamento a partir de F (já perto do bumbo), com `fase` a batida de referência (a reta não
  // pode fugir dela mais de ¼ de batida) e `corte` a fração do quantil 90 da força que conta como bumbo forte.
  function lacoNoBumbo(env, periodo, fase, F0, corte) {
    const dur = env.valores.length * env.passo;
    let P = periodo, F = F0;
    let melhor = null;
    for (let volta = 0; volta < 3; volta++) {
      const meia = volta === 0 ? P / 6 : P / 10;
      const kIni = Math.ceil((meia - F) / P), kFim = Math.floor((dur - meia - F) / P);
      const achados = [];
      for (let k = kIni; k <= kFim; k++) {
        const a = ataqueEm(env, F + k * P, meia);
        if (a) achados.push({ k, t: a.t, forca: a.forca });
      }
      if (achados.length < 16) break;
      const ref = quantil(achados.map(a => a.forca), 0.9);
      const fortes = achados.filter(a => a.forca >= corte * ref);
      if (fortes.length < 16) break;
      const r = retaPorIndices(fortes.map(a => a.k), fortes.map(a => a.t), 0.003);
      // reta frouxa (ataques espalhados pela janela: não é bumbo, é chimbal ou ruído) ou que fugiu
      // da batida dos ticks (mais de ¼ de batida, ou período 0,5% diferente): fica a dos ticks
      if (!r || Math.abs(r.periodo - periodo) / periodo > 0.005 || r.desvioMs > 30 * r.periodo) break;
      if (Math.abs(modulo(r.fase - fase + periodo / 2, periodo) - periodo / 2) > periodo / 4) break;
      const ks = r.k;
      P = r.periodo; F = r.fase;
      melhor = { periodo: P, fase: F, desvioMs: r.desvioMs, bumbos: r.t.length, vao: Math.max(...ks) - Math.min(...ks),
        ajusteMs: (modulo(F - fase + P / 2, P) - P / 2) * 1000, centro: r.centro, fortes: new Map(fortes.map(a => [a.k, a.forca])), kIni, kFim };
    }
    return melhor;
  }

  // TROCA DE HARMONIA do baixo por fase (VB-68, 2026-11-08): a nota do baixo muda no 1 do compasso. Espectro do
  // grave (`env.sinal`) por batida, em 25 semitons de 32,7 a 131 Hz (Goertzel, janela de Hann de 1 batida); soma em
  // BLOCOS de 4 batidas a partir de cada fase d e mede a novidade 1 − cos entre um bloco e o anterior. O bloco
  // alinhado ao compasso tem uma nota só e muda inteiro de um para o outro; o desalinhado mistura dois compassos e
  // muda menos. E qualquer bloco de 4 batidas tem cada posição do compasso uma vez: o acento (nota longa no 2,
  // bumbo no 1 e no 3) entra igual em todas as fases e não pesa — é o que o grave mais forte não tem.
  // Devolve { d, forca, margem, porFase } ou null (sem `sinal`, batida curta demais). Abster-se (forca/margem
  // baixas) é o caso do baixo de uma nota só: medido no banco sintético, forca ≤ 0,005 sem troca e ≥ 0,044 com.
  const HARMONIA = { notas: 25, f0: 32.7, forcaMin: 0.02, margemMin: 0.15 };
  function harmoniaPorFase(env, g) {
    const x = env.sinal, dt = env.passo, atr = ehNum(env.atraso) ? env.atraso : 0;
    if (!x || x.length !== env.valores.length) return null;
    const N = Math.round(g.periodo / dt);
    if (N < 32) return null;
    const hann = new Float64Array(N), coef = [];
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    for (let b = 0; b < HARMONIA.notas; b++) coef.push(2 * Math.cos(2 * Math.PI * HARMONIA.f0 * 2 ** (b / 12) * dt));
    const esp = new Map();
    for (let k = g.kIni; k <= g.kFim; k++) {
      const j0 = Math.round((g.fase + k * g.periodo + atr) / dt);
      if (j0 < 0 || j0 + N > x.length) continue;
      const v = new Float64Array(HARMONIA.notas);
      for (let b = 0; b < HARMONIA.notas; b++) {
        const c = coef[b];
        let s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) { const s = x[j0 + i] * hann[i] + c * s1 - s2; s2 = s1; s1 = s; }
        v[b] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
      }
      esp.set(k, v);
    }
    const bloco = (k0) => {
      const u = new Float64Array(HARMONIA.notas);
      for (let i = 0; i < 4; i++) { const v = esp.get(k0 + i); if (!v) return null; for (let b = 0; b < u.length; b++) u[b] += v[b]; }
      let nrm = 0;
      for (let b = 0; b < u.length; b++) nrm += u[b] * u[b];
      nrm = Math.sqrt(nrm);
      if (!(nrm > 0)) return null;
      for (let b = 0; b < u.length; b++) u[b] /= nrm;
      return u;
    };
    const soma = [0, 0, 0, 0], cont = [0, 0, 0, 0];
    for (let k = g.kIni + 4; k + 3 <= g.kFim; k++) {
      const a = bloco(k - 4), b = bloco(k);
      if (!a || !b) continue;
      let cs = 0;
      for (let i = 0; i < a.length; i++) cs += a[i] * b[i];
      soma[modulo(k, 4)] += 1 - cs; cont[modulo(k, 4)] += 1;
    }
    if (cont.some(c => c < 4)) return null;
    const porFase = soma.map((s, d) => s / cont[d]);
    const ordem = [0, 1, 2, 3].sort((p, q) => porFase[q] - porFase[p]), forca = porFase[ordem[0]];
    return { d: ordem[0], forca, margem: forca > 0 ? (forca - porFase[ordem[1]]) / forca : 0, porFase };
  }

  // O 1 do compasso: média do envelope de graves na 1ª metade de cada batida, por fase k mod 4. A
  // fase de mais grave ganha; com margem < 4% (bumbo igual em toda batida e baixo neutro) vale a
  // ENTRADA do bumbo (batida forte depois de 8+ batidas sem bumbo: começo de frase), se houver.
  // Ordem: 2+ entradas que concordam > troca de harmonia confiante > 1 entrada com grave empatado > grave.
  function escolherCompasso(env, g) {
    const v = env.valores, dt = env.passo, atr = ehNum(env.atraso) ? env.atraso : 0;
    const soma = [0, 0, 0, 0], cont = [0, 0, 0, 0];
    for (let k = g.kIni; k <= g.kFim; k++) {
      const t = g.fase + k * g.periodo, j0 = Math.max(0, Math.round((t + atr) / dt)), j1 = Math.min(v.length, Math.round((t + atr + g.periodo / 2) / dt));
      if (j1 <= j0) continue;
      let s = 0;
      for (let j = j0; j < j1; j++) s += v[j];
      const d = modulo(k, 4);
      soma[d] += s / (j1 - j0); cont[d] += 1;
    }
    const media = soma.map((s, d) => (cont[d] ? s / cont[d] : 0));
    const ordem = [0, 1, 2, 3].sort((a, b) => media[b] - media[a]);
    const margem = media[ordem[0]] > 0 ? (media[ordem[0]] - media[ordem[1]]) / media[ordem[0]] : 0;
    // ENTRADA: batida forte com no máximo 2 fortes nas 8 de antes (intro ou break: nada, ou só a nota solta de um
    // baixo) e 4+ nas 8 de depois (o bumbo entrou, reto ou quebrado). É começo de frase, então cai no 1. Uma
    // entrada só conta uma vez (pula 8 batidas). E a batida da entrada tem a força do que vem depois (≥ 60% da
    // mediana): a nota de baixo sozinha logo antes do bumbo (anacruse no 4) não é a entrada. Antes (até
    // 2026-10-27) exigia zero fortes antes: um baixo que entra no meio da intro tirava o voto do bumbo.
    const votos = [0, 0, 0, 0], forte = k => g.fortes.has(k);
    for (let k = g.kIni + 8; k <= g.kFim - 7; k++) {
      if (!forte(k)) continue;
      let antes = 0;
      const depois = [];
      for (let q = 1; q <= 8; q++) if (forte(k - q)) antes += 1;
      if (antes > 2) continue;
      for (let q = 1; q <= 8; q++) if (forte(k + q)) depois.push(g.fortes.get(k + q));
      if (depois.length < 3 || g.fortes.get(k) < 0.6 * quantil(depois, 0.5)) continue;
      // e não é só mais uma do padrão solto de antes (a mesma nota de baixo de 4 em 4): se a batida k−4 também
      // foi forte, a entrada tem de bater mais forte que ela (o bumbo somado ao baixo, não o baixo sozinho)
      if (forte(k - 4) && g.fortes.get(k) < 1.5 * g.fortes.get(k - 4)) continue;
      votos[modulo(k, 4)] += 1;
      k += 7;
    }
    const totalVotos = votos.reduce((a, b) => a + b, 0), dv = votos.indexOf(Math.max(...votos));
    // Duas entradas ou mais que concordam (2/3) mandam sobre o grave: a linha de baixo que acentua o 2, o 3 ou o 4
    // ganhava a média do grave e tirava o 1 do lugar — o SYNC por compasso punha a caixa de uma faixa no bumbo da
    // outra (defeito de 2026-10-27, biblioteca/testar-bpm.js "baixo longo na batida N").
    if (totalVotos >= 2 && votos[dv] * 3 >= totalVotos * 2) return { d: dv, fonte: 'entrada', margem, votos: totalVotos, porFase: votos };
    // sem entradas que bastem (faixa sem intro nem break, VB-68): a troca de harmonia do baixo, se for clara
    const h = harmoniaPorFase(env, g), harmonia = h ? h.margem : null;
    if (h && h.forca >= HARMONIA.forcaMin && h.margem >= HARMONIA.margemMin) return { d: h.d, fonte: 'harmonia', margem, harmonia, votos: totalVotos, porFase: votos };
    if (margem < 0.04 && totalVotos > 0) return { d: dv, fonte: 'entrada', margem, harmonia, votos: totalVotos, porFase: votos };
    return { d: ordem[0], fonte: 'graves', margem, harmonia, votos: totalVotos, porFase: votos };
  }

  // O caso completo. `candidatos`: [{ nome, bpm, ticks? }]; `inicio`: s da faixa em que os ticks
  // (e o envelope) começam (0 quando a análise cobre a faixa inteira); `envelope`: saída de
  // envelopeGrave sobre o mesmo trecho (opcional). Devolve
  //   { bpm, grade: { bpm, primeira } | null, fonte, desvioMs, instavel?, divergentes, ancora?, compasso? }  ou null.
  // `instavel`: houve ticks, mas nenhuma reta ficou dentro de LIMITE_DESVIO — andamento que oscila;
  // o BPM é o consenso dos estimadores (1 casa) e não há grade (o motor estima pelo BPM).
  // `bpm` (6 casas) É o da grade quando há grade. Com envelope, `primeira` é o 1º tempo forte (1 do
  // compasso) em [0, 4 períodos); sem envelope não há como saber o compasso e fica em [0, período).
  function resolver(candidatos, inicio, faixa, envelope) {
    const c = consenso(candidatos, faixa);
    if (!c) return null;
    const ini = ehNum(inicio) ? inicio : 0, p0 = 60 / c.alvo;
    let melhor = null, frouxo = null;
    for (const cand of candidatos) {
      if (!cand || !cand.ticks) continue;
      const ticks = Array.from(cand.ticks).filter(ehNum);
      const n = multiploDosTicks(ticks, p0);
      if (n === null) continue;
      const r = ajustarReta(ticks, p0 * n);
      if (!r || r.usados < 8) continue;
      const periodo = r.periodo / n;
      if (Math.abs(periodo - p0) / p0 > 0.04) continue; // o ajuste fugiu do consenso: descartado
      // a reta tem de explicar a faixa, não um trecho: metade dos ticks e 60% do tempo coberto
      if (r.cobertura < 0.5 || r.extensao < 0.6) { if (!frouxo || r.desvioTodosMs < frouxo.desvioMs) frouxo = { desvioMs: r.desvioTodosMs }; continue; }
      if (!melhor || r.desvioMs < melhor.desvioMs) melhor = { nome: cand.nome, periodo, fase: r.fase, centro: { t: r.centro.t, b: r.centro.k * n }, desvioMs: r.desvioMs };
    }
    if (!melhor || melhor.desvioMs > LIMITE_DESVIO * p0 * 1000) {
      const d = melhor || frouxo;
      return { bpm: arred(c.alvo, 1), grade: null, fonte: 'consenso', desvioMs: d ? arred(d.desvioMs, 1) : null, instavel: !!d, divergentes: c.divergentes };
    }
    const fino = envelope ? refinarNoBumbo(envelope, melhor.periodo, melhor.fase) : null;
    const base = fino ? { periodo: fino.periodo, centro: { t: fino.centro.t, b: fino.centro.k } } : melhor;
    // A fase é reancorada no CENTRO das batidas usadas com o período já arredondado (6 casas): o
    // erro que sobra do arredondamento se reparte pelas duas pontas.
    const bpm = arred(60 / base.periodo, CASAS_BPM), periodo = 60 / bpm;
    let fase = base.centro.t - periodo * base.centro.b, vao = periodo;
    if (fino) { fase += fino.compasso.d * periodo; vao = 4 * periodo; } // o 1 do compasso
    const saida = { bpm, grade: { bpm, primeira: arred(modulo(fase + ini, vao), CASAS_TEMPO) }, fonte: melhor.nome, desvioMs: arred(melhor.desvioMs, 1), divergentes: c.divergentes };
    if (fino) {
      saida.fonte = melhor.nome + '+bumbo';
      saida.ancora = { bumbos: fino.bumbos, desvioMs: arred(fino.desvioMs, 2), ajusteMs: arred(fino.ajusteMs, 1) };
      saida.compasso = { fonte: fino.compasso.fonte, margem: arred(fino.compasso.margem, 3) };
    }
    return saida;
  }

  return { FAIXA_DJ, LIMITE_DESVIO, CASAS_BPM, dobrarParaFaixa, multiploDosTicks, retaPorIndices, segmentar, ajustarReta, consenso,
    envelopeGrave, ataqueEm, faseDoBumbo, refinarNoBumbo, escolherCompasso, resolver };
});
