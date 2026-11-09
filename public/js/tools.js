import {
  $, $$, formatBytes, formatClipLength, formatDuration, formatMb, isHttpUrl, levelCeilingMb, minimumTargetMb
} from "./util.js";
import {
  CancelledError, SessionLostError, cancelExport, createUrlSession, deleteSession, downloadExport, fetchVideoInfo,
  requestEditorAssets, startExport, startHeartbeat, uploadSession, waitForSession
} from "./api.js";
import { hideProgress, progressDone, progressError, showProgress, updateProgress } from "./progress.js";
import { CROP_RATIOS, CropSelector } from "./crop.js";
import { RangeSelector } from "./range.js";

export const TOOLS = {
  gif: {
    title: "Converter para GIF",
    description: "Escolha um trecho de até 10 segundos e gere um GIF leve.",
    purpose: "player",
    height: 720,
    panel: "#panel-gif"
  },
  comprimir: {
    title: "Comprimir Vídeo",
    description: "Reduza o tamanho do vídeo escolhendo um nível ou o tamanho final em MB.",
    purpose: "probe",
    height: 1080,
    panel: "#panel-compress"
  },
  recortar: {
    title: "Cortar Proporção",
    description: "Selecione uma área da imagem e, se quiser, apenas um trecho do vídeo.",
    purpose: "player",
    height: 1080,
    panel: "#panel-crop"
  }
};

const el = {
  view: $("#tool-view"),
  title: $("#tool-title"),
  description: $("#tool-description"),
  form: $("#tool-url-form"),
  input: $("#tool-video-url"),
  paste: $("#tool-paste"),
  openLocal: $("#tool-open-local"),
  localInput: $("#tool-local-input"),
  message: $("#tool-message"),
  workspace: $("#tool-workspace"),
  sourceThumb: $("#tool-source-thumb"),
  sourceTitle: $("#tool-source-title"),
  sourceMeta: $("#tool-source-meta"),
  finish: $("#tool-finish"),
  gifVideo: $("#gif-video"),
  gifSize: $("#gif-tool-size"),
  gifFps: $("#gif-tool-fps"),
  gifRun: $("#gif-run"),
  compressCurrent: $("#compress-current"),
  compressDuration: $("#compress-duration"),
  compressResolution: $("#compress-resolution"),
  compressLevels: $("#compress-levels"),
  compressTargetWrap: $("#compress-target-wrap"),
  compressTarget: $("#compress-target"),
  compressEstimate: $("#compress-estimate"),
  compressRun: $("#compress-run"),
  cropVideo: $("#crop-video"),
  cropDimensions: $("#crop-tool-dimensions"),
  cropNote: $("#crop-tool-note"),
  cropScale: $("#crop-tool-scale"),
  cropRatios: $("#crop-tool-ratios"),
  cropPreview: $("#crop-tool-preview"),
  cropRemove: $("#crop-tool-remove"),
  cropRun: $("#crop-run")
};

let current = null;
let session = null;
let token = 0;
let stopHeartbeat = null;
let compressLevel = "medium";
let cropScaleMode = "real";
let openEditorCallback = () => {};

const gifRange = new RangeSelector({ root: $("#gif-range"), video: el.gifVideo, maxLength: 10 });
const cropRange = new RangeSelector({ root: $("#crop-range"), video: el.cropVideo });
const toolCrop = new CropSelector({
  wrap: $("#crop-player-wrap"),
  video: el.cropVideo,
  getSourceSize: () => (session ? { width: session.data.width, height: session.data.height } : null),
  onChange: () => renderCropTool()
});

CROP_RATIOS.forEach((ratio) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.ratio = ratio.key;
  button.textContent = ratio.label;
  button.addEventListener("click", () => {
    toolCrop.setRatio(ratio.key);
    renderCropTool();
  });
  el.cropRatios.appendChild(button);
});

export function setOpenEditorHandler(handler) {
  openEditorCallback = handler;
}

export function currentTool() {
  return current;
}

export function openTool(name) {
  if (!TOOLS[name]) return;
  if (current !== name) {
    resetWorkspace();
    el.input.value = "";
  }
  current = name;
  const tool = TOOLS[name];
  el.title.textContent = tool.title;
  el.description.textContent = tool.description;
  el.view.classList.remove("hidden");
  window.scrollTo({ top: 0 });
  el.input.focus();
}

export function closeTool() {
  resetWorkspace();
  current = null;
  el.view.classList.add("hidden");
}

