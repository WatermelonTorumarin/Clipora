import { $, formatDuration, isHttpUrl, qualityLabel } from "./util.js";
import {
  API_VERSION, CancelledError, OUTDATED_SERVER_MESSAGE, createUrlSession, deleteSession, fetchVideoInfo, postJson,
  requestJson, triggerDownload, uploadSession, waitForSession
} from "./api.js";
import { hideProgress, progressDone, progressError, showProgress, updateProgress } from "./progress.js";
import { closeEditor, isEditorOpen, openEditor, setSessionLostHandler } from "./editor.js";
import { TOOLS, closeTool, currentTool, loadFile as loadToolFile, openTool, setOpenEditorHandler } from "./tools.js";
import { hideGallery, renderGallery } from "./gallery.js";

const VIDEO_FILE_PATTERN = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

const el = {
  homeView: $("#home-view"),
  form: $("#url-form"),
  input: $("#video-url"),
  paste: $("#paste-button"),
  openLocal: $("#open-local-video"),
  localInput: $("#local-video-input"),
  message: $("#message"),
  result: $("#result"),
  qualityList: $("#quality-list"),
  editorVideo: $("#editor-video"),
  dropOverlay: $("#drop-overlay"),
  toolInput: $("#tool-video-url"),
  help: $("#browser-help"),
  helpTitle: $("#browser-help-title"),
  helpText: $("#browser-help-text"),
  helpSteps: $("#browser-help-steps")
};
el.submit = el.form.querySelector(".primary-button");

let currentUrl = "";
let taskToken = 0;
let busy = false;

setSessionLostHandler((text) => {
  el.message.textContent = text;
  el.message.scrollIntoView({ behavior: "smooth", block: "center" });
});

setOpenEditorHandler((id, data) => {
  goHome();
  openEditor(id, data);
});

function setLoading(loading) {
  el.submit.disabled = loading;
  el.submit.querySelector("span").textContent = loading ? "Analisando..." : "Buscar vídeo";
}

function setQualityButtonsDisabled(disabled) {
  el.qualityList.querySelectorAll(".quality-action").forEach((button) => { button.disabled = disabled; });
}

function resolutionCopy(height, width) {
  if (!height) return "<strong>Melhor</strong><small>Qualidade disponível</small>";
  const shortSide = width ? Math.min(width, height) : height;
  const vertical = width && width < height ? " · vertical" : "";
  return `<strong>${shortSide}p</strong><small>${qualityLabel(shortSide)}${vertical}</small>`;
}

function renderResult(data) {
  const thumbnail = $("#thumbnail");
  thumbnail.classList.toggle("hidden", !data.thumbnail);
  if (data.thumbnail) thumbnail.src = data.thumbnail;
  else thumbnail.removeAttribute("src");
  $("#video-title").textContent = data.title;
  $("#video-channel").textContent = data.channel || "Fonte desconhecida";
  $("#duration").textContent = formatDuration(data.duration);

  el.qualityList.replaceChildren();
  // Alguns sites não informam resoluções; nesse caso oferecemos a melhor disponível.
  const resolutions = data.resolutions.length ? data.resolutions : [{ height: 0, width: 0 }];
  resolutions.forEach((resolution) => {
    const height = Number(resolution.height) || 0;
    const width = Number(resolution.width) || 0;
    const option = document.createElement("div");
    option.className = "quality-option";
    option.innerHTML = `
      <div class="quality-copy">${resolutionCopy(height, width)}</div>
      <div class="quality-actions">
        <button class="quality-action download-action" type="button" title="Baixar direto">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v9l3.5-3.5 1.4 1.4-5.9 5.9-5.9-5.9 1.4-1.4L11 13V4Zm-5 15h12v2H6v-2Z" fill="currentColor"/></svg>
          Baixar
        </button>
        <button class="quality-action edit-action" type="button" title="Editar antes de baixar">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.6 12 3.3 5.7l1.4-1.4 7.3 7.3 7.3-7.3 1.4 1.4-6.3 6.3 6.3 6.3-1.4 1.4-7.3-7.3-7.3 7.3-1.4-1.4L9.6 12Z" fill="currentColor"/></svg>
          Editar
        </button>
      </div>`;
    option.querySelector(".download-action").addEventListener("click", () => startDownload(height));
    option.querySelector(".edit-action").addEventListener("click", () => startEditorFromUrl(height));
    el.qualityList.appendChild(option);
  });
  $("#page-images-button").classList.toggle("hidden", !data.pageImages);
  el.result.classList.remove("hidden");
  el.result.scrollIntoView({ behavior: "smooth", block: "center" });
}

