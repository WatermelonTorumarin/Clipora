import {
  $, $$, clamp, formatBytes, formatClipLength, formatDuration, formatMb, formatPrecise, minimumTargetMb
} from "./util.js";
import {
  CancelledError, SessionLostError, cancelExport, deleteSession, downloadExport, startExport, startHeartbeat, waitForSession
} from "./api.js";
import { hideProgress, progressDone, progressError, showProgress, updateProgress } from "./progress.js";
import { CROP_RATIOS, CropSelector } from "./crop.js";

const GIF_MAX_SECONDS = 10;
const MIN_SEGMENT = 0.1;
const SNAP_PIXELS = 8;
const EXPORT_SETTINGS_KEY = "clipora-export-settings";
const COMPRESSION_HINTS = {
  original: "Qualidade máxima, sem compressão extra.",
  light: "Arquivo menor, com perda quase imperceptível.",
  medium: "Bem menor; limita a resolução a 1080p.",
  strong: "O menor arquivo; limita a resolução a 720p."
};

const el = {
  editor: $("#editor"),
  video: $("#editor-video"),
  playerWrap: $("#player-wrap"),
  title: $("#editor-title"),
  meta: $("#editor-meta"),
  currentTime: $("#editor-current-time"),
  totalTime: $("#editor-total-time"),
  timelineScroll: $("#timeline-scroll"),
  timelineContent: $("#timeline-content"),
  thumbnails: $("#timeline-thumbnails"),
  waveform: $("#timeline-waveform"),
  segments: $("#timeline-segments"),
  labels: $("#timeline-labels"),
  playhead: $("#timeline-playhead"),
  zoom: $("#timeline-zoom"),
  undo: $("#undo-edit"),
  redo: $("#redo-edit"),
  split: $("#split-edit"),
  remove: $("#delete-segments"),
  markIn: $("#mark-in"),
  markOut: $("#mark-out"),
  keepSelection: $("#keep-selection"),
  inValue: $("#in-value"),
  outValue: $("#out-value"),
  selectionLabel: $("#selection-duration-label"),
  selectionDuration: $("#selection-duration"),
  segmentInfo: $("#segment-info"),
  segmentInfoTitle: $("#segment-info-title"),
  segmentInfoRange: $("#segment-info-range"),
  segmentInfoLength: $("#segment-info-length"),
  segmentCount: $("#editor-segment-count"),
  outputDuration: $("#editor-output-duration"),
  exportButton: $("#export-editor"),
  exportHint: $("#export-hint"),
  formatButtons: $$("[data-format]"),
  mp4Options: $("#mp4-options"),
  gifOptions: $("#gif-options"),
  compression: $("#compression-mode"),
  targetWrap: $("#target-size-wrap"),
  target: $("#target-size"),
  gifSize: $("#gif-size"),
  gifFps: $("#gif-fps"),
  cropButton: $("#crop-edit"),
  cropBar: $("#editor-crop-bar"),
  cropDimensions: $("#editor-crop-dimensions"),
  cropNote: $("#editor-crop-note"),
  cropScale: $("#editor-crop-scale"),
  cropRatios: $("#editor-crop-ratios"),
  cropPreview: $("#editor-crop-preview"),
  cropRemove: $("#editor-crop-remove"),
  cropSummary: $("#crop-summary")
};
el.exportLabel = el.exportButton.querySelector("span");

const exportSettings = loadExportSettings();
let state = null;
let sessionId = null;
let stopHeartbeat = null;
let exportToken = 0;
let timelineDrag = null;
let onSessionLostCallback = () => {};

const crop = new CropSelector({
  wrap: el.playerWrap,
  video: el.video,
  getSourceSize: () => (state ? { width: state.width, height: state.height } : null),
  onChange: () => {
    if (!state) return;
    state.crop = crop.crop ? { ...crop.crop } : null;
    renderCropUi();
  },
  onCommit: (before) => {
    if (!state) return;
    commitChange({ ...snapshot(), crop: before ? { ...before } : null });
    renderEditorState();
  }
});

