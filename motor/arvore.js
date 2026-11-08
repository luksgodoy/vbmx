// VbMx — árvore de caminhos (decisão do Lucas em 2026-10-25, docs/decisoes.md): a lógica PURA da
// leitura "o que já tocou → o que toca agora → o que pode vir → o que vem depois disso".
//
// Este módulo não mexe no DOM e não chama o motor sozinho: recebe a lista do VbMxMotor.compativeis
// já pronta (ou uma função que a devolve) e devolve um modelo com as posições em pixels de um
// quadro de 1456 × 470 — quem desenha (interface/js/sugestao.js) só coloca cada nó onde o modelo
// manda. A geometria copia o handoff `arvore-referencia.html`:
//   histórico   x = 16 + i·150  (136 × 26)       raiz x = 620 (200 × 56, y = H/2 − 28)
//   nível 1     x = 900 (250 × 26), cabeçalho de grupo em (896, y − 2)
//   nível 2     x = 1220 (220 × 26, passo 32, até 6)
//   linhas = nós + grupos; passo = min(30, (H − 40)/linhas); y0 = max(22, H/2 − linhas·passo/2 + 10)
//   nível 2: y2 = min(H − 6 − 32·m, max(22, y_cand + 13 − 16·m))
//
// Roda no navegador (<script src="motor/arvore.js"> expõe `VbMxArvore`) e no Node
// (`require('./motor/arvore.js')`). Só stdlib.
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.VbMxArvore = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GEO = Object.freeze({
    LARGURA: 1456, ALTURA: 470,
    HIST_X: 16, HIST_PASSO: 150, HIST_L: 136, HIST_A: 26,
    RAIZ_X: 620, RAIZ_L: 200, RAIZ_A: 56,
    N1_X: 900, N1_L: 250, N1_A: 26, CAB_X: 896,
    N2_X: 1220, N2_L: 220, N2_A: 26, N2_PASSO: 32, N2_MAX: 6,
    PASSO_MAX: 30, Y_MIN: 22
  });
  // Ordem fixa dos grupos: é a ordem das relações do motor (docs/taxonomia da sugestão).
  const RELACOES = Object.freeze(['mesma casa', '±1 na roda', 'relativa maior/menor']);

  function idDe(x) { return x && x.faixa ? x.faixa.id : x && x.id; }

  // Ids das faixas que JÁ tocaram: as entradas da sessão do histórico (biblioteca/historico.js só
  // registra quem passou de 30 s no ar — regra P10), na ordem em que entraram.
  function idsDoHistorico(entradas) {
    const vistos = new Set(), saida = [];
    for (const e of entradas || []) {
      const id = e && e.faixa ? e.faixa.id : null;
      if (id == null || vistos.has(id)) continue;
      vistos.add(id); saida.push(id);
    }
    return saida;
  }

  // Tira da lista do motor o que já tocou (e a própria base). Mantém a ordem do motor.
  function limpar(compativeis, excluirIds) {
    const ex = new Set(excluirIds || []);
    return (compativeis || []).filter(c => !ex.has(idDe(c)));
  }

  // Agrupa por motivo harmônico, na ordem de RELACOES; grupo vazio não aparece.
  function agrupar(lista) {
    return RELACOES
      .map(motivo => ({ motivo, itens: (lista || []).filter(c => c.casa && c.casa.relacao === motivo) }))
      .filter(g => g.itens.length);
  }

  // Distribui grupos e nós na vertical. Devolve { passo, y0, cabecalhos:[{motivo,y}], nos:[{c,y}] }.
  function distribuir(grupos, H) {
    H = H || GEO.ALTURA;
    const nNos = grupos.reduce((s, g) => s + g.itens.length, 0);
    const linhas = nNos + grupos.length;
    if (!linhas) return { passo: GEO.PASSO_MAX, y0: H / 2, cabecalhos: [], nos: [] };
    const passo = Math.min(GEO.PASSO_MAX, (H - 40) / linhas);
    const y0 = Math.max(GEO.Y_MIN, H / 2 - linhas * passo / 2 + 10);
    const cabecalhos = [], nos = [];
    let y = y0;
    for (const g of grupos) {
      cabecalhos.push({ motivo: g.motivo, y: y - 2, n: g.itens.length });
      y += passo;
      for (const c of g.itens) { nos.push({ c, y }); y += passo; }
    }
    return { passo, y0, cabecalhos, nos };
  }

  // Topo do bloco do nível 2 (m nós), centrado na candidata e preso dentro do quadro.
  function yNivel2(yCand, m, H) {
    H = H || GEO.ALTURA;
    if (!m) return GEO.Y_MIN;
    return Math.min(H - 6 - GEO.N2_PASSO * m, Math.max(GEO.Y_MIN, yCand + 13 - 16 * m));
  }

  // ΔBPM curto: sinal, |Δ| com uma casa (vírgula) e o fator quando é dobro/metade.
  function deltaCurto(bpm) {
    if (!bpm) return '';
    const d = Number(bpm.delta) || 0;
    const sinal = d > 0 ? '+' : d < 0 ? '−' : '±';
    const fator = bpm.fator === 2 ? ' ×2' : bpm.fator === 0.5 ? ' ½' : '';
    return `${sinal}${Math.abs(d).toFixed(1).replace('.', ',')}${fator}`;
  }
  function classeDelta(bpm) { return bpm && Math.abs(Number(bpm.deltaPct) || 0) <= 0.02 ? 'perto' : 'longe'; }

  // Caminhos SVG das ligações, como no handoff.
  function caminhoRaiz(y, H) { H = H || GEO.ALTURA; const m = H / 2, yy = y + 13; return `M820 ${m} C860 ${m} 860 ${yy} 900 ${yy}`; }
  function caminhoN2(yCand, y2) { const a = yCand + 13, b = y2 + 13; return `M1150 ${a} C1185 ${a} 1185 ${b} 1220 ${b}`; }

  // Modelo completo. `compativeis(faixa)` é a função que consulta o motor (VbMxMotor.compativeis
  // com a biblioteca já fechada); é chamada uma vez para a raiz e, se houver candidata, uma para
  // ela (o nível 2 é a SEGUNDA chamada, o motor não muda).
  //   { ref, compativeis, historicoIds, candidataId, filtroCasa, H }
  function montar(op) {
    const H = op.H || GEO.ALTURA;
    const ref = op.ref;
    const hist = (op.historicoIds || []).filter(id => !ref || id !== ref.id);
    const excluir = hist.concat(ref ? [ref.id] : []);
    const r1 = ref ? op.compativeis(ref) : { compativeis: [], contagem: { total: 0 } };
    const limpa = limpar(r1.compativeis, excluir);
    const visiveis = op.filtroCasa ? limpa.filter(c => c.faixa.camelot === op.filtroCasa) : limpa;
    const grupos = agrupar(limpa);              // o filtro APAGA galhos, não os tira: a forma da árvore fica
    const dist = distribuir(grupos, H);
    const nos = dist.nos.map(n => ({
      c: n.c, y: n.y, x: GEO.N1_X, id: idDe(n.c),
      apagado: !!(op.filtroCasa && n.c.faixa.camelot !== op.filtroCasa),
      caminho: caminhoRaiz(n.y, H)
    }));
    let candidata = nos.find(n => n.id === op.candidataId && !n.apagado) || nos.find(n => !n.apagado) || null;
    let n2 = [];
    if (candidata) {
      const r2 = op.compativeis(candidata.c.faixa);
      const lista2 = limpar(r2.compativeis, excluir.concat([candidata.id]));
      candidata.depois = lista2;                 // lista inteira: é o que o painel "Depois de …" mostra
      const corte = lista2.slice(0, GEO.N2_MAX);
      const y2 = yNivel2(candidata.y, corte.length, H);
      n2 = corte.map((c, i) => ({ c, id: idDe(c), x: GEO.N2_X, y: y2 + i * GEO.N2_PASSO, caminho: caminhoN2(candidata.y, y2 + i * GEO.N2_PASSO) }));
      candidata.n2Total = lista2.length;
    }
    const historico = hist.map((id, i) => ({ id, x: GEO.HIST_X + i * GEO.HIST_PASSO, y: H / 2 - GEO.HIST_A / 2 }));
    return {
      H, ref, historico, raiz: ref ? { x: GEO.RAIZ_X, y: H / 2 - GEO.RAIZ_A / 2 } : null,
      total: r1.compativeis.length, mixaveis: limpa.length, visiveis: visiveis.length, escondidas: r1.compativeis.length - limpa.length,
      grupos, cabecalhos: dist.cabecalhos.map(c => ({ ...c, x: GEO.CAB_X })), nos, candidata, n2
    };
  }

  // Base da árvore na vista da biblioteca (pedido do Lucas, 2026-11-08): a faixa que ESTÁ TOCANDO.
  //   decks = { A: {faixa, tocando, volume}, B: {…} }   volume = ganho efetivo 0…1 (fader × crossfader)
  //   ultimo = letra do último deck a começar a tocar ("A" | "B" | null)
  // Nenhum deck tocando → null (a tela diz isso). Um só → ele. Os dois → o de maior volume efetivo;
  // empate (ou diferença < 0,001) → o último a tocar; sem ele, o A. Devolve { letra, faixa, motivo }.
  function escolherBase(decks, ultimo) {
    const tocando = ['A', 'B'].filter(l => decks && decks[l] && decks[l].faixa && decks[l].tocando);
    if (!tocando.length) return null;
    const de = (letra, motivo) => ({ letra, faixa: decks[letra].faixa, motivo });
    if (tocando.length === 1) return de(tocando[0], 'único deck tocando');
    const va = Number(decks.A.volume) || 0, vb = Number(decks.B.volume) || 0;
    if (Math.abs(va - vb) >= 0.001) return va > vb ? de('A', 'maior volume efetivo') : de('B', 'maior volume efetivo');
    return ultimo === 'A' || ultimo === 'B' ? de(ultimo, 'empate de volume: o último a tocar') : de('A', 'empate de volume: deck A');
  }

  return { GEO, RELACOES, escolherBase, idsDoHistorico, limpar, agrupar, distribuir, yNivel2, deltaCurto, classeDelta, caminhoRaiz, caminhoN2, montar };
});
