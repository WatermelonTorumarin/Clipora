import { $, formatDuration } from "./util.js";
import { CancelledError, postJson, requestJson, triggerDownload } from "./api.js";
import { progressDone, progressError, showProgress, updateProgress } from "./progress.js";

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v9l3.5-3.5 1.4 1.4-5.9 5.9-5.9-5.9 1.4-1.4L11 13V4Zm-5 15h12v2H6v-2Z" fill="currentColor"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4-9.6 9.6Z" fill="currentColor"/></svg>`;
const DESTINATION_KEY = "clipora.destino";

const el = {
  section: $("#gallery"),
  label: $("#gallery-label"),
  title: $("#gallery-title"),
  meta: $("#gallery-meta"),
  notes: $("#gallery-notes"),
  grid: $("#gallery-grid"),
  saveAll: $("#gallery-save-all"),
  folderResult: $("#gallery-folder-result"),
  folderText: $("#gallery-folder-text"),
  openFolder: $("#gallery-open-folder"),
  pageControls: $("#gallery-page-controls"),
  countAll: $("#gallery-count-all"),
  countNumber: $("#gallery-count-number"),
  countPick: $("#gallery-count-pick"),
  countError: $("#gallery-count-error"),
  smallToggle: $("#gallery-small-toggle"),
  showSmall: $("#gallery-show-small"),
  smallText: $("#gallery-small-text"),
  dialog: $("#folder-dialog"),
  dialogTitle: $("#folder-dialog-title"),
  form: $("#folder-form"),
  folderName: $("#folder-name"),
  destination: $("#folder-destination"),
  customOption: $("#folder-destination option[value='custom']"),
  folderPick: $("#folder-pick"),
  folderHint: $("#folder-hint"),
  folderError: $("#folder-error"),
  folderCancel: $("#folder-cancel"),
  folderConfirm: $("#folder-confirm"),
  serverDestination: $("#folder-server-destination"),
  folderLocation: $("#folder-location"),
  folderLocationText: $("#folder-location-text"),
  folderChange: $("#folder-change")
};

let current = null;
let taskToken = 0;
let savedFolderJob = null;
let folders = null;
let destination = loadDestination();

// Com Shift pressionado o navegador transforma a roda do mouse em rolagem para o lado, e a
// lista não descia enquanto o usuário segurava Shift para marcar várias. Na galeria, Shift +
// roda continua rolando para baixo/cima.
const WHEEL_LINE = 40;
window.addEventListener("wheel", (event) => {
  if (!event.shiftKey || event.ctrlKey || event.metaKey || !current) return;
  if (el.section.classList.contains("hidden") || el.dialog.open) return;
  const delta = event.deltaY || event.deltaX;
  if (!delta) return;
  const scale = event.deltaMode === 1 ? WHEEL_LINE : event.deltaMode === 2 ? window.innerHeight : 1;
  event.preventDefault();
  window.scrollBy({ top: delta * scale, behavior: "instant" });
}, { passive: false });

export function hideGallery() {
  taskToken += 1;
  current = null;
  el.section.classList.add("hidden");
  el.grid.replaceChildren();
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function describeItems(items, source) {
  const images = items.filter((item) => item.kind === "image").length;
  const videos = items.length - images;
  const [one, many] = source === "Instagram" ? ["foto", "fotos"] : ["imagem", "imagens"];
  const parts = [];
  if (images) parts.push(plural(images, one, many));
  if (videos) parts.push(plural(videos, "vídeo", "vídeos"));
  return parts.join(" e ");
}

function galleryLabel(source, page) {
  if (source === "MangaDex") return "Capítulo encontrado";
  if (page) return "Página encontrada";
  return source === "Instagram" ? "Post encontrado" : `Obra encontrada no ${source}`;
}

// Mesma tela para posts do Instagram, obras do DeviantArt/ArtStation e páginas inteiras
// (data.page: X, Reddit, MangaDex, sites de leitura...), que ganham o seletor de quantidade.
export function renderGallery(data, url) {
  const source = data.source || "Instagram";
  current = {
    key: data.key,
    url,
    source,
    channel: data.channel,
    page: Boolean(data.page),
    suggestedFolder: data.suggestedFolder || "",
    // saveMode "browser": o Clipora roda em outro PC, então quem salva a pasta é este navegador.
    saveMode: data.saveMode || "server",
    items: data.items
  };
  // Tudo começa marcado; a bolinha de cada mídia marca/desmarca.
  for (const item of current.items) item.checked = true;
  anchorItem = null;
  el.label.textContent = galleryLabel(source, current.page);
  el.title.textContent = data.title;
  el.notes.textContent = (data.notes || []).join(" ");
  el.notes.classList.toggle("hidden", !data.notes?.length);
  el.folderResult.classList.add("hidden");
  el.pageControls.classList.toggle("hidden", !current.page);
  el.grid.classList.toggle("compact", current.page);
  if (current.page) {
    el.pageControls.querySelector("input[value='all']").checked = true;
    el.countNumber.value = String(Math.min(20, data.items.length));
    el.countPick.value = "";
    el.countError.classList.add("hidden");
    el.showSmall.checked = false;
  }
  el.grid.replaceChildren(...data.items.map(buildCard));
  updateSelection();
  el.section.classList.remove("hidden");
  el.section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildCard(item) {
  const card = document.createElement("article");
  card.className = "gallery-item";
  const video = item.kind === "video"
    ? `<span class="gallery-video-badge">▶ Vídeo${item.duration ? ` · ${formatDuration(item.duration)}` : ""}</span>`
    : "";
  card.innerHTML = `
    <div class="gallery-thumb">
      <img src="${item.preview}" alt="Mídia ${item.index + 1}" loading="lazy" />
      <span class="gallery-index">${item.index + 1}</span>
      ${video}
    </div>
    <span class="gallery-caption"></span>
    <button class="gallery-save" type="button">${DOWNLOAD_ICON}<span>Salvar</span></button>`;
  // Com mais de uma mídia: bolinha no canto para escolher o que entra na pasta.
  if (current.items.length > 1) {
    const thumb = card.querySelector(".gallery-thumb");
    thumb.classList.add("selectable");
    const check = document.createElement("button");
    check.type = "button";
    check.className = "gallery-check";
    check.innerHTML = CHECK_ICON;
    thumb.appendChild(check);
    item.check = check;
    thumb.addEventListener("click", (event) => toggleItem(item, event.shiftKey));
    // Shift+clique não deve selecionar o texto da página.
    thumb.addEventListener("mousedown", (event) => { if (event.shiftKey) event.preventDefault(); });
  }
  const caption = card.querySelector(".gallery-caption");
  caption.textContent = item.caption || "";
  caption.classList.toggle("hidden", !item.caption);
  const button = card.querySelector(".gallery-save");
  button.addEventListener("click", () => saveItem(item, button));
  item.card = card;
  item.badge = card.querySelector(".gallery-index");
  // Numa página inteira, imagem que não carrega sai da galeria e da contagem.
  card.querySelector("img").addEventListener("error", () => {
    if (!current?.page || item.broken) return;
    item.broken = true;
    updateSelection();
  });
  return card;
}

// ---------- Quantas imagens (páginas inteiras) ----------

function visibleItems() {
  if (!current) return [];
  if (!current.page) return current.items;
  return current.items.filter((item) => !item.broken && (el.showSmall.checked || !item.small));
}

// Bolinha clicada. Com mais de 3 mídias, Shift+clique leva o estado da última mídia clicada
// (marcada ou desmarcada) para todas entre ela e esta, como no Explorer.
let anchorItem = null;

function toggleItem(item, shift) {
  const visible = visibleItems();
  const from = visible.indexOf(anchorItem);
  const to = visible.indexOf(item);
  if (shift && current.items.length > 3 && from >= 0 && to >= 0 && from !== to) {
    const state = anchorItem.checked !== false;
    const [start, end] = from < to ? [from, to] : [to, from];
    for (let position = start; position <= end; position += 1) visible[position].checked = state;
  } else {
    item.checked = item.checked === false;
  }
  anchorItem = item;
  updateSelection();
}

// O que vai para a pasta: as mídias visíveis que estão marcadas (bolinha), na ordem.
function selectedItems() {
  return visibleItems().filter((item) => item.checked !== false);
}

// "1, 4, 7-10" -> números de 1 a max. Devolve { numbers } ou { error }.
function parseNumbers(text, max) {
  const numbers = new Set();
  const parts = String(text).replace(/\s*-\s*/g, "-").split(/[,;\s]+/).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return { error: `"${part}" não é um número nem um intervalo. Use, por exemplo: 1, 4, 7-10.` };
    let start = Number(match[1]);
    let end = match[2] ? Number(match[2]) : start;
    if (start > end) [start, end] = [end, start];
    for (let number = Math.max(1, start); number <= Math.min(end, max); number += 1) numbers.add(number);
  }
  return { numbers };
}

const countMode = () => el.pageControls.querySelector("input[name='gallery-count']:checked")?.value || "all";

// "Quantas baixar?" marca e desmarca as bolinhas; depois dá para ajustar uma a uma.
function applyCountRule() {
  if (!current?.page) return;
  const visible = visibleItems();
  const mode = countMode();
  el.countError.classList.add("hidden");
  let keep = () => true;
  if (mode === "first") {
    const count = Math.max(1, Math.floor(Number(el.countNumber.value) || 1));
    keep = (position) => position < count;
  } else if (mode === "pick") {
    if (!el.countPick.value.trim()) return; // ainda não digitou: deixa como está
    const { numbers, error } = parseNumbers(el.countPick.value, visible.length);
    if (error) {
      el.countError.textContent = error;
      el.countError.classList.remove("hidden");
      return;
    }
    keep = (position) => numbers.has(position + 1);
  }
  visible.forEach((item, position) => { item.checked = keep(position); });
}

function updateSelection() {
  if (!current) return;
  const visible = visibleItems();
  const chosen = new Set(selectedItems());
  for (const item of current.items) {
    if (!item.check) continue;
    const on = item.checked !== false;
    item.check.setAttribute("aria-pressed", String(on));
    item.check.title = on ? "Desmarcar (não baixar)" : "Marcar para baixar";
    item.check.setAttribute("aria-label", `${on ? "Desmarcar" : "Marcar"} a mídia ${item.badge.textContent}`);
  }
  if (!current.page) {
    for (const item of current.items) item.card.classList.toggle("excluded", !chosen.has(item));
    const all = chosen.size === current.items.length;
    el.meta.textContent = `${current.channel} · ${describeItems(current.items, current.source)}`;
    el.saveAll.querySelector("span").textContent = current.items.length === 1
      ? "Salvar em uma pasta"
      : all ? "Salvar tudo em uma pasta"
        : chosen.size ? `Salvar ${plural(chosen.size, "selecionada", "selecionadas")} em uma pasta` : "Nada marcado para salvar";
    el.saveAll.disabled = !chosen.size;
    return;
  }
  let position = 0;
  for (const item of current.items) {
    const hidden = item.broken || (item.small && !el.showSmall.checked);
    item.card.classList.toggle("hidden", hidden);
    if (hidden) continue;
    position += 1;
    // Número fixo de cada imagem na lista (é o que se digita em "Só as de número").
    item.badge.textContent = String(position);
    item.check?.setAttribute("aria-label", `${chosen.has(item) ? "Desmarcar" : "Marcar"} a imagem ${position}`);
    item.card.classList.toggle("excluded", !chosen.has(item));
  }
  const small = current.items.filter((item) => item.small && !item.broken).length;
  el.smallToggle.classList.toggle("hidden", !small);
  el.smallText.textContent = `Mostrar também ${plural(small, "imagem pequena", "imagens pequenas")} (ícones, avatares)`;
  el.countAll.textContent = `(${visible.length})`;
  el.countNumber.max = String(Math.max(1, visible.length));
  const unit = current.source === "MangaDex" ? ["página", "páginas"] : ["imagem", "imagens"];
  el.meta.textContent = `${current.channel} · ${plural(visible.length, ...unit)}`;
  el.saveAll.querySelector("span").textContent = chosen.size
    ? `Baixar ${plural(chosen.size, ...unit)} em uma pasta`
    : "Nenhuma imagem para baixar";
  el.saveAll.disabled = !chosen.size;
}

const reapply = () => {
  applyCountRule();
  updateSelection();
};
// Clique (não só "change"): clicar de novo em "Todas" volta a marcar tudo.
el.pageControls.querySelectorAll("input[name='gallery-count']").forEach((radio) => radio.addEventListener("click", reapply));
el.showSmall.addEventListener("change", reapply);
for (const [input, mode] of [[el.countNumber, "first"], [el.countPick, "pick"]]) {
  const radio = el.pageControls.querySelector(`input[value='${mode}']`);
  input.addEventListener("input", () => {
    radio.checked = true;
    reapply();
  });
  // Entrar no campo só troca de opção; não desfaz as bolinhas mexidas à mão.
  input.addEventListener("focus", () => {
    if (radio.checked) return;
    radio.checked = true;
    reapply();
  });
  // Clicar no campo dentro do <label> não deve "clicar" o rádio de novo.
  input.addEventListener("click", (event) => event.stopPropagation());
}

// ---------- Salvar uma mídia ----------

function markSaved(button) {
  button.classList.add("done");
  button.querySelector("span").textContent = "Salvo";
  window.setTimeout(() => {
    button.classList.remove("done");
    button.querySelector("span").textContent = "Salvar";
  }, 2500);
}

function fileNameFrom(response, fallback) {
  const header = response.headers.get("content-disposition") || "";
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) return decodeURIComponent(encoded[1]);
  return header.match(/filename="([^"]+)"/i)?.[1] || fallback;
}

// Fotos: baixa pela própria página para poder avisar se o post expirou.
async function saveImage(item, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/gallery/${current.key}/${item.index}/file`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Não foi possível salvar essa imagem.");
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileNameFrom(response, `imagem-${item.index + 1}.jpg`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60 * 1000);
    markSaved(button);
  } catch (error) {
    showProgress("Salvar imagem", 0, "");
    progressError(error.message);
  } finally {
    button.disabled = false;
  }
}

