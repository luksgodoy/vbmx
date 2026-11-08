// ===================== VbMxDiagnostico — a análise do VbMx contra a grade do .nml =====================
// Lógica pura (UMD), sem DOM: roda no navegador e em Node. Para o Lucas medir a análise de BPM e grade
// com a biblioteca REAL sem que nenhum dado dela saia da máquina: o resumo só tem AGREGADOS (contagens,
// medianas, p95), nunca nome de faixa, caminho ou valor de uma faixa só.
//   gradesDoNml(texto)                    Map chave (VOLUME+DIR+FILE) → { bpm, ancora (s) | null, duracao (s) | null },
//                                         lido do XML cru: o lerColecao reduz a âncora a [0, período) e perde o compasso
//   comparar(itens)                       resumo de [{ nml: {bpm, ancora, duracao}, vbmx: {bpm, primeira?} | null }]
//   diagnosticar(texto, faixas, analiseDe)  async: casa as faixas (VbMxNml.casar), pede a análise de cada uma a
//                                         `analiseDe(faixa)` → { bpm, grade? } | null e devolve comparar(...)
//   textoResumo(resumo)                   linhas de texto para copiar e mandar (só agregados)
// Medidas (só pares com BPM nos dois lados; a âncora só com grade nos dois):
//   ΔBPM = VbMx − Traktor (mediana e p95 do módulo), dentro de ±2 (meta da decisão de 2026-10-24), erro de oitava
//   (razão ×2 ou ÷2, que fica fora das outras medidas); âncora = distância entre as linhas das duas grades no
//   começo da faixa, módulo o período (ms; mediana com sinal mostra um atraso constante, de decodificador);
//   "meia batida" = âncora a mais de ¼ de batida; 1 do compasso igual (só onde a âncora casa);
//   fim = distância entre as linhas no FIM da faixa (âncora + deriva); deriva = só o efeito da diferença de BPM.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxDiagnostico = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';

  const ehNum = v => typeof v === 'number' && Number.isFinite(v);
  const num = s => { if (s === undefined || s === null || s === '') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
  const modulo = (a, m) => ((a % m) + m) % m;
  const centrado = (a, m) => modulo(a + m / 2, m) - m / 2; // em [−m/2, m/2)
  const DURACAO_PADRAO = 300;
  function nml() {
    if (raiz && raiz.VbMxNml) return raiz.VbMxNml;
    if (typeof require === 'function') return require('./nml.js');
    throw new Error('VbMxNml não carregado');
  }
  function quantil(v, q) {
    if (!v.length) return null;
    const o = v.slice().sort((a, b) => a - b);
    return o[Math.min(o.length - 1, Math.max(0, Math.ceil(q * o.length) - 1))]; // posto mais próximo
  }
  const mediana = v => {
    if (!v.length) return null;
    const o = v.slice().sort((a, b) => a - b), n = o.length;
    return n % 2 ? o[(n - 1) / 2] : (o[n / 2 - 1] + o[n / 2]) / 2;
  };

  function filhos(no, tag) { return (no.filhos || []).filter(f => f.tag === tag); }
  function gradesDoNml(texto) {
    const N = nml(), arv = N.lerXml(texto), mapa = new Map();
    const raizNml = arv && arv.tag === 'NML' ? arv : filhos(arv, 'NML')[0], col = raizNml && filhos(raizNml, 'COLLECTION')[0];
    if (!col) return mapa;
    for (const e of filhos(col, 'ENTRY')) {
      const loc = filhos(e, 'LOCATION')[0], tempo = filhos(e, 'TEMPO')[0], info = filhos(e, 'INFO')[0];
      if (!loc || !loc.attrs.FILE) continue;
      const chave = (loc.attrs.VOLUME || '') + (loc.attrs.DIR || '') + loc.attrs.FILE;
      const bpm = tempo ? num(tempo.attrs.BPM) : null;
      const grade = filhos(e, 'CUE_V2').find(c => num(c.attrs.TYPE) === 4 && num(c.attrs.START) !== null);
      const dur = info ? (num(info.attrs.PLAYTIME_FLOAT) || num(info.attrs.PLAYTIME)) : null;
      if (!mapa.has(chave)) mapa.set(chave, { bpm: bpm > 0 ? bpm : null, ancora: grade ? num(grade.attrs.START) / 1000 : null, duracao: dur > 0 ? dur : null });
    }
    return mapa;
  }

  function ehOitava(bv, bn) {
    const r = bv / bn;
    return Math.abs(r - 2) <= 0.04 || Math.abs(r - 0.5) <= 0.01;
  }

  function comparar(itens) {
    const res = { casadas: 0, semAnaliseVbmx: 0, semBpmNml: 0, comBpm: 0, oitava: 0, dentroDe2: 0, foraDe2: 0,
      dBpm: { mediana: null, p95: null, max: null },
      ancora: { comparadas: 0, mediana: null, p95: null, medianaComSinal: null, meiaBatida: 0 },
      compasso: { comparadas: 0, iguais: 0 },
      fim: { comparadas: 0, mediana: null, p95: null, acimaDe10: 0, duracaoPadrao: 0 },
      deriva: { mediana: null, p95: null } };
    const dB = [], anc = [], ancS = [], fim = [], der = [];
    for (const it of itens || []) {
      res.casadas += 1;
      const n = it && it.nml, v = it && it.vbmx;
      if (!n || !(n.bpm > 0)) { res.semBpmNml += 1; continue; }
      if (!v || !(v.bpm > 0)) { res.semAnaliseVbmx += 1; continue; }
      res.comBpm += 1;
      const bv = v.grade && v.grade.bpm > 0 ? v.grade.bpm : v.bpm;
      if (ehOitava(bv, n.bpm)) { res.oitava += 1; continue; }
      const d = Math.abs(bv - n.bpm);
      dB.push(d);
      if (d <= 2) res.dentroDe2 += 1; else { res.foraDe2 += 1; continue; } // fora de ±2 é outra faixa de erro: a grade não se compara
      const g = v.grade;
      if (!g || !ehNum(g.primeira) || !ehNum(n.ancora)) continue;
      const Pn = 60 / n.bpm, Pv = 60 / g.bpm;
      const delta = centrado(g.primeira - n.ancora, Pn);
      anc.push(Math.abs(delta) * 1000); ancS.push(delta * 1000);
      res.ancora.comparadas += 1;
      if (Math.abs(delta) > Pn / 4) res.ancora.meiaBatida += 1;
      else {
        res.compasso.comparadas += 1;
        if (modulo(Math.round((g.primeira - n.ancora) / Pn), 4) === 0) res.compasso.iguais += 1;
      }
      const T = ehNum(n.duracao) && n.duracao > 0 ? n.duracao : DURACAO_PADRAO;
      if (!(ehNum(n.duracao) && n.duracao > 0)) res.fim.duracaoPadrao += 1;
      // linhas das duas grades perto de T: diferença de fase em batidas do Traktor
      const fn = (T - n.ancora) / Pn, fv = (T - g.primeira) / Pv;
      const kv = Math.round(fv), tv = g.primeira + kv * Pv; // a linha do VbMx mais perto de T
      const dFim = centrado(tv - n.ancora, Pn);
      fim.push(Math.abs(dFim) * 1000);
      der.push(Math.abs(fn * (Pv - Pn)) * 1000);
    }
    res.dBpm = { mediana: mediana(dB), p95: quantil(dB, 0.95), max: dB.length ? Math.max(...dB) : null };
    Object.assign(res.ancora, { mediana: mediana(anc), p95: quantil(anc, 0.95), medianaComSinal: mediana(ancS) });
    Object.assign(res.fim, { comparadas: fim.length, mediana: mediana(fim), p95: quantil(fim, 0.95), acimaDe10: fim.filter(x => x > 10).length });
    res.deriva = { mediana: mediana(der), p95: quantil(der, 0.95) };
    return res;
  }

  async function diagnosticar(texto, faixas, analiseDe) {
    const N = nml(), colecao = N.lerColecao(texto), extra = gradesDoNml(texto);
    const { pares, semPar, ambiguas } = N.casar(colecao.faixas, faixas || []);
    const itens = [];
    for (const p of pares) {
      const x = extra.get(p.entrada.chave) || { bpm: p.entrada.bpm, ancora: null, duracao: null };
      let a = null;
      try { a = await analiseDe(p.faixa); } catch (_) { a = null; }
      itens.push({ nml: x, vbmx: a });
    }
    const r = comparar(itens);
    r.entradasNml = colecao.faixas.length; r.semPar = semPar.length; r.ambiguas = ambiguas.length;
    return r;
  }

  const f1 = v => (v === null || v === undefined ? '—' : v.toFixed(1));
  const f3 = v => (v === null || v === undefined ? '—' : v.toFixed(3));
  function textoResumo(r) {
    const pct = (a, b) => (b ? ` (${Math.round(100 * a / b)}%)` : '');
    const l = [];
    l.push(`Diagnóstico da análise VbMx × collection.nml — só agregados, sem nomes`);
    if (ehNum(r.entradasNml)) l.push(`entradas no .nml: ${r.entradasNml} · casadas com a biblioteca: ${r.casadas} · sem par: ${r.semPar} · ambíguas: ${r.ambiguas}`);
    l.push(`com BPM nos dois lados: ${r.comBpm} · sem análise do VbMx: ${r.semAnaliseVbmx} · sem BPM no .nml: ${r.semBpmNml}`);
    l.push(`BPM dentro de ±2: ${r.dentroDe2}${pct(r.dentroDe2, r.comBpm)} · erro de oitava (×2/÷2): ${r.oitava}${pct(r.oitava, r.comBpm)} · fora de ±2: ${r.foraDe2}`);
    l.push(`|ΔBPM| (sem oitava): mediana ${f3(r.dBpm.mediana)} · p95 ${f3(r.dBpm.p95)} · máx ${f3(r.dBpm.max)}`);
    l.push(`âncora (ms, módulo período, ${r.ancora.comparadas} faixas): mediana ${f1(r.ancora.mediana)} · p95 ${f1(r.ancora.p95)} · mediana com sinal ${f1(r.ancora.medianaComSinal)} · meia batida fora: ${r.ancora.meiaBatida}`);
    l.push(`1 do compasso igual ao do .nml: ${r.compasso.iguais} de ${r.compasso.comparadas}`);
    l.push(`fim da faixa (ms, âncora + deriva): mediana ${f1(r.fim.mediana)} · p95 ${f1(r.fim.p95)} · acima de 10 ms: ${r.fim.acimaDe10} de ${r.fim.comparadas}${r.fim.duracaoPadrao ? ` (${r.fim.duracaoPadrao} sem duração no .nml: 5 min)` : ''}`);
    l.push(`deriva só do BPM no fim (ms): mediana ${f1(r.deriva.mediana)} · p95 ${f1(r.deriva.p95)}`);
    return l.join('\n');
  }

  return { gradesDoNml, comparar, diagnosticar, textoResumo, DURACAO_PADRAO };
});
