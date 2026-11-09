import { collectorScript } from "./coletor.js";
import { API_ESPERADA } from "./config.js";
import { enderecoClipora, salvarEnderecoClipora } from "./ajustes.js";

// Janelinha aberta pelo ícone da extensão. Decide o que fazer com a página da aba:
// - vídeo: escolhe a qualidade e baixa direto (sem abrir o site do Clipora);
// - uma imagem: baixa direto;
// - várias imagens (perfil, feed, capítulo, página comum): junta as imagens na própria página
//   e abre o Clipora para escolher quais baixar e a pasta.
// Vídeo e imagem única são gravados por esta janela, no PC do navegador, na pasta escolhida
// na janela "Salvar como" do Windows (começa na Área de Trabalho ou na última pasta usada).

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("aba"));
const windowId = Number(params.get("janela"));
const pageUrl = params.get("url") || "";
const pageTitle = params.get("titulo") || "";
const SECOES = ["carregando", "video", "imagem", "progresso", "pronto", "coletando", "erro", "ajustes"];

let base = "";
let secaoAnterior = "carregando";
let cancelar = null;

function mostrar(id) {
  for (const secao of SECOES) $(`#${secao}`).classList.toggle("hidden", secao !== id);
  if (id !== "ajustes") secaoAnterior = id;
}

function carregando(texto) {
  $("#carregando-texto").textContent = texto;
  mostrar("carregando");
}

function erro(texto, { coletar = false, abrir = false } = {}) {
  $("#erro-texto").textContent = texto;
  $("#erro-coletar").classList.toggle("hidden", !coletar);
  $("#erro-abrir").classList.toggle("hidden", !abrir);
  mostrar("erro");
}

function pronto(titulo, texto) {
  $("#pronto-titulo").textContent = titulo;
  $("#pronto-texto").textContent = texto;
  mostrar("pronto");
  window.setTimeout(() => window.close(), 3500);
}

function progresso(titulo, valor, texto) {
  $("#progresso-titulo").textContent = titulo;
  $("#progresso-barra").style.width = `${Math.max(0, Math.min(100, Number(valor) || 0))}%`;
  $("#progresso-texto").textContent = texto || "";
  mostrar("progresso");
}

class ErroClipora extends Error {
  constructor(message, code = null, offline = false) {
    super(message);
    this.code = code;
    this.offline = offline;
  }
}

async function api(caminho, opcoes = {}) {
  let resposta;
  try {
    resposta = await fetch(`${base}${caminho}`, {
      cache: "no-store",
      ...opcoes,
      headers: opcoes.body ? { "Content-Type": "application/json" } : {}
    });
  } catch {
    throw new ErroClipora(
      `Não consegui falar com o Clipora em ${base}. Ele está ligado? Se o endereço mudou, troque na engrenagem lá em cima.`,
      null,
      true
    );
  }
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new ErroClipora(dados.error || "O Clipora não conseguiu ler essa página.", dados.code || null);
  return dados;
}

const postJson = (caminho, corpo) => api(caminho, { method: "POST", body: JSON.stringify(corpo) });
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nomeDoArquivo(resposta, reserva) {
  const cabecalho = resposta.headers.get("content-disposition") || "";
  const codificado = cabecalho.match(/filename\*=UTF-8''([^;]+)/i);
  if (codificado) return decodeURIComponent(codificado[1]);
  return cabecalho.match(/filename="([^"]+)"/i)?.[1] || reserva;
}

function abrirNoClipora(hash) {
  chrome.tabs.create({ url: `${base}/${hash}` }).finally(() => window.close());
}

// ---------- Onde salvar ----------

// O último arquivo salvo fica guardado (IndexedDB) para a próxima janela "Salvar como"
// começar na mesma pasta. Sem ele, começa na Área de Trabalho.
function guardado(modo, acao) {
  return new Promise((resolve, reject) => {
    const abrir = indexedDB.open("clipora-extensao", 1);
    abrir.onupgradeneeded = () => abrir.result.createObjectStore("pastas");
    abrir.onerror = () => reject(abrir.error);
    abrir.onsuccess = () => {
      const db = abrir.result;
      const transacao = db.transaction("pastas", modo);
      const pedido = acao(transacao.objectStore("pastas"));
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error);
      transacao.oncomplete = transacao.onabort = () => db.close();
    };
  });
}