CROP_RATIOS.forEach((ratio) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.ratio = ratio.key;
  button.textContent = ratio.label;
  button.addEventListener("click", () => {
    crop.setRatio(ratio.key);
    renderCropUi();
  });
  el.cropRatios.appendChild(button);
});

function loadExportSettings() {
  const defaults = { format: "mp4", compression: "original", targetMb: 10, gifSize: 480, gifFps: 15 };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(EXPORT_SETTINGS_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function saveExportSettings() {
  try {
    localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(exportSettings));
  } catch {
    // Sem armazenamento local as opções valem apenas para esta aba.
  }
}

export function setSessionLostHandler(handler) {
  onSessionLostCallback = handler;
}

export function isEditorOpen() {
  return Boolean(state);
}

export function openEditor(id, data) {
  sessionId = id;
  state = {
    duration: data.duration,
    width: data.width,
    height: data.height,
    hasAudio: data.hasAudio,
    crop: null,
    cropMode: false,
    scaleMode: "real",
    zoom: 1,
    thumbnails: data.thumbnails || [],
    waveform: data.waveform,
    segments: [{ id: 1, start: 0, end: data.duration }],
    nextSegmentId: 2,
    selected: new Set(),
    inMark: 0,
    outMark: null,
    history: [],
    future: [],
    lastSelectedId: null
  };
  crop.reset();
  el.zoom.value = "1";
  el.timelineContent.style.width = "100%";
  el.title.textContent = data.title || "Editor de cortes";
  el.meta.textContent = `${data.width} × ${data.height} · ${formatDuration(data.duration)} · ${formatBytes(data.fileSize)}`;
  el.video.src = `/api/editor-sessions/${id}/media`;
  el.totalTime.textContent = formatPrecise(data.duration);
  el.editor.classList.remove("hidden");
  document.body.classList.add("editing");
  syncExportControls();
  renderThumbnails();
  renderEditorState();
  stopHeartbeat?.();
  stopHeartbeat = startHeartbeat(id, (error) => handleSessionLost(error));
  el.editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function destroyUi() {
  stopHeartbeat?.();
  stopHeartbeat = null;
  timelineDrag = null;
  crop.reset();
  el.cropBar.classList.add("hidden");
  el.cropButton.classList.remove("active");
  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();
  el.editor.classList.add("hidden");
  document.body.classList.remove("editing");
  state = null;
  sessionId = null;
}

export async function closeEditor({ removeRemote = true } = {}) {
  const id = sessionId;
  exportToken += 1;
  hideProgress();
  destroyUi();
  if (removeRemote && id) await deleteSession(id);
}

function handleSessionLost(error) {
  exportToken += 1;
  hideProgress();
  destroyUi();
  onSessionLostCallback(error.message);
}

function snapshot() {
  return {
    segments: state.segments.map((segment) => ({ ...segment })),
    inMark: state.inMark,
    outMark: state.outMark,
    crop: state.crop ? { ...state.crop } : null
  };
}

function restore(saved) {
  state.segments = saved.segments.map((segment) => ({ ...segment }));
  state.inMark = saved.inMark;
  state.outMark = saved.outMark;
  state.crop = saved.crop ? { ...saved.crop } : null;
  state.selected.clear();
  crop.setCrop(state.crop);
  renderEditorState();
}

function commitChange(saved = snapshot()) {
  state.history.push(saved);
  if (state.history.length > 100) state.history.shift();
  state.future = [];
}

function undo() {
  if (!state?.history.length) return;
  state.future.push(snapshot());
  restore(state.history.pop());
}

function redo() {
  if (!state?.future.length) return;
  state.history.push(snapshot());
  restore(state.future.pop());
}

function outputLength() {
  return state.segments.reduce((total, segment) => total + segment.end - segment.start, 0);
}

function isGif() {
  return exportSettings.format === "gif";
}

function renderThumbnails() {
  const { duration, thumbnails, waveform } = state;
  el.thumbnails.replaceChildren();
  thumbnails.forEach((thumbnail, index) => {
    const image = document.createElement("img");
    image.src = thumbnail.url;
    image.alt = "";
    image.draggable = false;
    image.style.left = `${(thumbnail.time / duration) * 100}%`;
    image.style.width = `${Math.max(0.8, 110 / Math.max(1, thumbnails.length))}%`;
    image.style.zIndex = String(index);
    el.thumbnails.appendChild(image);
  });
  el.waveform.classList.toggle("hidden", !waveform);
  if (waveform) el.waveform.src = waveform;
}

function renderSegments() {
  const { duration } = state;
  el.segments.replaceChildren();
  el.labels.replaceChildren();
  state.segments.forEach((segment, index) => {
    const block = document.createElement("div");
    block.className = `timeline-segment${state.selected.has(segment.id) ? " selected" : ""}`;
    block.style.left = `${(segment.start / duration) * 100}%`;
    block.style.width = `${((segment.end - segment.start) / duration) * 100}%`;
    block.dataset.segmentId = String(segment.id);
    block.innerHTML = `<i class="segment-edge" data-edge="start"></i><span>${index + 1}</span><i class="segment-edge" data-edge="end"></i>`;
    block.addEventListener("click", (event) => {
      if (event.target.classList.contains("segment-edge")) return;
      selectSegment(event, segment.id);
    });
    el.segments.appendChild(block);

    const label = document.createElement("span");
    label.className = "timeline-label";
    label.style.left = `${((segment.start + segment.end) / 2 / duration) * 100}%`;
    label.textContent = formatClipLength(segment.end - segment.start);
    label.title = `Trecho ${index + 1}: ${formatPrecise(segment.start)} → ${formatPrecise(segment.end)}`;
    el.labels.appendChild(label);
  });
  updatePlayhead();
}

function renderSelectionInfo() {
  el.inValue.textContent = formatPrecise(state.inMark);
  el.outValue.textContent = state.outMark == null ? "--:--.---" : formatPrecise(state.outMark);
  const live = state.outMark == null;
  const marked = live
    ? Math.max(0, (el.video.currentTime || 0) - state.inMark)
    : Math.max(0, state.outMark - state.inMark);
  el.selectionLabel.textContent = live ? "Duração marcada (ao vivo)" : "Duração marcada";
  el.selectionDuration.textContent = formatClipLength(marked);
  el.selectionDuration.classList.toggle("warning", isGif() && marked > GIF_MAX_SECONDS + 0.05);
  el.keepSelection.disabled = live || marked < 0.04;
}

function renderSegmentInfo() {
  const selected = state.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => state.selected.has(segment.id));
  el.segmentInfo.classList.toggle("hidden", selected.length !== 1);
  if (selected.length !== 1) return;
  const { segment, index } = selected[0];
  el.segmentInfoTitle.textContent = `Trecho ${index + 1}`;
  el.segmentInfoRange.textContent = `${formatPrecise(segment.start)} → ${formatPrecise(segment.end)}`;
  el.segmentInfoLength.textContent = formatClipLength(segment.end - segment.start);
}

function renderEditorState() {
  if (!state) return;
  const length = outputLength();
  el.undo.disabled = state.history.length === 0;
  el.redo.disabled = state.future.length === 0;
  el.remove.disabled = state.selected.size === 0;
  el.segmentCount.textContent = `${state.segments.length} ${state.segments.length === 1 ? "trecho" : "trechos"}`;
  el.outputDuration.textContent = formatClipLength(length);
  el.outputDuration.classList.toggle("warning", isGif() && length > GIF_MAX_SECONDS + 0.05);
  renderSelectionInfo();
  renderSegmentInfo();
  renderSegments();
  renderCropUi();
  renderExportOptions(length);
}

function updatePlayhead() {
  if (!state) return;
  const time = clamp(el.video.currentTime || 0, 0, state.duration);
  el.playhead.style.left = `${(time / state.duration) * 100}%`;
  el.currentTime.textContent = formatPrecise(time);
}

function selectSegment(event, id) {
  const segments = state.segments;
  const index = segments.findIndex((segment) => segment.id === id);
  if (event.shiftKey && state.lastSelectedId != null) {
    const previousIndex = segments.findIndex((segment) => segment.id === state.lastSelectedId);
    state.selected.clear();
    const [first, last] = [previousIndex, index].sort((a, b) => a - b);
    segments.slice(first, last + 1).forEach((segment) => state.selected.add(segment.id));
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else {
    state.selected.clear();
    state.selected.add(id);
  }
  state.lastSelectedId = id;
  renderEditorState();
}

function splitAtPlayhead() {
  const time = el.video.currentTime;
  const index = state.segments.findIndex((segment) => time > segment.start + 0.04 && time < segment.end - 0.04);
  if (index < 0) return;
  commitChange();
  const segment = state.segments[index];
  const left = { id: segment.id, start: segment.start, end: time };
  const right = { id: state.nextSegmentId++, start: time, end: segment.end };
  state.segments.splice(index, 1, left, right);
  state.selected = new Set([right.id]);
  state.lastSelectedId = right.id;
  renderEditorState();
}

function deleteSelectedSegments() {
  if (!state.selected.size) return;
  commitChange();
  state.segments = state.segments.filter((segment) => !state.selected.has(segment.id));
  state.selected.clear();
  state.lastSelectedId = null;
  renderEditorState();
}

function markIn() {
  state.inMark = el.video.currentTime;
  if (state.outMark != null && state.outMark <= state.inMark) state.outMark = null;
  renderEditorState();
}

function markOut() {
  if (el.video.currentTime <= state.inMark + 0.04) return;
  state.outMark = el.video.currentTime;
  renderEditorState();
}

function keepMarkedSelection() {
  if (state.outMark == null || state.outMark <= state.inMark + 0.04) return;
  commitChange();
  const id = state.nextSegmentId++;
  state.segments = [{ id, start: state.inMark, end: state.outMark }];
  state.selected = new Set([id]);
  state.lastSelectedId = id;
  renderEditorState();
}

function setZoom(value) {
  const oldWidth = el.timelineContent.scrollWidth || el.timelineScroll.clientWidth;
  const cursorRatio = (el.video.currentTime || 0) / state.duration;
  state.zoom = clamp(Number(value), 1, 8);
  el.zoom.value = String(state.zoom);
  el.timelineContent.style.width = `${state.zoom * 100}%`;
  const newWidth = el.timelineContent.scrollWidth;
  const oldAnchor = cursorRatio * oldWidth - el.timelineScroll.scrollLeft;
  el.timelineScroll.scrollLeft = Math.max(0, cursorRatio * newWidth - oldAnchor);
}

function togglePlayback() {
  if (el.video.paused) el.video.play().catch(() => {});
  else el.video.pause();
}

// ---------- Recorte ----------

function toggleCropMode(force) {
  const enable = force ?? !state.cropMode;
  state.cropMode = enable;
  crop.setActive(enable);
  renderCropUi();
}

function renderCropUi() {
  if (!state) return;
  const info = crop.describe(state.scaleMode);
  const hasCrop = Boolean(state.crop);
  el.cropButton.classList.toggle("active", state.cropMode);
  el.cropBar.classList.toggle("hidden", !state.cropMode);
  $$("button", el.cropRatios).forEach((button) => button.classList.toggle("active", button.dataset.ratio === crop.ratioKey));
  $$("button", el.cropScale).forEach((button) => button.classList.toggle("active", button.dataset.scale === state.scaleMode));
  el.cropPreview.disabled = !hasCrop;
  el.cropRemove.disabled = !hasCrop;
  el.cropPreview.textContent = crop.preview ? "Ajustar área" : "Visualizar";

  const zoomText = `${info.zoom.toFixed(1).replace(".", ",")}×`;
  el.cropDimensions.textContent = hasCrop
    ? `${info.cropWidth} × ${info.cropHeight} → ${info.outWidth} × ${info.outHeight}`
    : `Tela inteira · ${state.width} × ${state.height}`;
  const blurry = hasCrop && state.scaleMode === "fit" && info.zoom >= 1.5;
  el.cropNote.textContent = !hasCrop
    ? "Arraste sobre o vídeo para selecionar a área"
    : state.scaleMode === "real"
      ? "Tamanho real: a área sai com os pixels originais, sem ampliar"
      : blurry
        ? `Ampliação de ${zoomText} — o resultado pode perder nitidez`
        : `Ampliação de ${zoomText}`;
  el.cropNote.classList.toggle("warning", blurry);
  el.cropSummary.textContent = hasCrop
    ? `${info.outWidth} × ${info.outHeight}${state.scaleMode === "fit" ? ` (${zoomText})` : ""}`
    : "Tela inteira";
}

function removeCrop() {
  if (!state.crop) return;
  commitChange();
  state.crop = null;
  crop.setCrop(null);
  renderEditorState();
}

// ---------- Exportação ----------

function syncExportControls() {
  el.compression.value = exportSettings.compression;
  el.target.value = String(exportSettings.targetMb);
  el.gifSize.value = String(exportSettings.gifSize);
  el.gifFps.value = String(exportSettings.gifFps);
}

function renderExportOptions(length) {
  const gif = isGif();
  el.formatButtons.forEach((button) => {
    const active = button.dataset.format === exportSettings.format;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  el.mp4Options.classList.toggle("hidden", gif);
  el.gifOptions.classList.toggle("hidden", !gif);
  el.targetWrap.classList.toggle("hidden", exportSettings.compression !== "target");
  el.exportLabel.textContent = gif ? "Exportar GIF" : "Exportar clipe";

  let hint;
  let blocked = false;
  if (gif) {
    if (length > GIF_MAX_SECONDS + 0.05) {
      hint = `GIF disponível para clipes de até 10 s (atual: ${formatClipLength(length)}).`;
      blocked = true;
    } else {
      hint = "GIF sem áudio; o tamanho vale para o lado maior da imagem.";
    }
  } else if (exportSettings.compression === "target") {
    const minimumMb = minimumTargetMb(length, state.hasAudio);
    if (!(exportSettings.targetMb > 0)) {
      hint = "Informe o tamanho desejado em MB.";
      blocked = true;
    } else if (exportSettings.targetMb < minimumMb) {
      hint = `Para essa duração, o mínimo é aprox. ${formatMb(minimumMb)}.`;
      blocked = true;
    } else {
      hint = `A resolução será ajustada para caber em ${formatMb(exportSettings.targetMb)}.`;
    }
  } else {
    hint = COMPRESSION_HINTS[exportSettings.compression];
  }
  el.exportHint.textContent = hint;
  el.exportHint.classList.toggle("warning", blocked);
  el.exportButton.disabled = blocked || state.segments.length === 0;
}

async function exportClip() {
  if (!state?.segments.length || !sessionId) return;
  const token = ++exportToken;
  const id = sessionId;
  const gif = isGif();
  el.exportButton.disabled = true;
  const cancel = () => {
    exportToken += 1;
    cancelExport(id);
    if (state) renderEditorState();
  };
  showProgress(gif ? "Gerando seu GIF" : "Exportando seu clipe", 0, "Preparando os cortes...", cancel);
  try {
    await startExport(id, {
      segments: state.segments.map(({ start, end }) => ({ start, end })),
      crop: state.crop,
      scaleMode: state.scaleMode,
      output: { ...exportSettings }
    });
    await waitForSession(id, {
      until: ["export_ready"],
      isCancelled: () => token !== exportToken,
      onProgress: (data) => updateProgress(data.progress, data.phase)
    });
    progressDone(gif ? "GIF pronto. Iniciando download..." : "Clipe pronto. Iniciando download...");
    downloadExport(id);
    destroyUi();
  } catch (error) {
    if (error instanceof CancelledError) return;
    if (error instanceof SessionLostError) {
      handleSessionLost(error);
      return;
    }
    if (token !== exportToken) return;
    progressError(error.message);
    if (state) renderEditorState();
  }
}

// ---------- Timeline: cursor e bordas dos trechos ----------

function timeFromPointer(event) {
  const rect = el.timelineContent.getBoundingClientRect();
  return clamp((event.clientX - rect.left) / rect.width, 0, 1) * state.duration;
}

function seekTo(time) {
  el.video.currentTime = clamp(time, 0, state.duration);
  updatePlayhead();
}

el.timelineContent.addEventListener("pointerdown", (event) => {
  if (!state || event.button !== 0) return;
  const edge = event.target.closest(".segment-edge");
  if (edge) {
    const id = Number(edge.parentElement.dataset.segmentId);
    el.video.pause();
    timelineDrag = {
      mode: "edge",
      edge: edge.dataset.edge,
      id,
      pointerId: event.pointerId,
      saved: snapshot(),
      playheadTime: el.video.currentTime || 0,
      changed: false
    };
    el.timelineContent.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.target.closest(".timeline-segment")) {
    seekTo(timeFromPointer(event));
    return;
  }
  timelineDrag = { mode: "playhead", pointerId: event.pointerId };
  el.timelineContent.setPointerCapture(event.pointerId);
  seekTo(timeFromPointer(event));
});

el.timelineContent.addEventListener("pointermove", (event) => {
  if (!state || !timelineDrag || event.pointerId !== timelineDrag.pointerId) return;
  if (timelineDrag.mode === "playhead") {
    seekTo(timeFromPointer(event));
    return;
  }
  dragSegmentEdge(event);
});

function finishTimelineDrag(event) {
  const drag = timelineDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  timelineDrag = null;
  if (drag.mode === "edge" && drag.changed) {
    commitChange(drag.saved);
    state.selected = new Set([drag.id]);
    state.lastSelectedId = drag.id;
    renderEditorState();
  }
}
el.timelineContent.addEventListener("pointerup", finishTimelineDrag);
el.timelineContent.addEventListener("pointercancel", finishTimelineDrag);

// Arrasta o início ou o fim de um trecho: para no vizinho, pode avançar sobre
// partes excluídas e "gruda" no cursor e nas bordas próximas (Alt desliga).
function dragSegmentEdge(event) {
  const drag = timelineDrag;
  const index = state.segments.findIndex((segment) => segment.id === drag.id);
  if (index < 0) return;
  const segment = state.segments[index];
  const previousEnd = index > 0 ? state.segments[index - 1].end : 0;
  const nextStart = index < state.segments.length - 1 ? state.segments[index + 1].start : state.duration;
  let time = timeFromPointer(event);

  if (!event.altKey) {
    const width = el.timelineContent.getBoundingClientRect().width;
    const threshold = (SNAP_PIXELS / width) * state.duration;
    const candidates = [drag.playheadTime, previousEnd, nextStart, 0, state.duration];
    const nearest = candidates.reduce((best, candidate) =>
      Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best, Infinity);
    if (Math.abs(nearest - time) <= threshold) time = nearest;
  }

  if (drag.edge === "start") {
    segment.start = clamp(time, previousEnd, segment.end - MIN_SEGMENT);
    seekTo(segment.start);
  } else {
    segment.end = clamp(time, segment.start + MIN_SEGMENT, nextStart);
    seekTo(segment.end);
  }
  drag.changed = true;
  renderSegments();
  const length = outputLength();
  el.outputDuration.textContent = formatClipLength(length);
  el.outputDuration.classList.toggle("warning", isGif() && length > GIF_MAX_SECONDS + 0.05);
  renderExportOptions(length);
}

// ---------- Eventos ----------

$("#close-editor").addEventListener("click", () => closeEditor());
el.split.addEventListener("click", () => state && splitAtPlayhead());
el.remove.addEventListener("click", () => state && deleteSelectedSegments());
el.markIn.addEventListener("click", () => state && markIn());
el.markOut.addEventListener("click", () => state && markOut());
el.keepSelection.addEventListener("click", () => state && keepMarkedSelection());
el.undo.addEventListener("click", undo);
el.redo.addEventListener("click", redo);
el.exportButton.addEventListener("click", exportClip);
el.zoom.addEventListener("input", () => state && setZoom(el.zoom.value));
$("#zoom-out").addEventListener("click", () => state && setZoom(state.zoom - 0.5));
$("#zoom-in").addEventListener("click", () => state && setZoom(state.zoom + 0.5));

el.cropButton.addEventListener("click", () => state && toggleCropMode());
$("#editor-crop-done").addEventListener("click", () => state && toggleCropMode(false));
el.cropRemove.addEventListener("click", () => state && removeCrop());
el.cropPreview.addEventListener("click", () => {
  if (!state) return;
  crop.togglePreview();
  renderCropUi();
});
$$("button", el.cropScale).forEach((button) => button.addEventListener("click", () => {
  if (!state) return;
  state.scaleMode = button.dataset.scale;
  renderCropUi();
}));

el.formatButtons.forEach((button) => button.addEventListener("click", () => {
  exportSettings.format = button.dataset.format;
  saveExportSettings();
  renderEditorState();
}));
el.compression.addEventListener("change", () => {
  exportSettings.compression = el.compression.value;
  saveExportSettings();
  renderEditorState();
});
el.target.addEventListener("input", () => {
  exportSettings.targetMb = Number(el.target.value);
  saveExportSettings();
  renderEditorState();
});
el.gifSize.addEventListener("change", () => {
  exportSettings.gifSize = Number(el.gifSize.value);
  saveExportSettings();
});
el.gifFps.addEventListener("change", () => {
  exportSettings.gifFps = Number(el.gifFps.value);
  saveExportSettings();
});

el.video.addEventListener("timeupdate", () => {
  if (!state) return;
  const time = el.video.currentTime;
  const segments = state.segments;
  const containingIndex = segments.findIndex((segment) => time >= segment.start - 0.03 && time < segment.end - 0.03);
  if (!el.video.paused && !crop.preview) {
    if (containingIndex < 0) {
      const next = segments.find((segment) => segment.start > time);
      if (next) el.video.currentTime = next.start;
      else el.video.pause();
    } else if (time >= segments[containingIndex].end - 0.08) {
      const next = segments[containingIndex + 1];
      if (next) el.video.currentTime = next.start;
      else el.video.pause();
    }
  }
  updatePlayhead();
  renderSelectionInfo();
});
el.video.addEventListener("seeked", () => {
  if (!state) return;
  updatePlayhead();
  renderSelectionInfo();
});

window.addEventListener("keydown", (event) => {
  if (!state || el.editor.offsetParent === null || event.target.matches("input, textarea, select")) return;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (command && key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (command && key === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if (command && key === "a") {
    event.preventDefault();
    state.selected = new Set(state.segments.map((segment) => segment.id));
    renderEditorState();
    return;
  }
  if (command && ["+", "=", "-"].includes(event.key)) {
    event.preventDefault();
    setZoom(state.zoom + (event.key === "-" ? -0.5 : 0.5));
    return;
  }
  if (command) return;
  if (key === " ") { event.preventDefault(); togglePlayback(); }
  else if (key === "c") { event.preventDefault(); toggleCropMode(); }
  else if (key === "escape" && state.cropMode) { event.preventDefault(); toggleCropMode(false); }
  else if (key === "s") { event.preventDefault(); splitAtPlayhead(); }
  else if (key === "i") { event.preventDefault(); markIn(); }
  else if (key === "o") { event.preventDefault(); markOut(); }
  else if (key === "delete" || key === "backspace") { event.preventDefault(); deleteSelectedSegments(); }
  else if (key === "arrowleft" || key === "arrowright") {
    event.preventDefault();
    const direction = key === "arrowleft" ? -1 : 1;
    seekTo(el.video.currentTime + direction * (event.shiftKey ? 1 : 0.1));
  }
});