function setMessage(text) {
  el.message.textContent = text || "";
}

// Descarta o vídeo carregado (e a sessão no servidor, se ainda for desta ferramenta).
function resetWorkspace() {
  token += 1;
  stopHeartbeat?.();
  stopHeartbeat = null;
  if (session) {
    deleteSession(session.id);
    hideProgress();
  }
  session = null;
  for (const video of [el.gifVideo, el.cropVideo]) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  toolCrop.reset();
  el.workspace.classList.add("hidden");
  el.finish.classList.add("hidden");
  $$(".tool-panel").forEach((panel) => panel.classList.add("hidden"));
  setMessage("");
}

function handleSessionLost(error) {
  stopHeartbeat?.();
  stopHeartbeat = null;
  session = null;
  resetWorkspace();
  hideProgress();
  setMessage(error.message);
}

async function loadVideo(loader) {
  if (!current) return;
  resetWorkspace();
  const myToken = token;
  const tool = TOOLS[current];
  let pendingId = null;
  const cancel = () => {
    token += 1;
    if (pendingId) deleteSession(pendingId);
  };
  showProgress("Carregando vídeo", 0, "Preparando...", cancel);
  try {
    const { id, source } = await loader(tool, (value, phase) => {
      if (myToken === token) updateProgress(value, phase);
    }, (idCreated) => { pendingId = idCreated; });
    pendingId = id;
    if (myToken !== token) throw new CancelledError();
    const data = await waitForSession(id, {
      until: ["editor_ready"],
      isCancelled: () => myToken !== token,
      onProgress: (info) => updateProgress(info.progress, info.phase)
    });
    hideProgress();
    showWorkspace(id, data, source);
  } catch (error) {
    if (error instanceof CancelledError || myToken !== token) {
      if (pendingId) deleteSession(pendingId);
      return;
    }
    if (pendingId) deleteSession(pendingId);
    progressError(error.message);
    setMessage(error.message);
  }
}

export function loadUrl(url) {
  if (!isHttpUrl(url)) {
    setMessage("Cole um link válido (começando com http:// ou https://).");
    return;
  }
  loadVideo(async (tool, onProgress, onCreated) => {
    onProgress(0, "Buscando informações do vídeo...");
    const info = await fetchVideoInfo(url);
    const { id } = await createUrlSession(url, tool.height, tool.purpose);
    onCreated(id);
    return { id, source: { title: info.title, thumbnail: info.thumbnail } };
  });
}

export function loadFile(file) {
  if (!file) return;
  loadVideo(async (tool, onProgress, onCreated) => {
    onProgress(0, "Enviando vídeo...");
    const { id } = await uploadSession(file, tool.purpose, (ratio) => onProgress(ratio * 85, "Enviando vídeo..."));
    onCreated(id);
    return { id, source: { title: file.name.replace(/\.[^.]+$/, ""), thumbnail: null } };
  });
}

function showWorkspace(id, data, source) {
  session = { id, data };
  stopHeartbeat = startHeartbeat(id, handleSessionLost);
  el.sourceThumb.classList.toggle("hidden", !source.thumbnail);
  if (source.thumbnail) el.sourceThumb.src = source.thumbnail;
  el.sourceTitle.textContent = data.title || source.title || "Vídeo";
  el.sourceMeta.textContent = `${data.width} × ${data.height} · ${formatDuration(data.duration)} · ${formatBytes(data.fileSize)}`;
  el.workspace.classList.remove("hidden");
  el.finish.classList.add("hidden");
  setMessage("");

  const panel = $(TOOLS[current].panel);
  panel.classList.remove("hidden");
  const media = `/api/editor-sessions/${id}/media`;
  if (current === "gif") {
    el.gifVideo.src = media;
    gifRange.setDuration(data.duration);
    gifRange.onChange?.(gifRange.value());
  } else if (current === "comprimir") {
    el.compressCurrent.textContent = formatBytes(data.fileSize);
    el.compressDuration.textContent = formatDuration(data.duration);
    el.compressResolution.textContent = `${data.width} × ${data.height}`;
    renderCompress();
  } else if (current === "recortar") {
    el.cropVideo.src = media;
    cropScaleMode = "real";
    toolCrop.reset();
    toolCrop.setActive(true);
    cropRange.setDuration(data.duration);
    cropRange.onChange?.(cropRange.value());
    renderCropTool();
  }
  setRunButtonsDisabled(false);
}

