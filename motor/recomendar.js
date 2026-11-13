// VbMx — motor de recomendação, primeiro corte (VB-03 reduzido, decisão do Lucas em 2026-10-24;
// janela de BPM de ±15% e ordem por ΔBPM por decisão dele em 2026-10-25).
//
// Dada a faixa que está tocando, lista TODAS as faixas da biblioteca que podem ser mixadas
// harmonicamente com ela, só por tonalidade (roda de Camelot) e BPM. Estilo e momento da
// festa (VB-05) reordenam essa lista por um escore explicável: `sugerir()`, no fim do arquivo.
//
// JavaScript puro, sem dependência. Roda no navegador (<script src="motor/recomendar.js">
// expõe `VbMxMotor`) e no Node (`require('./motor/recomendar.js')`).
//
// Formato de faixa: { id, bpm: número > 0, camelot: '1A'..'12B' } — outros campos passam
// adiante intocados. Faixa sem BPM ou tom válido é excluída e contada, nunca quebra.
//
// Relações harmônicas aceitas (e só estas):
//   - "mesma casa"            — mesmo número e mesma letra (8A → 8A)            distância 0
//   - "±1 na roda"            — mesma letra, número vizinho, circular (12A ↔ 1A) distância 1
//   - "relativa maior/menor"  — mesmo número, letra trocada (8A ↔ 8B)           distância 1
// Fora de propósito: "energy boost" (+2 ou +7 na roda) e a diagonal (8A → 9B). São técnicas
// de transição que mudam o tom de propósito, não compatibilidade harmônica — o DJ usa por
// escolha, e o motor não deve oferecer como "compatível". Ficam em ## Possibilidades.
//
// BPM: compatível se |bpm/fator − bpmTocando| / bpmTocando ≤ 15%, para fator 1 (mesmo
// andamento), 2 (o candidato tem o dobro) ou 0,5 (o candidato tem a metade). O delta é
// medido na escala da faixa tocando, para que dobro/metade sejam comparáveis com o resto.
// Os 15% são o alcance do pitch dos decks (motor/pitch.js): o que cabe na janela dá para
// igualar no SYNC.
//
// Ordem: menor |ΔBPM| primeiro, depois distância na roda (mesma casa antes), depois andamento
// direto antes de dobro/metade, depois id — determinística.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMotor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JANELA_BPM = 0.15;
  const EPSILON = 1e-9; // a borda de ±15% é inclusiva; o epsilon absorve erro de ponto flutuante

  const FATORES = [
    { fator: 1, razao: 'mesmo andamento' },
    { fator: 2, razao: 'dobro do BPM' },
    { fator: 0.5, razao: 'metade do BPM' },
  ];

  // '8A', '08a', ' 12B ' → { numero: 8, letra: 'A' }; qualquer outra coisa → null.
  function lerCamelot(valor) {
    if (typeof valor !== 'string') return null;
    const m = /^\s*(\d{1,2})\s*([AaBb])\s*$/.exec(valor);
    if (!m) return null;
    const numero = Number(m[1]);
    if (numero < 1 || numero > 12) return null;
    return { numero, letra: m[2].toUpperCase() };
  }

  function bpmValido(bpm) {
    return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
  }

  function faixaValida(faixa) {
    return !!faixa && bpmValido(faixa.bpm) && lerCamelot(faixa.camelot) !== null;
  }

  // Distância circular entre dois números da roda (1..12): 12 ↔ 1 é 1.
  function passosNaRoda(a, b) {
    const d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d);
  }

  // Relação harmônica entre dois tons Camelot, ou null se não forem compatíveis.
  function relacaoCamelot(tomA, tomB) {
    const a = lerCamelot(tomA);
    const b = lerCamelot(tomB);
    if (!a || !b) return null;
    const passos = passosNaRoda(a.numero, b.numero);
    if (a.letra === b.letra) {
      if (passos === 0) return { relacao: 'mesma casa', distancia: 0 };
      if (passos === 1) return { relacao: '±1 na roda', distancia: 1 };
      return null;
    }
    if (passos === 0) return { relacao: 'relativa maior/menor', distancia: 1 };
    return null;
  }

  // Encaixe de BPM, ou null se nenhum fator cai na janela. Entre fatores que cabem, fica o
  // de menor diferença (com 15% de janela, só um cabe de cada vez — mas não dependemos disso).
  function encaixeBpm(bpmTocando, bpmCandidato) {
    if (!bpmValido(bpmTocando) || !bpmValido(bpmCandidato)) return null;
    let melhor = null;
    for (const { fator, razao } of FATORES) {
      const equivalente = bpmCandidato / fator;
      const delta = equivalente - bpmTocando;
      const deltaPct = delta / bpmTocando;
      if (Math.abs(deltaPct) > JANELA_BPM + EPSILON) continue;
      if (!melhor || Math.abs(delta) < Math.abs(melhor.delta)) {
        melhor = { fator, razao, delta, deltaPct };
      }
    }
    return melhor;
  }

  function formatarDelta(encaixe) {
    const sinal = encaixe.delta >= 0 ? '+' : '−';
    const bpm = Math.abs(encaixe.delta).toFixed(1).replace('.', ',');
    const pct = (Math.abs(encaixe.deltaPct) * 100).toFixed(1).replace('.', ',');
    return `${sinal}${bpm} BPM (${sinal}${pct}%)`;
  }

  // A função do primeiro corte: todas as faixas da biblioteca mixáveis com `tocando`.
  // Devolve { compativeis: [...], contagem: { total, compativeis, incompativeis, invalidas } }
  // e, se a própria faixa tocando for inválida, `erro` com o motivo e lista vazia.
  function compativeis(tocando, biblioteca) {
    const lista = Array.isArray(biblioteca) ? biblioteca : [];
    const contagem = { total: 0, compativeis: 0, incompativeis: 0, invalidas: 0 };

    if (!faixaValida(tocando)) {
      for (const f of lista) {
        if (f === tocando) continue;
        contagem.total += 1;
        if (!faixaValida(f)) contagem.invalidas += 1;
      }
      return { compativeis: [], contagem, erro: 'a faixa tocando não tem BPM ou tom Camelot válido' };
    }

    const saida = [];
    for (const faixa of lista) {
      if (faixa === tocando || (faixa && tocando.id !== undefined && faixa.id === tocando.id)) continue;
      contagem.total += 1;
      if (!faixaValida(faixa)) { contagem.invalidas += 1; continue; }

      const casa = relacaoCamelot(tocando.camelot, faixa.camelot);
      const bpm = casa && encaixeBpm(tocando.bpm, faixa.bpm);
      if (!casa || !bpm) { contagem.incompativeis += 1; continue; }

      const motivos = [casa.relacao, bpm.fator === 1 ? formatarDelta(bpm) : `${bpm.razao}, ${formatarDelta(bpm)}`];
      saida.push({ faixa, casa, bpm, motivo: motivos.join(' · ') });
    }

    saida.sort((x, y) =>
      Math.abs(x.bpm.delta) - Math.abs(y.bpm.delta)
      || x.casa.distancia - y.casa.distancia
      || (x.bpm.fator === 1 ? 0 : 1) - (y.bpm.fator === 1 ? 0 : 1)
      || String(x.faixa.id).localeCompare(String(y.faixa.id)));

    contagem.compativeis = saida.length;
    return { compativeis: saida, contagem };
  }

  // ======================================================= VB-05: estilo e momento da festa
  //
  // `sugerir()` NÃO filtra: pega a lista de `compativeis()` (tom + BPM, que continuam sendo o
  // portão de "dá para mixar") e a reordena por um escore explicável, 0–100, que é a média
  // ponderada das notas (0–1) dos critérios ligados. Cada critério devolve nota e motivo; a
  // sugestão leva as parcelas e uma frase (`explicacao`) — nada de caixa preta.
  //
  //   estilo  — afinidade entre o estilo da faixa tocando e o do candidato (`estilo` ou, na
  //             falta, `genero`, que vem da tag ID3 TCON por biblioteca/metadados.js).
  //             Mesmo estilo (sem caixa, acento nem pontuação; mesmas palavras) = 1; estilos
  //             que dividem uma palavra (tech house ~ deep house) = 0,5; diferente = 0. Uma
  //             tabela `afinidades` [[a, b, nota], …] sobrepõe a regra para o par.
  //   momento — a curva da festa: aquecimento pede SUBIR, pico pede MANTER, descida pede
  //             DESCER. A fase vem dita (`fase`) ou da posição no set (`progresso` 0–1 na
  //             curva). O movimento é medido na `energia` das faixas (número, ex.: 1–10), ou
  //             no BPM se `medida: 'bpm'` for pedido. Hoje NENHUMA faixa real tem `energia`:
  //             sem o dado, a nota é neutra e o motivo diz "sem dado".
  //   tom/bpm — já ordenam a lista (ΔBPM, decisão de 2026-10-25); entram no escore só se
  //             ganharem peso (padrão 0), para não desfazer aquela ordem sem o Lucas.
  //
  // Faltou dado num lado (estilo ou energia ausente) → nota NEUTRA (0,5), marcada `semDado`:
  // não premia nem pune. Empate de escore → a ordem de `compativeis()`. Logo, sem nenhum
  // dado de estilo nem momento, `sugerir()` devolve exatamente a ordem de `compativeis()`.

  const NOTA_NEUTRA = 0.5;
  const PESOS_PADRAO = { tom: 0, bpm: 0, estilo: 1, momento: 1 };
  const ORDEM_CRITERIOS = ['tom', 'bpm', 'estilo', 'momento'];
  // Palavras que não fazem dois estilos parentes ("Dance Music" ~ "House Music" não é parentesco).
  const PALAVRAS_VAZIAS = new Set(['music', 'musica', 'the', 'and', 'e', 'de', 'da', 'do', 'n']);

  // Fase → nota por movimento. A curva da festa, em uma tabela.
  const FASES = {
    aquecimento: { sobe: 1, mantem: 0.5, desce: 0 },
    pico: { mantem: 1, sobe: 0.5, desce: 0 },
    descida: { desce: 1, mantem: 0.5, sobe: 0 },
  };
  // Posição no set (0 = começo, 1 = fim) → fase. Limites PROVISÓRIOS, sem medida de set real:
  // trocáveis por `momento.curva`; o padrão vale até o Lucas definir os dele.
  const CURVA_PADRAO = [
    { ate: 0.35, fase: 'aquecimento' },
    { ate: 0.8, fase: 'pico' },
    { ate: 1, fase: 'descida' },
  ];
  const MEDIDAS = {
    energia: { mantem: 0.5 },   // |Δenergia| < 0,5 → mantém (energia costuma ser inteira)
    bpm: { mantem: 0.01 },      // |ΔBPM| < 1% (na escala da faixa tocando) → mantém
  };
  const MOVIMENTO_ROTULO = { sobe: 'sobe', mantem: 'mantém', desce: 'desce' };

  function normalizarEstilo(valor) {
    if (typeof valor !== 'string') return '';
    return valor.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function palavrasEstilo(normalizado) {
    const todas = normalizado.split(' ').filter(Boolean);
    const uteis = todas.filter((p) => !PALAVRAS_VAZIAS.has(p));
    return new Set(uteis.length ? uteis : todas);
  }
  function estiloDe(faixa) {
    if (!faixa) return '';
    const v = typeof faixa.estilo === 'string' && faixa.estilo.trim() ? faixa.estilo : faixa.genero;
    return typeof v === 'string' ? v.trim() : '';
  }
  function chavePar(a, b) { return [a, b].sort().join('|'); }

  function tabelaAfinidades(lista) {
    const tabela = new Map();
    if (lista === undefined || lista === null) return tabela;
    if (!Array.isArray(lista)) throw new TypeError('afinidades: esperado [[estiloA, estiloB, nota], …]');
    for (const item of lista) {
      const [a, b, nota] = Array.isArray(item) ? item : [];
      const na = normalizarEstilo(a), nb = normalizarEstilo(b);
      if (!na || !nb || typeof nota !== 'number' || !(nota >= 0 && nota <= 1)) {
        throw new TypeError(`afinidades: par inválido ${JSON.stringify(item)} (nota de 0 a 1)`);
      }
      tabela.set(chavePar(na, nb), nota);
    }
    return tabela;
  }

  // Afinidade de estilo entre dois rótulos. → { nota: 0..1 | null, relacao, motivo }.
  // `afinidades` aceita a lista [[a, b, nota], …] ou o Map já montado.
  function afinidadeEstilo(estiloA, estiloB, afinidades) {
    const a = typeof estiloA === 'string' ? estiloA.trim() : '';
    const b = typeof estiloB === 'string' ? estiloB.trim() : '';
    const na = normalizarEstilo(a), nb = normalizarEstilo(b);
    if (!na || !nb) return { nota: null, relacao: 'sem dado', motivo: 'estilo sem dado' };
    const tabela = afinidades instanceof Map ? afinidades : tabelaAfinidades(afinidades);
    const definida = tabela.get(chavePar(na, nb));
    if (definida !== undefined) {
      return { nota: definida, relacao: 'afinidade definida', motivo: `afinidade definida: ${a} ~ ${b}` };
    }
    const pa = palavrasEstilo(na), pb = palavrasEstilo(nb);
    const comuns = [...pa].filter((p) => pb.has(p));
    if (comuns.length === pa.size && comuns.length === pb.size) {
      return { nota: 1, relacao: 'mesmo estilo', motivo: `mesmo estilo (${b})` };
    }
    if (comuns.length) {
      return { nota: 0.5, relacao: 'estilo parente', motivo: `estilo parente: ${a} ~ ${b} (${comuns.sort().join(', ')})` };
    }
    return { nota: 0, relacao: 'estilo diferente', motivo: `estilo diferente: ${a} × ${b}` };
  }

  function validarCurva(curva) {
    if (!Array.isArray(curva) || !curva.length) throw new TypeError('curva: esperado [{ ate, fase }, …]');
    let anterior = -Infinity;
    for (const trecho of curva) {
      if (!trecho || !FASES[trecho.fase] || typeof trecho.ate !== 'number' || !(trecho.ate > anterior)) {
        throw new TypeError(`curva: trecho inválido ${JSON.stringify(trecho)} (fase conhecida, "ate" crescente)`);
      }
      anterior = trecho.ate;
    }
    return curva;
  }

  // Fase da festa. `momento` = { fase } ou { progresso: 0..1, curva? }. → { fase, origem } | null.
  function faseDoMomento(momento) {
    if (momento === undefined || momento === null) return null;
    if (typeof momento !== 'object') throw new TypeError('momento: esperado { fase } ou { progresso }');
    if (momento.fase !== undefined) {
      if (!FASES[momento.fase]) throw new TypeError(`momento: fase desconhecida "${momento.fase}" (aquecimento, pico, descida)`);
      return { fase: momento.fase, origem: 'fase dita' };
    }
    if (typeof momento.progresso !== 'number' || !Number.isFinite(momento.progresso)) {
      throw new TypeError('momento: "progresso" tem de ser número de 0 a 1');
    }
    const curva = validarCurva(momento.curva === undefined ? CURVA_PADRAO : momento.curva);
    const p = Math.min(1, Math.max(0, momento.progresso));
    const trecho = curva.find((t) => p <= t.ate + EPSILON) || curva[curva.length - 1];
    const pct = Math.round(p * 100);
    return { fase: trecho.fase, origem: `${pct}% do set` };
  }

  function numeroBr(v, casas) { return Number(v.toFixed(casas)).toString().replace('.', ','); }

  // Movimento do candidato em relação à faixa tocando, na medida pedida.
  // → { movimento: 'sobe'|'mantem'|'desce', motivo } | null (sem dado).
  function movimentoDe(tocando, candidato, encaixe, medida) {
    if (medida === 'bpm') {
      if (!encaixe) return null;
      const d = encaixe.deltaPct;
      const mov = Math.abs(d) < MEDIDAS.bpm.mantem ? 'mantem' : d > 0 ? 'sobe' : 'desce';
      return { movimento: mov, motivo: formatarDelta(encaixe) };
    }
    const et = tocando && tocando.energia, ec = candidato && candidato.energia;
    if (typeof et !== 'number' || !Number.isFinite(et) || typeof ec !== 'number' || !Number.isFinite(ec)) return null;
    const d = ec - et;
    const mov = Math.abs(d) < MEDIDAS.energia.mantem ? 'mantem' : d > 0 ? 'sobe' : 'desce';
    return { movimento: mov, motivo: `energia ${numeroBr(et, 1)}→${numeroBr(ec, 1)}` };
  }

  // Nota do momento: a fase da festa diz que movimento ela pede.
  function notaMomento(fase, tocando, candidato, encaixe, medida) {
    const m = movimentoDe(tocando, candidato, encaixe, medida);
    if (!m) return { nota: null, motivo: `${fase}, ${medida === 'bpm' ? 'BPM' : 'energia'} sem dado` };
    return { nota: FASES[fase][m.movimento], movimento: m.movimento,
      motivo: `${fase}, ${m.motivo}: ${MOVIMENTO_ROTULO[m.movimento]}` };
  }

  function configurar(opcoes) {
    const o = opcoes || {};
    const pesos = Object.assign({}, PESOS_PADRAO);
    if (o.pesos !== undefined) {
      for (const [k, v] of Object.entries(o.pesos)) {
        if (!(k in PESOS_PADRAO)) throw new TypeError(`pesos: critério desconhecido "${k}" (tom, bpm, estilo, momento)`);
        if (typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v)) throw new TypeError(`pesos: "${k}" tem de ser número ≥ 0`);
        pesos[k] = v;
      }
    }
    const medida = o.momento && o.momento.medida !== undefined ? o.momento.medida : 'energia';
    if (!MEDIDAS[medida]) throw new TypeError(`momento: medida desconhecida "${medida}" (energia, bpm)`);
    const fase = faseDoMomento(o.momento);
    if (!fase) pesos.momento = 0;   // sem momento dito, o critério não existe (não é "sem dado")
    return { pesos, fase, medida, afinidades: tabelaAfinidades(o.afinidades) };
  }

  function rotuloParcela(p, pesosIguais) {
    const peso = pesosIguais ? '' : ` ×${numeroBr(p.peso, 2)}`;
    return `${p.criterio} ${Math.round(p.nota * 100)}${peso} (${p.motivo}${p.semDado ? ', neutro' : ''})`;
  }

  // As compatíveis de `tocando`, reordenadas pelo escore de estilo e momento.
  // opcoes = { momento?: { fase } | { progresso, curva? } (+ medida: 'energia' padrão | 'bpm'),
  //            pesos?: { tom, bpm, estilo, momento }, afinidades?: [[a, b, nota], …] }
  // → { sugestoes: [{ faixa, casa, bpm, motivo, escore 0–100 | null, parcelas, explicacao }],
  //     contagem (a de compativeis() + semDado por critério), criterios, erro? }
  function sugerir(tocando, biblioteca, opcoes) {
    const cfg = configurar(opcoes);
    const base = compativeis(tocando, biblioteca);
    const criterios = { pesos: cfg.pesos, fase: cfg.fase, medida: cfg.medida };
    const semDado = { estilo: 0, momento: 0 };
    const contagem = Object.assign({}, base.contagem, { semDado });
    if (base.erro) return { sugestoes: [], contagem, criterios, erro: base.erro };

    const ativos = ORDEM_CRITERIOS.filter((k) => cfg.pesos[k] > 0);
    const pesosIguais = ativos.every((k) => cfg.pesos[k] === cfg.pesos[ativos[0]]);
    const estiloTocando = estiloDe(tocando);

    const sugestoes = base.compativeis.map((c, indice) => {
      const parcelas = [];
      for (const criterio of ativos) {
        let r;
        if (criterio === 'tom') r = { nota: c.casa.distancia === 0 ? 1 : 0.5, motivo: c.casa.relacao };
        else if (criterio === 'bpm') {
          r = { nota: Math.max(0, 1 - Math.abs(c.bpm.deltaPct) / JANELA_BPM), motivo: formatarDelta(c.bpm) };
        } else if (criterio === 'estilo') r = afinidadeEstilo(estiloTocando, estiloDe(c.faixa), cfg.afinidades);
        else r = notaMomento(cfg.fase.fase, tocando, c.faixa, c.bpm, cfg.medida);
        const falta = r.nota === null;
        if (falta) semDado[criterio] += 1;
        parcelas.push({ criterio, nota: falta ? NOTA_NEUTRA : r.nota, peso: cfg.pesos[criterio],
          semDado: falta, motivo: r.motivo });
      }
      const somaPesos = parcelas.reduce((s, p) => s + p.peso, 0);
      const exato = somaPesos > 0 ? parcelas.reduce((s, p) => s + p.peso * p.nota, 0) / somaPesos : null;
      const escore = exato === null ? null : Math.round(exato * 100);
      const explicacao = escore === null ? 'sem critério de escore ligado'
        : `${escore} = ${parcelas.map((p) => rotuloParcela(p, pesosIguais)).join(' · ')}`;
      return { faixa: c.faixa, casa: c.casa, bpm: c.bpm, motivo: c.motivo, escore, parcelas, explicacao,
        _exato: exato, _indice: indice };
    });

    sugestoes.sort((x, y) => {
      if (x._exato !== null && y._exato !== null && Math.abs(x._exato - y._exato) > EPSILON) return y._exato - x._exato;
      return x._indice - y._indice;
    });
    for (const s of sugestoes) { delete s._exato; delete s._indice; }
    return { sugestoes, contagem, criterios };
  }

  return { compativeis, relacaoCamelot, encaixeBpm, lerCamelot, faixaValida, JANELA_BPM,
    sugerir, afinidadeEstilo, faseDoMomento, FASES, CURVA_PADRAO, PESOS_PADRAO, NOTA_NEUTRA };
});