// Vídeos do carrossel: mesmo download do Clipora (converte para H.264 se preciso).
async function saveVideo(item, button) {
  const token = ++taskToken;
  let jobId = null;
  button.disabled = true;
  showProgress("Preparando o vídeo", 0, "Criando tarefa de download...", () => {
    taskToken += 1;
    if (jobId) fetch(`/api/downloads/${jobId}`, { method: "DELETE" }).catch(() => {});
    button.disabled = false;
  });
  try {
    ({ id: jobId } = await postJson("/api/downloads", { url: current.url, height: 0, item: item.index + 1 }));
    for (;;) {
      if (token !== taskToken) return;
      const data = await requestJson(`/api/downloads/${jobId}`);
      if (token !== taskToken) return;
      updateProgress(data.progress, data.phase);
      if (data.status === "ready") break;
      if (data.status === "error") throw new Error(data.error || "Falha ao preparar o vídeo.");
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    progressDone("Vídeo pronto. Iniciando download...");
    triggerDownload(`/api/downloads/${jobId}/file`);
    markSaved(button);
  } catch (error) {
    if (token === taskToken) progressError(error.message);
  } finally {
    if (token === taskToken) button.disabled = false;
  }
}

function saveItem(item, button) {
  if (!current) return;
  if (item.kind === "image") saveImage(item, button);
  else saveVideo(item, button);
}

// ---------- Onde salvar: Área de Trabalho, Downloads ou outra pasta ----------

// A escolha fica guardada neste navegador para a próxima vez.
function loadDestination() {
  try {
    const saved = JSON.parse(localStorage.getItem(DESTINATION_KEY) || "null");
    if (saved?.kind === "custom" && saved.path) return { kind: "custom", path: String(saved.path) };
    if (saved?.kind === "downloads") return { kind: "downloads" };
  } catch {
    // sem armazenamento: usa o padrão
  }
  return { kind: "desktop" };
}

function storeDestination() {
  try {
    localStorage.setItem(DESTINATION_KEY, JSON.stringify(destination));
  } catch {
    // sem armazenamento: vale só nesta visita
  }
}

function destinationPath() {
  if (destination.kind === "custom") return destination.path;
  return folders?.[destination.kind] || "";
}

function syncDestination() {
  el.customOption.textContent = destination.kind === "custom" ? destination.path : "Outra pasta…";
  el.destination.value = destination.kind;
  el.folderPick.classList.toggle("hidden", destination.kind !== "custom");
}

async function loadFolders() {
  if (folders) return;
  try {
    folders = await requestJson("/api/folders");
  } catch {
    folders = null;
  }
}

async function pickCustomFolder() {
  const previous = { ...destination };
  el.folderPick.disabled = true;
  el.destination.disabled = true;
  el.folderConfirm.disabled = true;
  el.folderError.textContent = "";
  el.folderHint.textContent = "Escolha a pasta na janela do Windows que abriu (se não aparecer, veja a barra de tarefas).";
  try {
    const data = await postJson("/api/folders/pick", { initial: destinationPath() });
    if (data.path) {
      destination = { kind: "custom", path: data.path };
      storeDestination();
    } else {
      destination = previous;
    }
  } catch (error) {
    destination = previous;
    el.folderError.textContent = error.message;
  } finally {
    el.folderPick.disabled = false;
    el.destination.disabled = false;
    el.folderConfirm.disabled = false;
    syncDestination();
    updateFolderHint();
  }
}

el.destination.addEventListener("change", () => {
  const kind = el.destination.value;
  if (kind === "custom") {
    // Já havia uma pasta escolhida antes: volta para ela; senão abre a janela.
    if (destination.kind !== "custom") {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(`${DESTINATION_KEY}.outra`) || "null"); } catch { saved = null; }
      if (saved?.path) {
        destination = { kind: "custom", path: saved.path };
        storeDestination();
      } else {
        pickCustomFolder();
        return;
      }
    }
  } else {
    if (destination.kind === "custom") {
      try { localStorage.setItem(`${DESTINATION_KEY}.outra`, JSON.stringify(destination)); } catch { /* ignora */ }
    }
    destination = { kind };
    storeDestination();
  }
  syncDestination();
  updateFolderHint();
});
el.folderPick.addEventListener("click", pickCustomFolder);

