// ===================== PEÇAS =====================
// texto pelo idioma: tr(chave, {param}); a chave e os 4 dicionários moram em js/i18n/*.js
const tr = (chave, params) => VbMxUI.t(chave, params);
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
// Botões A/B de carregar + os botões registrados por módulos (VbMxUI.registrar("card-acao", …)),
// que aparecem nos cards da sugestão e nas linhas da biblioteca (o clique é de principal.js).
function paraDeck(f){
  const extras = VbMxUI.registrados("card-acao").map(a=>`<span class="para-deck card-acao" role="button" tabindex="0" data-card-acao="${esc(a.id)}" data-id="${f.id}" title="${esc(tr(a.titulo || a.rotulo))}" aria-label="${esc(tr(a.titulo || a.rotulo))}: ${esc(f.titulo)}">${esc(tr(a.rotulo))}</span>`).join("");
  return `<span class="para-grupo">${["A","B"].map(l=>`<span class="para-deck" role="button" tabindex="0" data-carregar="${l}" data-id="${f.id}" title="${tr("pro.carregar.titulo",{l})}" aria-label="${tr("pro.carregar.aria",{titulo:f.titulo,l})}">${l}</span>`).join("")}${extras}</span>`;
}
function chave(tom){ return `<span class="chave" style="--cor:${corCamelot(tom)}">${tomTexto(tom)}</span>`; }
function fmtBpm(b){ return b.toFixed(1).replace(".",","); }

