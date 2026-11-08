// ===================== PEÇAS =====================
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
// Botões A/B de carregar + os botões registrados por módulos (VbMxUI.registrar("card-acao", …)),
// que aparecem nos cards da sugestão e nas linhas da biblioteca (o clique é de principal.js).
function paraDeck(f){
  const extras = VbMxUI.registrados("card-acao").map(a=>`<span class="para-deck card-acao" role="button" tabindex="0" data-card-acao="${esc(a.id)}" data-id="${f.id}" title="${esc(a.titulo || a.rotulo)}" aria-label="${esc(a.titulo || a.rotulo)}: ${esc(f.titulo)}">${esc(a.rotulo)}</span>`).join("");
  return `<span class="para-grupo">${["A","B"].map(l=>`<span class="para-deck" role="button" tabindex="0" data-carregar="${l}" data-id="${f.id}" title="Carregar no deck ${l} (sem mexer no outro)" aria-label="Carregar ${esc(f.titulo)} no deck ${l}">${l}</span>`).join("")}${extras}</span>`;
}
function chave(tom){ return `<span class="chave" style="--cor:${corCamelot(tom)}">${tomTexto(tom)}</span>`; }
function fmtBpm(b){ return b.toFixed(1).replace(".",","); }