function setRunButtonsDisabled(disabled) {
  el.gifRun.disabled = disabled;
  el.cropRun.disabled = disabled;
  if (disabled) el.compressRun.disabled = true;
  else renderCompress();
}

// ---------- Comprimir ----------

function renderCompress() {
  $$("button", el.compressLevels).forEach((button) => button.classList.toggle("active", button.dataset.level === compressLevel));
  el.compressTargetWrap.classList.toggle("hidden", compressLevel !== "target");
  if (!session) return;
  const { data } = session;
  let text;
  let blocked = false;
  if (compressLevel === "target") {
    const target = Number(el.compressTarget.value);
    const minimum = minimumTargetMb(data.duration, data.hasAudio);
    const sourceMb = data.fileSize / 1024 / 1024;
    if (!(target > 0)) {
      text = "Informe o tamanho desejado em MB.";
      blocked = true;
    } else if (target < minimum) {
      text = `Para essa duração, o mínimo é aprox. ${formatMb(minimum)}.`;
      blocked = true;
    } else if (target >= sourceMb) {
      text = `O vídeo já tem ${formatMb(sourceMb)}; ele sai com até esse tamanho, mantendo a qualidade da fonte.`;
    } else {
      text = `Resultado: até ${formatMb(target)} (hoje: ${formatMb(sourceMb)}).`;
    }
  } else {
    const ceiling = levelCeilingMb(compressLevel, data);
    text = `Resultado estimado: até ${formatMb(ceiling)} (hoje: ${formatBytes(data.fileSize)}).`;
  }
  el.compressEstimate.textContent = text;
  el.compressEstimate.classList.toggle("warning", blocked);
  el.compressRun.disabled = blocked;
}

// ---------- Cortar proporção ----------

function renderCropTool() {
  if (!session) return;
  const info = toolCrop.describe(cropScaleMode);
  const hasCrop = Boolean(toolCrop.crop);
  $$("button", el.cropRatios).forEach((button) => button.classList.toggle("active", button.dataset.ratio === toolCrop.ratioKey));
  $$("button", el.cropScale).forEach((button) => button.classList.toggle("active", button.dataset.scale === cropScaleMode));
  el.cropPreview.disabled = !hasCrop;
  el.cropRemove.disabled = !hasCrop;
  el.cropPreview.textContent = toolCrop.preview ? "Ajustar área" : "Visualizar";
  const zoomText = `${info.zoom.toFixed(1).replace(".", ",")}×`;
  el.cropDimensions.textContent = hasCrop
    ? `${info.cropWidth} × ${info.cropHeight} → ${info.outWidth} × ${info.outHeight}`
    : `Tela inteira · ${session.data.width} × ${session.data.height}`;
  const blurry = hasCrop && cropScaleMode === "fit" && info.zoom >= 1.5;
  el.cropNote.textContent = !hasCrop
    ? "Arraste sobre o vídeo para selecionar a área"
    : cropScaleMode === "real"
      ? "Tamanho real: a área sai com os pixels originais, sem ampliar"
      : blurry
        ? `Ampliação de ${zoomText} — o resultado pode perder nitidez`
        : `Ampliação de ${zoomText}`;
  el.cropNote.classList.toggle("warning", blurry);
}

// ---------- Exportação ----------

async function runExport(payload, title) {
  if (!session) return;
  const { id } = session;
  const myToken = ++token;
  setRunButtonsDisabled(true);
  el.finish.classList.add("hidden");
  const cancel = () => {
    token += 1;
    cancelExport(id);
    setRunButtonsDisabled(false);
  };
  showProgress(title, 0, "Preparando...", cancel);
  try {
    // Depois de um download anterior, o servidor volta a ficar pronto em instantes.
    await waitForSession(id, { until: ["editor_ready", "export_error"], isCancelled: () => myToken !== token, interval: 300 });
    await startExport(id, payload);
    await waitForSession(id, {
      until: ["export_ready"],
      isCancelled: () => myToken !== token,
      onProgress: (data) => updateProgress(data.progress, data.phase)
    });
    progressDone("Arquivo pronto. Iniciando download...");
    downloadExport(id, { keep: true });
    el.finish.classList.remove("hidden");
    setRunButtonsDisabled(false);
  } catch (error) {
    if (error instanceof CancelledError) return;
    if (error instanceof SessionLostError) {
      handleSessionLost(error);
      return;
    }
    if (myToken !== token) return;
    progressError(error.message);
    setRunButtonsDisabled(false);
  }
}