// O link tinha um vídeo, mas o usuário quer as imagens da página.
async function findPageImages() {
  const button = $("#page-images-button");
  button.disabled = true;
  button.querySelector("span").textContent = "Lendo as imagens da página...";
  el.message.textContent = "";
  try {
    const data = await postJson("/api/page-images", { url: currentUrl });
    if (data.apiVersion !== API_VERSION) throw new Error(OUTDATED_SERVER_MESSAGE);
    el.result.classList.add("hidden");
    renderGallery(data, currentUrl);
  } catch (error) {
    if (error.code === "needs_browser") showBrowserHelp(error.site || "default", error.message);
    else el.message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Baixar as imagens desta página";
  }
}

async function findVideo(url) {
  el.message.textContent = "";
  el.result.classList.add("hidden");
  el.help.classList.add("hidden");
  hideGallery();
  if (!isHttpUrl(url)) {
    el.message.textContent = "Cole um link válido (começando com http:// ou https://).";
    return;
  }
  setLoading(true);
  try {
    const data = await fetchVideoInfo(url);
    currentUrl = url;
    // Fotos do Instagram, DeviantArt, ArtStation, MangaDex e páginas com imagens abrem a
    // galeria; o resto é vídeo.
    if (data.gallery) renderGallery(data, url);
    else renderResult(data);
  } catch (error) {
    // Sites que o servidor não consegue ler sozinho: oferece o botão de favoritos.
    if (error.code === "needs_browser" || error.code === "artstation_blocked") {
      el.message.textContent = "";
      showBrowserHelp(error.code === "artstation_blocked" ? "ArtStation" : error.site || "default", error.message);
    } else {
      el.message.textContent = error.message;
    }
  } finally {
    setLoading(false);
  }
}

// ---------- Download direto (fluxo principal) ----------