// Precisa ser chamada logo depois de um clique (o navegador exige).
async function escolherArquivo(nome, tipo) {
  const ultimo = await guardado("readonly", (store) => store.get("ultimo")).catch(() => null);
  const extensao = (nome.match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
  const opcoes = { suggestedName: nome, startIn: ultimo || "desktop" };
  if (tipo && extensao) opcoes.types = [{ description: tipo.descricao, accept: { [tipo.mime]: [extensao] } }];
  try {
    return await window.showSaveFilePicker(opcoes);
  } catch (error) {
    // O arquivo guardado pode ter sido apagado/movido: tenta de novo pela Área de Trabalho.
    if (ultimo && error.name !== "AbortError" && error.name !== "SecurityError") {
      return window.showSaveFilePicker({ ...opcoes, startIn: "desktop" });
    }
    throw error;
  }
}

async function lembrarPasta(arquivo) {
  await guardado("readwrite", (store) => store.put(arquivo, "ultimo")).catch(() => {});
}

// ---------- Vídeo ----------

function nomeQualidade(altura, largura) {
  if (!altura) return ["Melhor", "Qualidade disponível"];
  const lado = largura ? Math.min(largura, altura) : altura;
  const nomes = { 2160: "4K", 1440: "2K", 1080: "Full HD", 720: "HD", 480: "SD", 360: "Baixa", 240: "Baixa" };
  const vertical = largura && largura < altura ? " · vertical" : "";
  return [`${lado}p`, `${nomes[lado] || ""}${vertical}`.replace(/^ · /, "")];
}

function mostrarVideo(info) {
  $("#video-titulo").textContent = info.title || pageTitle;
  $("#video-canal").textContent = info.channel || "";
  $("#video-capa").classList.toggle("hidden", !info.thumbnail);
  if (info.thumbnail) $("#video-capa").src = info.thumbnail;
  const lista = $("#qualidades");
  lista.replaceChildren();
  const resolucoes = info.resolutions?.length ? info.resolutions : [{ height: 0, width: 0 }];
  for (const resolucao of resolucoes) {
    const altura = Number(resolucao.height) || 0;
    const [rotulo, detalhe] = nomeQualidade(altura, Number(resolucao.width) || 0);
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "qualidade";
    botao.innerHTML = "<strong></strong><small></small>";
    botao.querySelector("strong").textContent = rotulo;
    botao.querySelector("small").textContent = detalhe;
    botao.addEventListener("click", () => baixarVideo(info, altura));
    lista.appendChild(botao);
  }
  $("#video-editar").onclick = () => abrirNoClipora(`#buscar=${encodeURIComponent(pageUrl)}`);
  mostrar("video");
  lista.querySelector("button")?.focus();
}

async function baixarVideo(info, altura) {
  const raiz = info.fileBase || "video";
  const nome = altura ? `${raiz}-${altura}p.mp4` : `${raiz}.mp4`;
  let arquivo;
  try {
    arquivo = await escolherArquivo(nome, { descricao: "Vídeo MP4", mime: "video/mp4" });
  } catch (error) {
    if (error.name !== "AbortError") erro(`O navegador não abriu a janela "Salvar como" (${error.message}).`);
    return;
  }
  let jobId = null;
  let cancelado = false;
  const controle = new AbortController();
  cancelar = () => {
    cancelado = true;
    controle.abort();
    if (jobId) fetch(`${base}/api/downloads/${jobId}`, { method: "DELETE" }).catch(() => {});
    window.close();
  };
  progresso("Preparando o vídeo", 0, "Criando a tarefa no Clipora...");
  try {
    ({ id: jobId } = await postJson("/api/downloads", { url: pageUrl, height: altura }));
    for (;;) {
      if (cancelado) return;
      const dados = await api(`/api/downloads/${jobId}`);
      progresso("Preparando o vídeo", dados.progress, dados.phase);
      if (dados.status === "ready") break;
      if (dados.status === "error") throw new Error(dados.error || "O Clipora não conseguiu preparar o vídeo.");
      await esperar(700);
    }
    progresso("Salvando o vídeo", 100, `Gravando ${arquivo.name}...`);
    const resposta = await fetch(`${base}/api/downloads/${jobId}/file`, { signal: controle.signal });
    if (!resposta.ok) throw new Error("O Clipora não entregou o arquivo. Tente de novo.");
    await resposta.body.pipeTo(await arquivo.createWritable(), { signal: controle.signal });
    await lembrarPasta(arquivo);
    pronto("Vídeo salvo", `${arquivo.name} foi salvo na pasta escolhida.`);
  } catch (error) {
    if (!cancelado) erro(error.message || "Não foi possível baixar o vídeo.", { abrir: true });
  } finally {
    cancelar = null;
  }
}

// ---------- Imagem única ----------

async function mostrarImagem(galeria) {
  const item = galeria.items[0];
  $("#imagem-titulo").textContent = galeria.title || pageTitle;
  $("#imagem-previa").src = `${base}${item.preview}`;
  const botao = $("#imagem-baixar");
  botao.disabled = true;
  botao.textContent = "Carregando a imagem...";
  mostrar("imagem");
  let arquivoBaixado = null;
  try {
    const resposta = await fetch(`${base}/api/gallery/${galeria.key}/${item.index}/file`);
    if (!resposta.ok) {
      const dados = await resposta.json().catch(() => ({}));
      throw new Error(dados.error || "O site não entregou essa imagem.");
    }
    const blob = await resposta.blob();
    arquivoBaixado = { blob, nome: nomeDoArquivo(resposta, "imagem.jpg"), mime: blob.type || "image/jpeg" };
  } catch (error) {
    erro(error.message, { abrir: true });
    return;
  }
  botao.disabled = false;
  botao.textContent = "Baixar imagem";
  botao.focus();
  botao.onclick = async () => {
    let arquivo;
    try {
      arquivo = await escolherArquivo(arquivoBaixado.nome, { descricao: "Imagem", mime: arquivoBaixado.mime });
    } catch (error) {
      if (error.name !== "AbortError") erro(`O navegador não abriu a janela "Salvar como" (${error.message}).`);
      return;
    }
    const gravador = await arquivo.createWritable();
    await gravador.write(arquivoBaixado.blob);
    await gravador.close();
    await lembrarPasta(arquivo);
    pronto("Imagem salva", `${arquivo.name} foi salva na pasta escolhida.`);
  };
}

// Aba mostrando só uma imagem (endereço direto de um .jpg, .png...).
async function imagemDireta() {
  carregando("Lendo a imagem...");
  const galeria = await postJson("/api/gallery/import", {
    source: "page",
    url: pageUrl,
    title: pageTitle,
    items: [[pageUrl, 0, 0]]
  });
  return mostrarImagem(galeria);
}

// ---------- Várias imagens: o coletor roda na página ----------

async function coletar() {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: collectorScript, args: [base, { extension: true }] });
  } catch (error) {
    erro(`O navegador não deixou a extensão ler esta página (${error.message}). Páginas do próprio navegador e da loja de extensões são protegidas.`);
    return;
  }
  mostrar("coletando");
  // Volta para a página, para a rolagem automática não ficar parada em segundo plano.
  chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (windowId) chrome.windows.update(windowId, { focused: true }).catch(() => {});
  window.setTimeout(() => window.close(), 4000);
}

