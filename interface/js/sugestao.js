// --- sugestão: a lista vem INTEIRA do motor; a página só filtra e desenha ---
// P3b (docs/decisoes.md): sem key lock, a sugestão usa o tom e o BPM EFETIVOS da faixa no ar, com o
// pitch do deck onde ela está. Se ela está nos dois decks, vale o que está tocando (senão o A).
// Faixa só selecionada (fora dos decks) soa como é: pitch 0.
function deckDaReferencia(){
  const nos = ["A","B"].filter(l=>decks[l].faixa && atual && decks[l].faixa.id===atual.id);
  return nos.find(l=>tocandoDeck(l)) || nos[0] || null;
}
function referenciaEfetiva(){
  const l = deckDaReferencia();
  if (!l) return atual;
  const d = decks[l];
  return VbMxTom.faixaEfetiva(atual, d.pitch, opcoesDoTom(d));   // key lock (VB-21), modo e KEY (VB-38)
}
function listaDoMotor(){ return VbMxMotor.compativeis(referenciaEfetiva(), BIBLIOTECA); }
// Texto "8A → 3A · +1 st +1¢" quando o pitch mexeu no tom; vazio quando não.
function sugestaoNotaTom(){
  const ref = referenciaEfetiva();
  if (!ref || ref === atual) return "";
  const l = deckDaReferencia(), d = decks[l];
  const tom = VbMxTom.tomEfetivo(atual.camelot, d.pitch, opcoesDoTom(d));
  return `deck ${l} a ${VbMxPitch.formatarPitch(d.pitch)}: ${tom.mudou ? `${tomTexto(tom.original)} → ${tomTexto(tom.camelot)} (${VbMxTom.formatarDesvio(tom)})` : `${tomTexto(tom.original)} (${VbMxTom.formatarDesvio(tom)})`} · ${fmtBpm(atual.bpm)} → ${fmtBpm(ref.bpm)} BPM`;
}

function cardHTML(c){
  const perto = Math.abs(c.bpm.deltaPct) <= 0.02;
  const [motivoTom, ...resto] = c.motivo.split(" · ");
  return `
    <div class="card" data-faixa="${c.faixa.id}" draggable="true" role="button" tabindex="0" style="--cor:${corCamelot(c.faixa.camelot)}" title="Clique para selecionar e recalcular; arraste para um deck">
      <span class="faixa-cor"></span>
      ${chave(c.faixa.camelot)}
      <span class="c-nome"><b>${esc(c.faixa.titulo)}</b><span>${esc(c.faixa.artista)} · <span class="mono">${fmtBpm(c.faixa.bpm)}</span> BPM</span></span>
      <span class="c-motivo"><span class="motivo">${esc(motivoTom)}</span><span class="dbpm ${perto?"perto":"longe"}" title="ΔBPM contra a faixa tocando">${esc(resto.join(" · "))}</span></span>
      ${paraDeck(c.faixa)}
    </div>`;
}

function regrasHTML(lista){
  const usados = new Set(lista.map(c=>c.casa.relacao));
  const temDobro = lista.some(c=>c.bpm.fator!==1);
  const regras = ["mesma casa","±1 na roda","relativa maior/menor"];
  return `<div class="regras">
    ${regras.map(r=>`<span class="regra ${usados.has(r)?"ativa":""}">${r}</span>`).join("")}
    <span class="regra ativa" title="Alcance do pitch dos decks: o que cabe aqui dá para igualar no SYNC">BPM ±${Math.round(VbMxMotor.JANELA_BPM*100)}%</span>
    <span class="regra ${temDobro?"ativa":""}">dobro/metade</span>
    <span class="regra depois">estilo · depois</span>
    <span class="regra depois">momento · depois</span>
  </div>`;
}

