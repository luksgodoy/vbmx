function filtrar(casa){
  filtroCasa = filtroCasa===casa ? null : casa;
  renderSugestao();
}
function limparFiltro(){ filtroCasa = null; renderSugestao(); }
function alternarRoda(){
  rodaAberta = !rodaAberta;
  try { localStorage.setItem("vbmx-roda", rodaAberta ? "1" : "0"); } catch(_){}
  renderSugestao();
}