// ---------- Início ----------

async function iniciar() {
  base = await enderecoClipora();
  if (!/^https?:\/\//i.test(pageUrl)) {
    erro("Abra a página do vídeo, da imagem ou do perfil e clique no ícone do Clipora de novo.");
    return;
  }
  if (pageUrl.startsWith(`${base}/`) || pageUrl === base) {
    erro("Esta já é a página do Clipora. Use a extensão na página do vídeo ou das imagens.");
    return;
  }
  carregando("Lendo a página...");
  try {
    // Imagem aberta direto na aba.
    const [resultado] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType })
      .catch(() => [null]);
    if (String(resultado?.result || "").startsWith("image/")) {
      await imagemDireta();
      return;
    }

    let info;
    try {
      info = await postJson("/api/info", { url: pageUrl });
    } catch (error) {
      // Perfis do X/Instagram, listas do Reddit, ArtStation: só o navegador consegue ler.
      if (["needs_browser", "artstation_blocked"].includes(error.code)) return coletar();
      if (error.offline) return erro(error.message);
      return erro(`${error.message} Se a página tem imagens, dá para juntá-las mesmo assim.`, { coletar: true });
    }
    if (info.apiVersion !== API_ESPERADA) {
      erro("A extensão e o Clipora estão em versões diferentes. Baixe a extensão de novo pelo Clipora (atalho Baixar Imagens) e recarregue-a em chrome://extensions.");
      return;
    }
    if (!info.gallery) return mostrarVideo(info);
    if (info.items.length === 1 && info.items[0].kind === "image") return mostrarImagem(info);
    // Página com várias imagens: o coletor junta o que o usuário vê (com login, rolando).
    if (info.page) return coletar();
    // Post com várias mídias (carrossel do Instagram, obra com várias imagens): escolher no site.
    abrirNoClipora(`#buscar=${encodeURIComponent(pageUrl)}`);
  } catch (error) {
    erro(error.message || "Algo deu errado.", { abrir: true });
  }
}

$("#progresso-cancelar").addEventListener("click", () => (cancelar ? cancelar() : window.close()));
$("#erro-coletar").addEventListener("click", () => coletar());
$("#erro-abrir").addEventListener("click", () => abrirNoClipora(`#buscar=${encodeURIComponent(pageUrl)}`));

// ---------- Engrenagem: endereço do Clipora ----------

$("#abrir-ajustes").addEventListener("click", async () => {
  $("#ajustes-endereco").value = base || await enderecoClipora();
  $("#ajustes-erro").textContent = "";
  mostrar("ajustes");
  $("#ajustes-endereco").focus();
});
$("#ajustes-voltar").addEventListener("click", () => mostrar(secaoAnterior));
$("#ajustes-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let origem;
  try {
    origem = new URL($("#ajustes-endereco").value.trim()).origin;
  } catch {
    $("#ajustes-erro").textContent = "Endereço inválido. Exemplo: https://clipora.<sua-tailnet>.ts.net";
    return;
  }
  // Endereços fora da lista do manifesto (ex.: um IP da rede) precisam de permissão.
  const padrao = `${origem.replace(/:\d+$/, "")}/*`;
  const liberado = await chrome.permissions.contains({ origins: [padrao] })
    || await chrome.permissions.request({ origins: [padrao] }).catch(() => false);
  if (!liberado) {
    $("#ajustes-erro").textContent = "Sem permissão para falar com esse endereço.";
    return;
  }
  await salvarEnderecoClipora(origem);
  base = origem;
  iniciar();
});

iniciar();
