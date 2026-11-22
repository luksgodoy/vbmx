// Biblioteca da versão PUBLICADA: 5 faixas da 294 Records já analisadas (faixas-294/catalogo.json, gerado por
// biblioteca/analisar-faixas-294.js), prontas para tocar. Mora aqui (fora de interface/js/) de propósito: só o publicar-pages.sh o copia para interface/js/ e o carrega (e o catalogo-294.js
// com window.VBMX_CATALOGO); no desenvolvimento ele não está no classico.html e a biblioteca de exemplo segue como sempre.
// Troca o conteúdo de FAIXAS (a lista que BIBLIOTECA aponta) antes de principal.js: nenhuma faixa fictícia chega à tela.
// A faixa é lida por fetch no mesmo host (../faixas-294/…), com barra de progresso real (stream), sem "indicar pasta".
(function () {
  const cat = window.VBMX_CATALOGO;
  if (!cat || !Array.isArray(cat.faixas) || typeof FAIXAS === "undefined") return;
  const dir = new URL("../" + (cat.dir || "faixas-294") + "/", document.baseURI);
  const arquivoRemoto = (f) => {
    const url = new URL(encodeURIComponent(f.arquivo), dir).href;
    const aberto = async () => { const r = await fetch(url); if (!r.ok) throw new Error(`${f.arquivo}: HTTP ${r.status}`); return r; };
    return {
      name: f.arquivo, size: f.tamanho, type: "audio/mpeg", lastModified: 0,
      async arrayBuffer() { return (await aberto()).arrayBuffer(); },
      async blob() { return (await aberto()).blob(); },
      stream() {   // lê o corpo da resposta aos poucos; a barra do deck mede bytes lidos / size
        let leitor = null;
        return new ReadableStream({
          async pull(c) { if (!leitor) leitor = (await aberto()).body.getReader(); const { done, value } = await leitor.read(); if (done) c.close(); else c.enqueue(value); },
          cancel() { return leitor && leitor.cancel(); },
        });
      },
    };
  };
  FAIXAS.length = 0;
  for (const f of cat.faixas) {
    const t = { id: f.id, titulo: f.titulo, artista: f.artista, bpm: f.bpm, camelot: f.camelot, caminho: cat.pasta + "/" + f.arquivo,
      analisavel: true, duracao: f.duracao, obter: async () => arquivoRemoto(f) };
    if (f.grade) t.grade = { bpm: f.grade.bpm, primeira: f.grade.primeira };
    FAIXAS.push(t);
  }
  ehExemplo = false;
  atual = FAIXAS[0];
  let pintarOriginal = null;
  const marca = () => {
    const el = document.getElementById("marca-origem");
    if (!el) return;
    if (marcaOrigem && marcaOrigem.faixas) { if (pintarOriginal) pintarOriginal(); return; }   // pasta do usuário: a frase de sempre
    el.textContent = `${VbMxUI.t("pro.marca.modelo")} · ${cat.pasta} · ${FAIXAS.length}`;
  };
  // principal.js já rodou: guarda a frase original e troca a do "exemplo" pela da 294 Records
  document.addEventListener("DOMContentLoaded", () => { pintarOriginal = pintarMarcaOrigem; pintarMarcaOrigem = marca; marca(); });
  // sem pasta do usuário (ou ao remover todas) a biblioteca volta a FAIXAS: aqui são as 5 reais, não exemplo
  VbMxUI.ouvir("biblioteca:mudou", (e) => { if (e && e.ehExemplo) { ehExemplo = false; marca(); } });
})();
