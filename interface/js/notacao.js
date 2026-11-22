// ===================== Notação de tom (VB-42): duas preferências, uma para exibir e outra para gravar =====================
// O motor e a análise seguem em Camelot; só o texto mostrado muda. Depende de VbMxNotacao e VbMxPrefs.
//   tomTexto(camelot)    texto para a tela, na notação de exibição
//   tomGravar(camelot)   texto para exportar/gravar, na notação de gravação
(function () {
  const opcoes = VbMxNotacao.NOTACOES.map(valor => ({ valor, rotulo: "msg.no." + valor }));
  VbMxPrefs.declarar("tom.notacao-exibir", "camelot", { rotulo: "pro.pref.tom-exibir", tipo: "opcao", opcoes, modulo: "tom" });
  VbMxPrefs.declarar("tom.notacao-gravar", "camelot", { rotulo: "pro.pref.tom-gravar", tipo: "opcao", opcoes, modulo: "tom" });
  window.tomTexto = camelot => VbMxNotacao.exibir(camelot, VbMxPrefs.ler("tom.notacao-exibir"));
  window.tomGravar = camelot => VbMxNotacao.exibir(camelot, VbMxPrefs.ler("tom.notacao-gravar"));
  // trocar a notação só redesenha a tela: a análise e os dados não são tocados
  VbMxPrefs.ouvir("tom.notacao-exibir", () => { if (typeof renderTudo === "function") renderTudo(); });
})();