async function startDownload(height) {
  if (busy) return;
  busy = true;
  const token = ++taskToken;
  let downloadId = null;
  setQualityButtonsDisabled(true);
  showProgress("Preparando seu MP4", 0, "Criando tarefa de download...", () => {
    taskToken += 1;
    if (downloadId) fetch(`/api/downloads/${downloadId}`, { method: "DELETE" }).catch(() => {});
    finishTask();
  });
  try {
    ({ id: downloadId } = await postJson("/api/downloads", { url: currentUrl, height }));
    for (;;) {
      if (token !== taskToken) throw new CancelledError();
      const data = await requestJson(`/api/downloads/${downloadId}`);
      if (token !== taskToken) throw new CancelledError();
      updateProgress(data.progress, data.phase);
      if (data.status === "ready") break;
      if (data.status === "error") throw new Error(data.error || "Falha ao preparar o download.");
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    progressDone("Arquivo pronto. Iniciando download...");
    triggerDownload(`/api/downloads/${downloadId}/file`);
  } catch (error) {
    if (!(error instanceof CancelledError) && token === taskToken) progressError(error.message);
  } finally {
    if (token === taskToken) finishTask();
  }
}

function finishTask() {
  busy = false;
  setQualityButtonsDisabled(false);
}

// ---------- Editor (fluxo principal) ----------

async function openEditorSession(title, createSession) {
  if (busy) return;
  busy = true;
  const token = ++taskToken;
  let sessionId = null;
  setQualityButtonsDisabled(true);
  if (isEditorOpen()) await closeEditor();
  showProgress(title, 0, "Preparando...", () => {
    taskToken += 1;
    if (sessionId) deleteSession(sessionId);
    finishTask();
  });
  try {
    sessionId = await createSession((value, phase) => {
      if (token === taskToken) updateProgress(value, phase);
    });
    if (token !== taskToken) throw new CancelledError();
    const data = await waitForSession(sessionId, {
      until: ["editor_ready"],
      isCancelled: () => token !== taskToken,
      onProgress: (info) => updateProgress(info.progress, info.phase)
    });
    hideProgress();
    openEditor(sessionId, data);
  } catch (error) {
    if (sessionId && (error instanceof CancelledError || token !== taskToken)) deleteSession(sessionId);
    else if (token === taskToken) {
      if (sessionId) deleteSession(sessionId);
      progressError(error.message);
    }
  } finally {
    if (token === taskToken) finishTask();
  }
}

function startEditorFromUrl(height) {
  openEditorSession("Preparando o editor", async (onProgress) => {
    onProgress(0, "Baixando a fonte do vídeo...");
    const { id } = await createUrlSession(currentUrl, height, "editor");
    return id;
  });
}

function startEditorFromFile(file) {
  if (!file) return;
  openEditorSession("Abrindo vídeo local", async (onProgress) => {
    const { id } = await uploadSession(file, "editor", (ratio) => onProgress(ratio * 85, "Carregando vídeo local..."));
    return id;
  });
}

// ---------- Rotas: página inicial e ferramentas ----------

function goHome() {
  if (location.hash) history.pushState(null, "", location.pathname + location.search);
  route();
}

// ---------- Extensão do Clipora (qualquer site) ----------

// A extensão (pasta extensao/) usa o coletor de coletor.js. Aqui ficam o cartão que ensina a
// instalar e usar a extensão e a chegada dos dados que ela manda (#importar=... e #buscar=...).

const HELP_STEP_OPEN = {
  X: "Abra o perfil no X, vá na aba Mídia e clique no ícone do Clipora na barra do navegador.",
  Instagram: "Abra o perfil no Instagram e clique no ícone do Clipora na barra do navegador.",
  Reddit: "Abra o subreddit, o perfil ou o post no Reddit e clique no ícone do Clipora na barra do navegador.",
  default: "Abra a página no navegador e clique no ícone do Clipora na barra do navegador."
};
const HELP_STEPS_AFTER = [
  "Uma caixinha do Clipora aparece no canto e rola a página sozinha para carregar as imagens. Clique em \"Enviar ao Clipora\" quando quiser, ou espere chegar ao fim.",
  "O Clipora abre numa nova aba: escolha quais imagens baixar e onde salvar a pasta."
];
const HELP_INTRO =
  "Cole o link na busca acima: capítulos do MangaDex e páginas comuns o Clipora lê sozinho. " +
  "Para X, Instagram (perfis), Reddit e páginas que exigem login ou carregam as imagens aos poucos, use a extensão do Clipora:";

// site: "intro" (atalho Baixar Imagens), "ArtStation", "X", "Instagram", "Reddit" ou "default".
function showBrowserHelp(site, message = "") {
  const artstation = site === "ArtStation";
  const intro = site === "intro";
  el.helpTitle.textContent = intro
    ? "Baixar todas as imagens de uma página"
    : `${HELP_STEP_OPEN[site] ? `${site}: use` : "Use"} a extensão do Clipora`;
  el.helpText.textContent = intro ? HELP_INTRO : message;
  const steps = artstation
    ? ["Abra a obra no ArtStation e clique no ícone do Clipora na barra do navegador. O Clipora abre numa nova aba com as imagens em 4K."]
    : [HELP_STEP_OPEN[site] || HELP_STEP_OPEN.default, ...HELP_STEPS_AFTER];
  el.helpSteps.replaceChildren();
  steps.forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    el.helpSteps.appendChild(item);
  });
  el.help.classList.remove("hidden");
  el.help.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showHomeClean() {
  closeTool();
  el.homeView.classList.remove("hidden");
  el.message.textContent = "";
  el.result.classList.add("hidden");
  el.help.classList.add("hidden");
  hideGallery();
}