el.gifRun.addEventListener("click", () => {
  const { start, end } = gifRange.value();
  gifRange.stopLoop();
  runExport({
    segments: [{ start, end }],
    output: { format: "gif", gifSize: Number(el.gifSize.value), gifFps: Number(el.gifFps.value) }
  }, "Gerando seu GIF");
});

el.compressRun.addEventListener("click", () => {
  if (!session) return;
  const output = compressLevel === "target"
    ? { format: "mp4", compression: "target", targetMb: Number(el.compressTarget.value) }
    : { format: "mp4", compression: compressLevel };
  runExport({ segments: [{ start: 0, end: session.data.duration }], output }, "Comprimindo seu vídeo");
});

el.cropRun.addEventListener("click", () => {
  const { start, end } = cropRange.value();
  cropRange.stopLoop();
  toolCrop.togglePreview(false);
  runExport({
    segments: [{ start, end }],
    crop: toolCrop.crop,
    scaleMode: cropScaleMode,
    output: { format: "mp4", compression: "original" }
  }, "Exportando seu vídeo");
});

// ---------- Ao terminar ----------

$("#finish-new").addEventListener("click", () => {
  resetWorkspace();
  el.input.value = "";
  el.input.focus();
});

$("#finish-again").addEventListener("click", () => {
  el.finish.classList.add("hidden");
  if (current === "gif") el.gifVideo.currentTime = gifRange.value().start;
});

$("#finish-editor").addEventListener("click", async () => {
  if (!session) return;
  const { id } = session;
  const myToken = ++token;
  showProgress("Abrindo o editor completo", 0, "Preparando miniaturas da timeline...", () => { token += 1; });
  try {
    await waitForSession(id, { until: ["editor_ready"], isCancelled: () => myToken !== token, interval: 300 });
    await requestEditorAssets(id);
    const data = await waitForSession(id, {
      until: ["editor_ready"],
      isCancelled: () => myToken !== token,
      onProgress: (info) => updateProgress(info.progress, info.phase)
    });
    hideProgress();
    // A sessão passa a ser do editor: a ferramenta não deve apagá-la ao fechar.
    stopHeartbeat?.();
    stopHeartbeat = null;
    session = null;
    openEditorCallback(id, data);
  } catch (error) {
    if (error instanceof CancelledError) return;
    if (error instanceof SessionLostError) {
      handleSessionLost(error);
      return;
    }
    progressError(error.message);
  }
});

// ---------- Entrada do vídeo ----------

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadUrl(el.input.value.trim());
});

el.paste.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    el.input.value = text;
    if (isHttpUrl(text)) loadUrl(text);
  } catch {
    setMessage("O navegador bloqueou a área de transferência. Use Ctrl+V no campo.");
    el.input.focus();
  }
});

el.openLocal.addEventListener("click", () => el.localInput.click());
el.localInput.addEventListener("change", () => {
  loadFile(el.localInput.files?.[0]);
  el.localInput.value = "";
});

$$("button", el.compressLevels).forEach((button) => button.addEventListener("click", () => {
  compressLevel = button.dataset.level;
  renderCompress();
}));
el.compressTarget.addEventListener("input", renderCompress);

el.cropPreview.addEventListener("click", () => {
  toolCrop.togglePreview();
  renderCropTool();
});
el.cropRemove.addEventListener("click", () => {
  toolCrop.setCrop(null);
  renderCropTool();
});
$$("button", el.cropScale).forEach((button) => button.addEventListener("click", () => {
  cropScaleMode = button.dataset.scale;
  renderCropTool();
}));

window.addEventListener("keydown", (event) => {
  if (current !== "recortar" || event.key !== "Escape" || !toolCrop.preview) return;
  toolCrop.togglePreview(false);
  renderCropTool();
});

// Duração do trecho exibida no botão, para o usuário ver o que vai exportar.
gifRange.onChange = ({ start, end }) => {
  el.gifRun.querySelector("span").textContent = `Gerar GIF (${formatClipLength(end - start)})`;
};
cropRange.onChange = ({ start, end }) => {
  const whole = session && start <= 0.05 && Math.abs(end - session.data.duration) <= 0.05;
  el.cropRun.querySelector("span").textContent = whole ? "Exportar vídeo" : `Exportar trecho (${formatClipLength(end - start)})`;
};