// Casas acesas = as que têm ao menos uma faixa mixável na lista do MOTOR (que já aplica
// relacaoCamelot e BPM), com a contagem em cada uma; sem faixa, apagada.
function rodaHTML(lista, ref){
  const cx=125, cy=125, R1=120, R2=84, R3=81, R4=46;
  const porCasa = {};
  for (const c of lista) porCasa[c.faixa.camelot] = (porCasa[c.faixa.camelot]||0)+1;
  const arco = (r1,r2,i)=>{
    const a0 = (i-0.5-3)*Math.PI/6, a1 = (i+0.5-3)*Math.PI/6; // 12 em cima, sentido horário
    const p = (r,a)=>[(cx+r*Math.cos(a)).toFixed(2), (cy+r*Math.sin(a)).toFixed(2)];
    const [x0,y0]=p(r1,a0),[x1,y1]=p(r1,a1),[x2,y2]=p(r2,a1),[x3,y3]=p(r2,a0);
    return `M${x0} ${y0} A${r1} ${r1} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${r2} ${r2} 0 0 0 ${x3} ${y3} Z`;
  };
  let s = "";
  for (let i=1;i<=12;i++){
    for (const [l,r1,r2] of [["B",R1,R2],["A",R3,R4]]){
      const tom = i+l, rm=(r1+r2)/2, a=(i-3)*Math.PI/6;
      const n = porCasa[tom]||0;
      const acesa = n>0 || tom===filtroCasa;
      const cls = (acesa?"":"apagado") + (tom===ref.camelot?" atual":"") + (filtroCasa===tom?" filtro":"");
      const tx = (cx+rm*Math.cos(a)).toFixed(1), ty = (cy+rm*Math.sin(a)).toFixed(1);
      const rotulo = acesa ? `${tomTexto(tom)} · ${n} mixáve${n===1?"l":"is"}${filtroCasa===tom?" · filtro ativo, clique para limpar":" · clique para filtrar"}` : `${tomTexto(tom)} · fora da compatibilidade`;
      s += `<g class="setor ${cls}" data-casa="${tom}" ${acesa?`tabindex="0" role="button" aria-pressed="${filtroCasa===tom}"`:""} aria-label="${rotulo}">
              <title>${rotulo}</title>
              <path d="${arco(r1,r2,i)}" fill="${corCamelot(tom)}"/>
              <text x="${tx}" y="${acesa?(+ty-1):(+ty+4)}" text-anchor="middle">${tomTexto(tom)}</text>
              ${acesa?`<text class="cont" x="${tx}" y="${+ty+10}" text-anchor="middle">${n}</text>`:""}
            </g>`;
    }
  }
  s += `<circle cx="${cx}" cy="${cy}" r="${R4-4}" fill="var(--bg-2)" stroke="var(--linha)"/>
        <text class="centro-txt" x="${cx}" y="${cy-2}" font-size="22">${tomTexto(ref.camelot)}</text>
        <text class="centro-sub" x="${cx}" y="${cy+14}">${fmtBpm(ref.bpm)} BPM</text>`;
  return `<div class="roda" id="roda">
    <svg viewBox="0 0 250 250" role="group" aria-label="Roda de Camelot: casas acesas têm faixas mixáveis com ${tomTexto(ref.camelot)}">${s}</svg>
    <span class="dica">${filtroCasa ? `filtrando por <b>${tomTexto(filtroCasa)}</b> · clique na casa de novo ou em Limpar` : "casas acesas = têm faixa mixável · clique numa para filtrar a lista"}</span>
  </div>`;
}