// ---------- Navegador em outro PC (Tailscale): a página grava a pasta ----------

// Três jeitos, conforme onde está o navegador:
// - neste PC (saveMode "server"): o servidor grava no destino de "Salvar em";
// - em outro PC, com Chrome/Edge em HTTPS: a página grava numa pasta que o usuário escolhe;
// - em outro PC sem essa permissão (Firefox, endereço http://): o servidor monta um .zip.

const canPickFolder = typeof window.showDirectoryPicker === "function";
let baseFolder = null;

const isRemote = () => current?.saveMode === "browser";
const savesInBrowserFolder = () => isRemote() && canPickFolder;

// A pasta escolhida fica guardada neste navegador (IndexedDB) para as próximas vezes.
function folderStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("clipora", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pastas");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("pastas", mode);
      const request = action(transaction.objectStore("pastas"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = transaction.onabort = () => db.close();
    };
  });
}

if (canPickFolder) {
  folderStore("readonly", (store) => store.get("salvar"))
    .then((handle) => { baseFolder = handle || null; })
    .catch(() => {});
}

async function chooseBaseFolder() {
  baseFolder = await window.showDirectoryPicker({ id: "clipora-salvar", mode: "readwrite", startIn: "desktop" });
  folderStore("readwrite", (store) => store.put(baseFolder, "salvar")).catch(() => {});
  return baseFolder;
}

