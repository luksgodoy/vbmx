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

  // Fluxo espectral de BANDA LARGA (médios e agudos, 1,5–12 kHz): o ataque percussivo de quem NÃO é grave (caixa, hat,
  // palma, loop de intro). Soma, por quadro de 1024 amostras (hop de 5 ms), as subidas do log-espectro; roda no
  // WORKER junto do envelopeGrave (painel.js injeta o texto desta função): autocontida, sem nada de fora dela.
  // `atraso` é o instante do centro do quadro (s) — o viés fixo do quadro sai na mediana por faixa (refinarBatidas).
  function fluxoAmplo(pcm, taxa) {
    var N = 1024, hop = Math.max(1, Math.round(taxa * 0.005)), n = pcm.length >= N ? Math.floor((pcm.length - N) / hop) + 1 : 0;
    var cos = new Float64Array(N / 2), sen = new Float64Array(N / 2), jan = new Float64Array(N), rev = new Uint16Array(N), i, j, k;
    for (i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sen[i] = -Math.sin(2 * Math.PI * i / N); }
    for (i = 0; i < N; i++) { jan[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); var r = 0; for (j = 0; j < 10; j++) if (i & (1 << j)) r |= 1 << (9 - j); rev[i] = r; }
    var b0 = Math.ceil(1500 / (taxa / N)), b1 = Math.min(N / 2 - 1, Math.floor(12000 / (taxa / N)));
    var re = new Float64Array(N), im = new Float64Array(N), ant = new Float64Array(b1 - b0 + 1), out = new Float32Array(n);
    for (var q = 0; q < n; q++) {
      var o = q * hop;
      for (i = 0; i < N; i++) { re[rev[i]] = pcm[o + i] * jan[i]; im[rev[i]] = 0; }
      for (var len = 2; len <= N; len <<= 1) {
        var meio = len >> 1, passo = N / len;
        for (i = 0; i < N; i += len) for (k = 0; k < meio; k++) {
          var wr = cos[k * passo], wi = sen[k * passo], a = i + k, bb = a + meio;
          var tr = re[bb] * wr - im[bb] * wi, ti = re[bb] * wi + im[bb] * wr;
          re[bb] = re[a] - tr; im[bb] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      var fl = 0;
      for (k = b0; k <= b1; k++) { var L = Math.log(1 + 50 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N * 100), d = L - ant[k - b0]; if (d > 0 && q > 0) fl += d; ant[k - b0] = L; }
      out[q] = fl;
    }
    return { valores: out, passo: hop / taxa, atraso: -(N / 2) / taxa, meio: 0 };
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
    } else if (!(varredura(env, melhor) >= CONTRATEMPO.varre)) {
      // VB-69 (1): ancorou bem, mas o que bate lá NÃO varre como bumbo (baixo no contratempo, house com baixo no
      // off-beat) e o grave perto do outro lado dos ticks sobe mais que perto deles: tenta o contratempo; só troca
      // se lá o som varre. varredura NaN (sem `sinal`) não troca nada.
      const ct = bumboNoContratempo(env, periodo, fase);
      if (ct) melhor = ct;
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
  // 2026-11-09, "The Pimp (Original Mix)" (Makito, 122 BPM, Essentia real): razão 1,48 (o grave do contratempo dos ticks
  // sobe só 1,5× o de perto deles — nota de baixo e cauda soltas por toda a batida) e o corte em 2 desistia: grade nos
  // ticks (degara, 0,249 s), sem bumbo e SEM 1 do compasso; o CUE caía fora do tempo 1. Com 1,3 passa, e o resto do
  // crivo (cobertura 0,65, varredura 1,64, 6 entradas na mesma fase) é quem separa bumbo de baixo. Não baixe mais:
  // 1,1 já é empate entre os dois lados (banco sintético, baixoContraAmp 0,8: bumbo e baixo de mesma força).
  const CONTRATEMPO = { razao: 1.3, cobertura: 1 / 3, cortes: [0.4, 0.7], varre: 1.25 };
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

  // ---- refino por batida e fase por trechos (VB-refino, 2026-11-09) -------------------------------------------------
  // A grade (bpm, primeira) é uma reta; cada batida dela pode estar a alguns ms do ataque de fato (faixa tocada, swing,
  // deriva). Aqui, PARA CADA BATIDA, procura-se numa janela curta o ponto de maior subida de energia, com parábola no
  // pico (sub-amostra), e se devolve a batida refinada e uma CONFIANÇA 0–1. A grade que o motor usa NÃO muda: o
  // resultado (`ritmo`) é um dado ao lado dela — tempos refinados, confiança, fase por trechos e a marca de andamento
  // variável. Cascata, por batida (nunca se desloca sem evidência):
  //   (a) GRAVE: o envelope de graves tem ataque claro na janela → é o bumbo/baixo;
  //   (b) ESPECTRAL: sem grave ali (intro, break, faixa sem bumbo), o fluxo espectral de banda larga na mesma janela;
  //   (c) MANTIDA: nenhum dos dois → fica onde a grade manda, confiança baixa.
  // Deslocamento limitado a LIMITE_S e descartado se destoa das vizinhas (COERENCIA_S): vira (c). O ponto de cada banda
  // é medido contra a MEDIANA da própria banda na faixa — o viés fixo "ponto de maior subida × 30% da subida onde a
  // âncora foi posta" não desloca a grade inteira; só o que foge do comum de cada batida entra como deslocamento.
  const REFINO = { janelaS: 0.035, limiteS: 0.040, coerenciaS: 0.015, vizinhas: 4, secaoBatidas: 32, secaoMin: 8, epsS: 0.004,
    confereS: 0.006, zonaMortaS: 0.004, zonaMortaEspectralS: 0.008, variavelAjusteS: 0.030, variavelSaltoS: 0.025, variavelLimiteFracao: 0.2, fracaoFracaS: 0.6, forcaMin: 0.35, razaoMin: 2.5, fluxoRazaoMin: 3 };

  // Candidato de ataque numa série `serie` (valores, passo, atraso, meio) em torno de `t` (s, relógio da série):
  // { tp, forca, razao } ou null. `modo`: 'subida' (envelope: pico da derivada suavizada) ou 'fluxo' (o próprio fluxo).
  function candidatoNaJanela(serie, modo, t, meia, P) {
    const v = serie.valores, dt = serie.passo, atr = ehNum(serie.atraso) ? serie.atraso : 0, meio = ehNum(serie.meio) ? serie.meio : 0.5;
    const idx = (s) => Math.round((s + atr) / dt - meio);
    const tempo = (j) => (j + meio) * dt - atr;
    const j0 = idx(t - meia), j1 = idx(t + meia), pa = Math.max(3, idx(t - P / 2)), pb = Math.min(v.length - 4, idx(t + P / 2));
    if (j0 < 4 || j1 > v.length - 5 || j1 - j0 < 4) return null;
    let y;
    if (modo === 'subida') { // derivada de 3 pontos, média móvel de 5 (≈5 ms): a subida mais íngreme do envelope
      y = (j) => { let s = 0; for (let q = -2; q <= 2; q++) s += (v[j + q + 1] - v[j + q - 1]) / 2; return s / 5; };
    } else y = (j) => v[j];
    let jp = j0, yp = -Infinity;
    for (let j = j0; j <= j1; j++) { const x = y(j); if (x > yp) { yp = x; jp = j; } }
    // o ATAQUE é a PRIMEIRA subida forte: um 2º lóbulo (nota do baixo, cauda do bumbo) pode subir mais, mas vem depois
    for (let j = j0 + 2; j < jp; j++) { const x = y(j); if (x >= 0.6 * yp && x >= y(j - 1) && x >= y(j + 1)) { jp = j; yp = x; break; } }
    if (!(yp > 0) || jp - j0 < 2 || j1 - jp < 2) return null; // no canto da janela: a subida vem de fora (batida vizinha)
    // razão pico / média do |y| em ±P/2: "ataque claro" e não ruído de fundo
    let ms = 0, cn = 0;
    for (let j = pa; j <= pb; j += modo === 'subida' ? 2 : 1) { ms += Math.abs(y(j)); cn++; }
    const razao = cn ? yp / (ms / cn || 1e-12) : 0;
    const ya = y(jp - 1), yb = yp, yc = y(jp + 1), den = ya - 2 * yb + yc;
    const dj = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (ya - yc) / den)) : 0;
    let forca;
    if (modo === 'subida') { // quanto o envelope sobe: máximo nos 40 ms depois menos o mínimo nos 60 ms antes
      let mx = -Infinity, mn = Infinity;
      for (let j = jp; j <= Math.min(v.length - 1, jp + Math.round(0.04 / dt)); j++) if (v[j] > mx) mx = v[j];
      for (let j = Math.max(0, jp - Math.round(0.06 / dt)); j <= jp; j++) if (v[j] < mn) mn = v[j];
      forca = mx - mn;
    } else forca = yp;
    const a30 = modo === 'subida' ? ataqueEm(serie, t, meia) : null; // 2º estimador (30% da subida): só confere o primeiro
    return { tp: tempo(jp + dj), forca, razao, t30: a30 ? a30.t : null };
  }

  const percentil = (v, q) => quantil(v, q);
  // refinarBatidas(env, fluxo, grade, ini, opcoes): grade { bpm, primeira } no relógio da FAIXA; `ini` = s da faixa em que
  // a análise (e as séries) começa. Devolve `ritmo` (ver tempoSeguindo/confiancaEm) ou null sem envelope/grade.
  //   { versao, ini, t[] (s da faixa, batida refinada), c[] (confiança 0–1), m (string: g grave, e espectral, m mantida),
  //     trechos: [{ de, ate, ajusteMs, confianca, evidencia }], variavel, motivo?, resumo: {...}, ajusteMaxMs }
  function refinarBatidas(env, fluxo, grade, ini, opcoes) {
    if (!envelopeOk(env) || !grade || !(grade.bpm > 0) || !ehNum(grade.primeira)) return null;
    const R = Object.assign({}, REFINO, opcoes || {}), P = 60 / grade.bpm, off = ehNum(ini) ? ini : 0;
    const dur = env.valores.length * env.passo;
    const k0 = Math.ceil((off - grade.primeira) / P - 1e-9), nb = Math.floor((off + dur - grade.primeira) / P - 1e-9) - k0 + 1;
    if (nb < 8) return null;
    const temFluxo = !!(fluxo && fluxo.valores && fluxo.valores.length > 16 && fluxo.passo > 0);
    // 1ª passada: candidatos de cada batida nas duas bandas
    const cand = [];
    for (let i = 0; i < nb; i++) {
      const t = grade.primeira + (k0 + i) * P - off; // relógio da série
      cand.push({ t, g: candidatoNaJanela(env, 'subida', t, R.janelaS, P), e: temFluxo ? candidatoNaJanela(fluxo, 'fluxo', t, R.janelaS, P) : null });
    }
    // 2ª: o que conta como "claro" é relativo à faixa (p75 das forças); a mediana de cada banda tira o viés fixo
    const refDe = (k) => { const f = cand.map(c => c[k] && c[k].forca).filter(x => ehNum(x) && x > 0); return f.length >= 4 ? percentil(f, 0.75) : 0; };
    const ref = { g: refDe('g'), e: refDe('e') }, minRazao = { g: R.razaoMin, e: R.fluxoRazaoMin };
    const claro = (c, k) => !!(c[k] && ref[k] > 0 && c[k].forca >= R.forcaMin * ref[k] && c[k].razao >= minRazao[k]);
    const vies = {};
    for (const k of ['g', 'e']) { const d = cand.filter(c => claro(c, k)).map(c => c[k].tp - c.t); vies[k] = d.length >= 4 ? mediana(d) : null; }
    // conferência por um 2º estimador (cruzamento de 30% da subida, ataqueEm): o ponto de maior subida só desloca a batida
    // se os dois, cada um contra o viés da própria faixa, concordam em CONFERE_S; discordância = sem evidência
    const d30 = cand.filter(c => claro(c, 'g') && ehNum(c.g.t30)).map(c => c.g.t30 - c.t), vies30 = d30.length >= 4 ? mediana(d30) : null;
    const confere = (c) => !ehNum(R.confereS) || R.confereS <= 0 || (ehNum(c.g.t30) && vies30 !== null && Math.abs((c.g.tp - c.t - vies.g) - (c.g.t30 - c.t - vies30)) <= R.confereS);
    const ult = cand.map(c => {
      if (claro(c, 'g') && vies.g !== null && confere(c)) return { modo: 'g', d: c.g.tp - c.t - vies.g, c: c.g, k: 'g' };
      if (claro(c, 'e') && vies.e !== null) return { modo: 'e', d: c.e.tp - c.t - vies.e, c: c.e, k: 'e' };
      return { modo: 'm', d: 0 };
    });
    const zm = ehNum(R.zonaMortaS) ? R.zonaMortaS : 0;
    const zmE = ehNum(R.zonaMortaEspectralS) ? R.zonaMortaEspectralS : zm;
    for (const u of ult) if (u.modo !== 'm' && Math.abs(u.d) < (u.modo === 'e' ? zmE : zm)) u.d = 0; // abaixo do ruído do estimador: fica onde a grade manda
    // 3ª: limite de deslocamento e coerência com as vizinhas (mediana dos deslocamentos com evidência ao redor)
    let foraDeLimite = 0, rejeitadasLimite = 0, comEvidencia = 0;
    for (const u of ult) if (u.modo !== 'm') { comEvidencia++; if (Math.abs(u.d) > R.limiteS) { u.modo = 'm'; u.d = 0; u.rejeitada = 'limite'; foraDeLimite++; rejeitadasLimite++; } }
    const ok0 = ult.map(u => u.modo !== 'm');
    for (let i = 0; i < nb; i++) {
      const u = ult[i];
      if (u.modo === 'm') continue;
      const viz = [];
      for (let q = Math.max(0, i - R.vizinhas); q <= Math.min(nb - 1, i + R.vizinhas); q++) if (q !== i && ok0[q]) viz.push(ult[q].d);
      if (viz.length >= 2) {
        const md = mediana(viz), dif = Math.abs(u.d - md);
        if (dif > R.coerenciaS) { u.modo = 'm'; u.d = 0; u.rejeitada = 'incoerente'; foraDeLimite++; continue; }
        u.coer = 1 - dif / R.coerenciaS;
      } else u.coer = 0.4; // sem vizinhas que confirmem: aceita, mas com pouca confiança
    }
    // confiança por batida
    const conf = ult.map(u => {
      if (u.modo === 'm') return 0.1;
      const q = Math.min(1.5, u.c.forca / ref[u.k]) / 1.5, nit = Math.max(0, Math.min(1, (u.c.razao - minRazao[u.k]) / 5));
      const c = 0.15 + 0.85 * (0.4 * q + 0.2 * nit + 0.4 * u.coer);
      return Math.round(Math.min(u.modo === 'g' ? 1 : 0.75, c) * 100) / 100;
    });
    // fase por trechos: mediana dos deslocamentos aceitos de cada trecho de `secaoBatidas`, suavizada 1-2-1 entre vizinhos
    const trechos = [];
    for (let a = 0; a < nb; a += R.secaoBatidas) {
      const b = Math.min(nb, a + R.secaoBatidas), ds = [], cs = [];
      for (let i = a; i < b; i++) if (ult[i].modo !== 'm') { ds.push(ult[i].d); cs.push(conf[i]); }
      const de = grade.primeira + (k0 + a) * P - P / 2, ate = grade.primeira + (k0 + b) * P - P / 2;
      const ev = ds.length >= R.secaoMin && (b - a) >= R.secaoMin;
      trechos.push({ de: arred(de, 3), ate: arred(ate, 3), bruto: ev ? mediana(ds) : 0, evidencia: ev, confianca: ev ? Math.round(cs.reduce((x, y) => x + y, 0) / cs.length * 100) / 100 : 0 });
    }
    const suave = trechos.map((t, i) => {
      if (!t.evidencia) return 0;
      let s = 2 * t.bruto, w = 2;
      for (const j of [i - 1, i + 1]) if (trechos[j] && trechos[j].evidencia) { s += trechos[j].bruto; w += 1; }
      return s / w;
    });
    let ajusteMax = 0, salto = 0;
    trechos.forEach((t, i) => {
      const aj = Math.abs(suave[i]) >= R.epsS ? suave[i] : 0; // só ajusta quando a evidência pede
      t.ajusteMs = arred(aj * 1000, 1); delete t.bruto;
      ajusteMax = Math.max(ajusteMax, Math.abs(aj));
      if (i && t.evidencia && trechos[i - 1].evidencia) salto = Math.max(salto, Math.abs(aj - trechos[i - 1].ajusteMs / 1000));
    });
    // "andamento variável": a fase anda mais que o limite entre trechos, salta, ou muitas batidas com ataque claro caem FORA do
    // limite de deslocamento (a grade reta não as alcança). Batida incoerente com as vizinhas (swing, bumbo forte/fraco) NÃO conta
    // aqui: é padrão da música, não andamento.
    const limiteFracao = comEvidencia ? rejeitadasLimite / comEvidencia : 0;
    let motivo = null;
    if (ajusteMax >= R.variavelAjusteS) motivo = 'deriva';
    else if (salto >= R.variavelSaltoS) motivo = 'salto';
    else if (limiteFracao >= R.variavelLimiteFracao) motivo = 'alem-do-limite';
    const resumo = { batidas: nb, grave: ult.filter(u => u.modo === 'g').length, espectral: ult.filter(u => u.modo === 'e').length, mantida: ult.filter(u => u.modo === 'm').length, rejeitadas: foraDeLimite, alemDoLimite: rejeitadasLimite, evidenciaFraca: ult.filter(u => u.modo === 'm').length / nb >= R.fracaoFracaS };
    const t = ult.map((u, i) => arred(grade.primeira + (k0 + i) * P + u.d, 4));
    return { versao: 1, ini: off, t, c: conf, m: ult.map(u => u.modo).join(''), trechos, variavel: motivo !== null, motivo, resumo, ajusteMaxMs: arred(ajusteMax * 1000, 1) };
  }
  // O andamento real em tLinear (s da faixa, na grade reta): soma a fase do trecho, interpolada entre os centros dos trechos
  // com evidência (sem `ritmo`, ou fora do trecho coberto, devolve tLinear).
  function tempoSeguindo(ritmo, tLinear) {
    if (!ritmo || !Array.isArray(ritmo.trechos) || !ritmo.trechos.length || !ehNum(tLinear)) return tLinear;
    const cs = ritmo.trechos.map(x => ({ c: (x.de + x.ate) / 2, a: x.ajusteMs / 1000 }));
    if (tLinear <= cs[0].c) return tLinear + cs[0].a;
    for (let i = 1; i < cs.length; i++) if (tLinear <= cs[i].c) { const f = (tLinear - cs[i - 1].c) / (cs[i].c - cs[i - 1].c); return tLinear + cs[i - 1].a + f * (cs[i].a - cs[i - 1].a); }
    return tLinear + cs[cs.length - 1].a;
  }
  // Confiança (0–1) da batida mais próxima de t (s da faixa); null sem `ritmo` ou a mais de meio período.
  function confiancaEm(ritmo, t) {
    if (!ritmo || !Array.isArray(ritmo.t) || !ritmo.t.length || !ehNum(t)) return null;
    let lo = 0, hi = ritmo.t.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ritmo.t[m] < t) lo = m + 1; else hi = m; }
    const j = lo > 0 && Math.abs(ritmo.t[lo - 1] - t) <= Math.abs(ritmo.t[lo] - t) ? lo - 1 : lo;
    const meio = ritmo.t.length > 1 ? (ritmo.t[ritmo.t.length - 1] - ritmo.t[0]) / (ritmo.t.length - 1) / 2 : Infinity;
    return Math.abs(ritmo.t[j] - t) <= meio ? ritmo.c[j] : null;
  }

  // O caso completo. `candidatos`: [{ nome, bpm, ticks? }]; `inicio`: s da faixa em que os ticks
  // (e o envelope) começam (0 quando a análise cobre a faixa inteira); `envelope`: saída de
  // envelopeGrave sobre o mesmo trecho (opcional). Devolve
  //   { bpm, grade: { bpm, primeira } | null, fonte, desvioMs, instavel?, divergentes, ancora?, compasso? }  ou null.
  // `instavel`: houve ticks, mas nenhuma reta ficou dentro de LIMITE_DESVIO — andamento que oscila;
  // o BPM é o consenso dos estimadores (1 casa) e não há grade (o motor estima pelo BPM).
  // `bpm` (6 casas) É o da grade quando há grade. Com envelope, `primeira` é o 1º tempo forte (1 do
  // compasso) em [0, 4 períodos); sem envelope não há como saber o compasso e fica em [0, período).
  function resolver(candidatos, inicio, faixa, envelope, fluxo) {
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
    if (envelope) { try { const rt = refinarBatidas(envelope, fluxo, saida.grade, ini); if (rt) saida.ritmo = rt; } catch (_) { /* sem refino a grade segue igual */ } }
    return saida;
  }

  return { FAIXA_DJ, LIMITE_DESVIO, CASAS_BPM, dobrarParaFaixa, multiploDosTicks, retaPorIndices, segmentar, ajustarReta, consenso,
    envelopeGrave, fluxoAmplo, REFINO, candidatoNaJanela, refinarBatidas, tempoSeguindo, confiancaEm, ataqueEm, faseDoBumbo, refinarNoBumbo, escolherCompasso, resolver };
});