function renderSugestao(){
  const div = document.getElementById("sugestao");
  if (!atual) {
    div.innerHTML = `<div class="sugestao-cab"><h3>Próximas possíveis</h3></div><div class="vazio-sug">Escolha uma faixa analisada na biblioteca para ver o que mixa com ela.</div>`;
    return;
  }
  const rolagem = div.querySelector(".cards")?.scrollTop ?? 0;
  const ref = referenciaEfetiva();
  const motor = VbMxMotor.compativeis(ref, BIBLIOTECA);
  const nota = sugestaoNotaTom();
  const total = motor.compativeis.length;
  const lista = filtroCasa ? motor.compativeis.filter(c=>c.faixa.camelot===filtroCasa) : motor.compativeis;
  const contagem = filtroCasa ? `<b class="contagem">${lista.length} de ${total}</b>` : `<b class="contagem">${total}</b>`;
  div.innerHTML = `
    <div class="sugestao-cab">
      <h3>Próximas possíveis</h3>
      <button class="alternador" id="alternar-roda" aria-pressed="${rodaAberta}" aria-controls="roda" aria-expanded="${rodaAberta}" title="Mostrar ou esconder a roda de Camelot">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" stroke="currentColor" stroke-width="1.2"/></svg>
        Roda
      </button>
      <span class="resumo">${contagem} de ${motor.contagem.total} mixáveis com <b>${esc(atual.titulo)}</b> · ${tomTexto(ref.camelot)} · ${fmtBpm(ref.bpm)} BPM</span>
      ${nota ? `<span class="resumo tom-efetivo" title="Sem key lock, o pitch desloca o tom: a lista usa o tom e o BPM efetivos">${esc(nota)}</span>` : ""}
      <span class="resumo">ordem: menor diferença de BPM, depois casa na roda (mesma casa antes) · cada card mostra o ΔBPM</span>
    </div>
    ${regrasHTML(motor.compativeis)}
    ${rodaAberta ? rodaHTML(motor.compativeis, ref) : ""}
    ${filtroCasa ? `<div class="filtro-ativo" id="filtro-ativo">Filtro
        <span class="chip">${filtroCasa}<button data-limpar title="Tirar o filtro ${filtroCasa}" aria-label="Tirar o filtro ${filtroCasa}">×</button></span>
        <button class="limpar" data-limpar>Limpar</button></div>` : ""}
    <div class="cards">${lista.length
      ? lista.map(cardHTML).join("")
      : `<div class="vazio-sug">${filtroCasa ? `Nenhuma mixável em ${filtroCasa}. Limpe o filtro ou escolha outra casa.` : "Nada mixável só por tom e BPM. Troque a faixa."}</div>`}</div>`;
  div.querySelector(".cards").scrollTop = rolagem;
  div.querySelector("#alternar-roda").addEventListener("click", alternarRoda);
  div.querySelectorAll("[data-limpar]").forEach(b=>b.addEventListener("click", limparFiltro));
  div.querySelectorAll(".setor:not(.apagado)").forEach(g=>{
    g.addEventListener("click", ()=>filtrar(g.dataset.casa));
    g.addEventListener("keydown", e=>{ if (e.key==="Enter"||e.key===" ") { e.preventDefault(); filtrar(g.dataset.casa); } });
  });
}


// O pitch mexeu (fader, SYNC, 0, carga): a lista acompanha o tom e o BPM efetivos. Junta vários eventos
// do mesmo quadro num redesenho só, e pula quando nada que a sugestão lê mudou.
let sugestaoAssinatura = "", sugestaoQuadro = 0;
function sugestaoAssinaturaAtual(){
  if (!atual) return "";
  const r = referenciaEfetiva();
  return `${atual.id}|${r.camelot}|${r.bpm.toFixed(3)}`;
}
VbMxUI.aoIniciar(()=>{
  sugestaoAssinatura = sugestaoAssinaturaAtual();
  VbMxUI.ouvir("deck:pitch", ()=>{
    if (sugestaoQuadro) return;
    sugestaoQuadro = requestAnimationFrame(()=>{
      sugestaoQuadro = 0;
      const nova = sugestaoAssinaturaAtual();
      if (nova === sugestaoAssinatura) return;
      sugestaoAssinatura = nova; renderSugestao();
    });
  });
});

// --- origem da carga (VB-18b): "veio da sugestão" = a faixa foi carregada a partir de um card do painel ---
// Clique no A/B do card ou arrasto do card para um deck marcam o id; quem registra a carga (historico.js)
// consome a marca em deck:carregado. Clicar A/B ou arrastar fora do painel apaga a marca daquela faixa;
// arrasto cancelado (soltou fora de um deck) também.
const sugestaoOrigem = new Set();   // ids de faixa carregados/arrastados a partir do painel de sugestão
function sugestaoConsumirOrigem(faixa){
  const veio = !!faixa && sugestaoOrigem.has(faixa.id);
  if (faixa) sugestaoOrigem.delete(faixa.id);
  return veio;
}
function sugestaoMarcarOrigem(id, dentro){
  if (!(id > 0)) return;
  if (dentro) sugestaoOrigem.add(id); else sugestaoOrigem.delete(id);
}
document.addEventListener("click", e=>{
  const car = e.target.closest?.("[data-carregar]");
  if (car) sugestaoMarcarOrigem(Number(car.dataset.id), !!car.closest("#sugestao"));
}, true);
let sugestaoArrastando = 0;
document.addEventListener("dragstart", e=>{
  const el = e.target.closest?.("[data-faixa]");
  if (!el) return;
  sugestaoArrastando = Number(el.dataset.faixa);
  sugestaoMarcarOrigem(sugestaoArrastando, !!el.closest("#sugestao"));
}, true);
document.addEventListener("dragend", e=>{
  if (sugestaoArrastando && e.dataTransfer && e.dataTransfer.dropEffect === "none") sugestaoOrigem.delete(sugestaoArrastando);
  sugestaoArrastando = 0;
}, true);
