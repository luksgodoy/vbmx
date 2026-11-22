// Leitura de arquivo em pedaços, para a barra de progresso do carregamento do deck (só a leitura: a decodificação não dá progresso).
// lerComProgresso(arq, aoProgresso, cancelado) → ArrayBuffer. aoProgresso(fração 0..1) com bytes lidos / arq.size, só crescente.
// `cancelado()` verdadeiro interrompe a leitura (outra faixa entrou no mesmo deck) e devolve null. Sem arq.stream(), cai em arrayBuffer() sem barra.
(function (raiz, api) {
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxLeitura = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, {
  async lerComProgresso(arq, aoProgresso, cancelado) {
    const total = arq && arq.size;
    if (!arq || typeof arq.stream !== 'function' || !(total > 0)) return arq.arrayBuffer();
    const leitor = arq.stream().getReader(), saida = new Uint8Array(total);
    let lidos = 0;
    if (aoProgresso) aoProgresso(0);
    for (;;) {
      if (cancelado && cancelado()) { try { await leitor.cancel(); } catch (e) { /* já encerrado */ } return null; }
      const { done, value } = await leitor.read();
      if (done) break;
      if (lidos + value.length > total) throw new Error('arquivo maior que o tamanho declarado');
      saida.set(value, lidos); lidos += value.length;
      if (aoProgresso) aoProgresso(lidos / total);
    }
    if (lidos !== total) throw new Error('leitura incompleta');
    return saida.buffer;
  },
});