// Chamar logo depois de um clique: o navegador pode pedir permissão para gravar.
async function writableBaseFolder() {
  if (!baseFolder) return chooseBaseFolder();
  const options = { mode: "readwrite" };
  if (await baseFolder.queryPermission(options) === "granted") return baseFolder;
  if (await baseFolder.requestPermission(options) === "granted") return baseFolder;
  const error = new Error(`O navegador não liberou a pasta ${baseFolder.name}. Use "Trocar pasta" e escolha de novo.`);
  error.name = "FolderDenied";
  throw error;
}

function updateFolderLocation() {
  el.serverDestination.classList.toggle("hidden", isRemote());
  el.folderLocation.classList.toggle("hidden", !savesInBrowserFolder());
  el.folderLocationText.textContent = baseFolder ? `Onde: ${baseFolder.name}` : "Onde: você escolhe ao salvar";
  el.folderChange.textContent = baseFolder ? "Trocar pasta" : "Escolher pasta";
}

async function createUniqueDirectory(parent, name) {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name} (${attempt})`;
    try {
      await parent.getDirectoryHandle(candidate);
    } catch (error) {
      if (error.name === "NotFoundError") return parent.getDirectoryHandle(candidate, { create: true });
      // TypeMismatchError: já existe um arquivo com esse nome; tenta o próximo.
      if (error.name !== "TypeMismatchError") throw error;
    }
  }
  throw new Error("Não foi possível criar a pasta.");
}

async function fetchGalleryFile(post, item, signal) {
  const response = await fetch(`/api/gallery/${post.key}/${item.index}/file`, { signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Não foi possível baixar uma das imagens.");
  }
  return response;
}

// Vídeo do carrossel: o servidor prepara (como no botão Salvar) e a página busca o arquivo.
async function fetchCarouselVideo(post, item, { signal, isCancelled, onJob, onProgress }) {
  const { id } = await postJson("/api/downloads", { url: post.url, height: 0, item: item.index + 1 });
  onJob(id);
  for (;;) {
    if (isCancelled()) throw new CancelledError();
    const data = await requestJson(`/api/downloads/${id}`);
    onProgress(data.progress);
    if (data.status === "ready") break;
    if (data.status === "error") throw new Error(data.error || "Falha ao preparar o vídeo.");
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return fetch(`/api/downloads/${id}/file`, { signal });
}

const extensionOf = (response, kind) =>
  (fileNameFrom(response, "").match(/\.[a-z0-9]+$/i)?.[0] || (kind === "image" ? ".jpg" : ".mp4")).toLowerCase();

// Grava a pasta pelo próprio navegador, no PC de quem está usando o Clipora. Como no
// servidor: imagens buscadas 4 por vez e gravadas na ordem; uma que falhar é pulada
// (sem buraco na numeração) e entra na contagem de falhas.
async function saveAllInBrowser(folder) {
  let base;
  try {
    base = await writableBaseFolder();
  } catch (error) {
    if (error.name === "AbortError") return; // fechou a janela de escolha sem escolher
    if (error.name === "FolderDenied") {
      el.folderResult.classList.add("hidden");
      showProgress(`Salvando na pasta "${folder}"`, 0, "");
      progressError(error.message);
      return;
    }
    // O navegador não deixou abrir a escolha de pasta: entrega o .zip.
    return saveAllToFolder(folder);
  }

  const post = current;
  const items = selectedItems();
  const token = ++taskToken;
  const controller = new AbortController();
  const isCancelled = () => token !== taskToken;
  let jobId = null;
  let target = null;
  let partial = null;
  el.saveAll.disabled = true;
  el.folderResult.classList.add("hidden");
  showProgress(`Salvando na pasta "${folder}"`, 0, "Criando a pasta...", () => {
    taskToken += 1;
    controller.abort();
    if (jobId) fetch(`/api/downloads/${jobId}`, { method: "DELETE" }).catch(() => {});
    el.saveAll.disabled = false;
  });
  try {
    try {
      target = await createUniqueDirectory(base, folder);
    } catch {
      throw new Error(`Não foi possível criar a pasta "${folder}" em ${base.name}. Tente outro nome ou outra pasta.`);
    }
    const total = items.length;
    let saved = 0;
    let failed = 0;
    let done = 0;
    const report = (detail) => updateProgress((done / total) * 100,
      detail || `Salvando ${Math.min(done + 1, total)} de ${total}${failed ? ` (${failed} com falha)` : ""}`);
    const write = async (source, kind) => {
      partial = `${numbered(folder, saved + 1)}${extensionOf(source.response, kind)}`;
      const file = await target.getFileHandle(partial, { create: true });
      if (source.blob) {
        const writable = await file.createWritable();
        await writable.write(source.blob);
        await writable.close();
      } else {
        await source.response.body.pipeTo(await file.createWritable(), { signal: controller.signal });
      }
      partial = null;
      saved += 1;
    };

    for (let start = 0; start < total; start += 4) {
      if (isCancelled()) return;
      report();
      const chunk = items.slice(start, start + 4);
      const images = await Promise.allSettled(chunk.map(async (item) => {
        if (item.kind !== "image") return null;
        const response = await fetchGalleryFile(post, item, controller.signal);
        return { response, blob: await response.blob() };
      }));
      for (const [position, item] of chunk.entries()) {
        if (isCancelled()) return;
        try {
          if (item.kind === "image") {
            const result = images[position];
            if (result.status === "rejected") throw result.reason;
            await write(result.value, "image");
          } else {
            const number = done + 1;
            const response = await fetchCarouselVideo(post, item, {
              signal: controller.signal,
              isCancelled,
              onJob: (id) => { jobId = id; },
              onProgress: (value) => updateProgress(((done + (Number(value) || 0) / 100) / total) * 100, `Preparando o vídeo ${number} de ${total}`)
            });
            jobId = null;
            await write({ response }, "video");
          }
        } catch (error) {
          if (isCancelled()) throw error;
          // Não deixa um arquivo pela metade na pasta.
          if (partial) await target.removeEntry(partial).catch(() => {});
          partial = null;
          failed += 1;
          console.error(`Falha ao salvar a mídia ${item.index + 1}:`, error);
        }
        done += 1;
        report();
      }
    }

    if (!saved) {
      await base.removeEntry(target.name).catch(() => {});
      throw new Error("Nenhuma imagem pôde ser baixada. O site pode ter bloqueado o acesso ou os links expiraram; busque a página de novo.");
    }
    const where = `${base.name}\\${target.name}`;
    const noun = post.page ? ["imagem salva", "imagens salvas"] : ["arquivo salvo", "arquivos salvos"];
    const failedText = failed
      ? ` ${plural(failed, "não pôde ser baixada", "não puderam ser baixadas")} (o site não entregou).`
      : "";
    progressDone(`${plural(saved, ...noun)} em ${where}`);
    savedFolderJob = null;
    const renamed = target.name !== folder ? ` A pasta "${folder}" já existia, então foi criada "${target.name}".` : "";
    el.folderText.textContent = `${plural(saved, ...noun)} em ${where}, neste computador.${failedText}${renamed}`;
    el.openFolder.classList.add("hidden");
    el.folderResult.classList.remove("hidden");
  } catch (error) {
    if (target && partial) target.removeEntry(partial).catch(() => {});
    if (!isCancelled()) progressError(error.message || "Não foi possível salvar a pasta.");
  } finally {
    if (token === taskToken) el.saveAll.disabled = false;
  }
}

el.folderChange.addEventListener("click", async () => {
  try {
    await chooseBaseFolder();
  } catch (error) {
    if (error.name !== "AbortError") el.folderError.textContent = "O navegador não deixou escolher essa pasta. Tente outra.";
  }
  updateFolderLocation();
  updateFolderHint();
});

// ---------- Salvar tudo em uma pasta ----------

// Mesma regra do servidor: nome que termina em número ganha um hífen antes da numeração.
const numbered = (name, number) => `${name}${/\d$/.test(name) ? "-" : ""}${number}`;

function updateFolderHint() {
  const name = el.folderName.value.trim() || "nome";
  const count = selectedItems().length;
  const examples = Array.from({ length: Math.min(count, 3) }, (_, index) => numbered(name, index + 1)).join(", ");
  const files = `${examples}${count > 3 ? "…" : ""}`;
  if (!isRemote()) {
    const where = destinationPath();
    el.folderHint.textContent = `Será criada em ${where ? `${where}\\${name}` : "a pasta escolhida"}, com os arquivos ${files}`;
  } else if (canPickFolder) {
    const place = baseFolder ? `dentro de ${baseFolder.name}` : "na pasta que você escolher";
    el.folderHint.textContent = `A pasta ${name} será criada ${place}, neste computador, com os arquivos ${files}`;
  } else {
    el.folderHint.textContent = `O navegador vai baixar ${name}.zip com a pasta ${name} e os arquivos ${files}. Extraia o .zip onde quiser.`;
  }
}

async function openFolderDialog() {
  if (!current) return;
  const count = selectedItems().length;
  if (!count) return;
  const unit = current.source === "MangaDex" ? ["página", "páginas"] : ["imagem", "imagens"];
  el.dialogTitle.textContent = current.page
    ? `Baixar ${plural(count, ...unit)} em uma pasta`
    : current.items.length === 1 ? "Salvar em uma pasta"
      : count === current.items.length ? "Salvar tudo em uma pasta"
        : `Salvar ${plural(count, "mídia selecionada", "mídias selecionadas")} em uma pasta`;
  el.folderName.value = current.page ? current.suggestedFolder : "";
  el.folderError.textContent = "";
  syncDestination();
  updateFolderLocation();
  updateFolderHint();
  el.dialog.showModal();
  el.folderName.focus();
  el.folderName.select();
  if (isRemote()) return; // as pastas do servidor não valem para outro PC
  await loadFolders();
  if (el.dialog.open) updateFolderHint();
}

async function saveAllToFolder(folder) {
  const token = ++taskToken;
  let jobId = null;
  const items = selectedItems();
  el.saveAll.disabled = true;
  el.folderResult.classList.add("hidden");
  showProgress(`Salvando na pasta "${folder}"`, 0, "Criando a pasta...", () => {
    taskToken += 1;
    if (jobId) fetch(`/api/downloads/${jobId}`, { method: "DELETE" }).catch(() => {});
    el.saveAll.disabled = false;
  });
  try {
    ({ id: jobId } = await postJson(`/api/gallery/${current.key}/folder`, {
      folder,
      destination,
      // Só as marcadas, na ordem (o servidor numera em sequência).
      indices: items.map((item) => item.index)
    }));
    let data;
    for (;;) {
      if (token !== taskToken) return;
      data = await requestJson(`/api/downloads/${jobId}`);
      if (token !== taskToken) return;
      updateProgress(data.progress, data.phase);
      if (data.status === "saved" || data.status === "ready") break;
      if (data.status === "error") throw new Error(data.error || "Falha ao salvar a pasta.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const failed = data.failedCount
      ? ` ${plural(data.failedCount, "não pôde ser baixada", "não puderam ser baixadas")} (o site não entregou).`
      : "";
    if (data.status === "ready") {
      // Navegador em outro PC sem escolha de pasta: o .zip é baixado por este navegador.
      progressDone(`Baixando ${data.savedFolder}.zip...`);
      triggerDownload(`/api/downloads/${jobId}/file`);
      savedFolderJob = null;
      el.folderText.textContent =
        `${plural(data.savedCount, "arquivo", "arquivos")} em ${data.savedFolder}.zip, na pasta de downloads do navegador. Extraia o .zip para ter a pasta "${data.savedFolder}".${failed}`;
    } else {
      progressDone(data.phase);
      savedFolderJob = jobId;
      const renamed = data.savedFolder !== folder
        ? ` A pasta "${folder}" já existia, então foi criada "${data.savedFolder}".`
        : "";
      const noun = current.page ? ["imagem salva", "imagens salvas"] : ["arquivo salvo", "arquivos salvos"];
      el.folderText.textContent = `${plural(data.savedCount, ...noun)} em ${data.savedPath}.${failed}${renamed}`;
    }
    el.openFolder.classList.toggle("hidden", !savedFolderJob);
    el.folderResult.classList.remove("hidden");
  } catch (error) {
    if (token === taskToken) progressError(error.message);
  } finally {
    if (token === taskToken) el.saveAll.disabled = false;
  }
}

el.saveAll.addEventListener("click", openFolderDialog);
el.folderName.addEventListener("input", () => {
  el.folderError.textContent = "";
  updateFolderHint();
});
el.folderCancel.addEventListener("click", () => el.dialog.close());
el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  // O Windows não aceita pasta terminada em ponto ou espaço.
  const folder = el.folderName.value.trim().replace(/[. ]+$/, "");
  if (!folder) {
    el.folderError.textContent = "Digite o nome da pasta.";
    return;
  }
  if (/[<>:"/\\|?*]/.test(folder)) {
    el.folderError.textContent = "O nome não pode ter estes caracteres: < > : \" / \\ | ? *";
    return;
  }
  el.dialog.close();
  if (savesInBrowserFolder()) saveAllInBrowser(folder);
  else saveAllToFolder(folder);
});
el.openFolder.addEventListener("click", () => {
  if (savedFolderJob) fetch(`/api/downloads/${savedFolderJob}/open-folder`, { method: "POST" }).catch(() => {});
});