async function importFromHash() {
  const raw = location.hash.slice("#importar=".length);
  history.replaceState(null, "", location.pathname + location.search);
  showHomeClean();
  try {
    const data = JSON.parse(decodeURIComponent(raw));
    const count = Array.isArray(data.items) ? data.items.length : 0;
    if (data.source === "page") {
      const posts = data.items.filter((item) => Array.isArray(item) && item[4]).length;
      el.message.textContent = `Analisando ${count} ${count === 1 ? "imagem enviada" : "imagens enviadas"} pela extensão...` +
        (posts ? ` Abrindo ${posts} ${posts === 1 ? "post" : "posts"} do X para pegar todas as fotos (pode levar um minuto).` : "");
    }
    const gallery = await postJson("/api/gallery/import", data);
    if (gallery.apiVersion !== API_VERSION) throw new Error(OUTDATED_SERVER_MESSAGE);
    el.message.textContent = "";
    currentUrl = data.source === "page" ? data.url : `https://www.artstation.com/artwork/${data.hash}`;
    renderGallery(gallery, currentUrl);
  } catch (error) {
    el.message.textContent = error instanceof SyntaxError || error instanceof URIError
      ? "Não foi possível ler os dados enviados pela extensão. Clique no ícone dela de novo na página."
      : error.message;
  }
}

// #buscar=<link>: o botão manda só o link (ex.: capítulo do MangaDex) e o Clipora busca.
function searchFromHash() {
  const url = decodeURIComponent(location.hash.slice("#buscar=".length));
  history.replaceState(null, "", location.pathname + location.search);
  showHomeClean();
  el.input.value = url;
  findVideo(url);
}

function route() {
  if (location.hash.startsWith("#importar=")) {
    importFromHash();
    return;
  }
  if (location.hash.startsWith("#buscar=")) {
    searchFromHash();
    return;
  }
  // Atalho "Baixar Imagens": mostra como baixar todas as imagens de uma página.
  if (location.hash === "#imagens") {
    history.replaceState(null, "", location.pathname + location.search);
    showHomeClean();
    showBrowserHelp("intro");
    el.input.focus({ preventScroll: true });
    return;
  }
  const name = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (TOOLS[name]) {
    // O editor continua aberto (e com a sessão viva) enquanto a ferramenta é usada.
    el.editorVideo.pause();
    el.homeView.classList.add("hidden");
    openTool(name);
  } else {
    closeTool();
    el.homeView.classList.remove("hidden");
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("popstate", route);
$("#tool-back").addEventListener("click", goHome);
$("#page-images-button").addEventListener("click", findPageImages);
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  goHome();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------- Entrada do vídeo ----------

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  findVideo(el.input.value.trim());
});

el.paste.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    el.input.value = text;
    el.input.focus();
    if (isHttpUrl(text)) findVideo(text);
  } catch {
    el.message.textContent = "O navegador bloqueou a área de transferência. Use Ctrl+V no campo.";
    el.input.focus();
  }
});

window.addEventListener("paste", (event) => {
  if (event.target.matches?.("input, textarea")) return;
  const text = event.clipboardData?.getData("text")?.trim();
  if (!text || !isHttpUrl(text)) return;
  (currentTool() ? el.toolInput : el.input).value = text;
});

el.openLocal.addEventListener("click", () => el.localInput.click());
el.localInput.addEventListener("change", () => {
  startEditorFromFile(el.localInput.files?.[0]);
  el.localInput.value = "";
});

// Arrastar um vídeo para qualquer lugar da página.
let dragDepth = 0;
const draggingFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");

window.addEventListener("dragenter", (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  el.dropOverlay.classList.remove("hidden");
});
window.addEventListener("dragover", (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  if (!draggingFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.dropOverlay.classList.add("hidden");
});
window.addEventListener("drop", (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  el.dropOverlay.classList.add("hidden");
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  if (!VIDEO_FILE_PATTERN.test(file.name)) {
    const text = "Formato não suportado. Use MP4, MOV, M4V, WEBM, MKV ou AVI.";
    if (currentTool()) $("#tool-message").textContent = text;
    else el.message.textContent = text;
    return;
  }
  if (currentTool()) loadToolFile(file);
  else startEditorFromFile(file);
});

route();
