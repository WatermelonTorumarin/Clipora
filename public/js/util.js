export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function isHttpUrl(text) {
  return /^https?:\/\/\S+$/i.test(String(text || "").trim());
}

export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "00:00";
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return [hours, minutes, seconds]
    .filter((_, index) => hours > 0 || index > 0)
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function formatPrecise(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
  const milliseconds = Math.floor((safeSeconds % 1) * 1000);
  return `${formatDuration(Math.floor(safeSeconds))}.${String(milliseconds).padStart(3, "0")}`;
}

// Duracao curta com um decimal: "4,2 s" ou, acima de um minuto, "1:02,4".
export function formatClipLength(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  if (tenths < 600) return `${(tenths / 10).toFixed(1).replace(".", ",")} s`;
  const minutes = Math.floor(tenths / 600);
  const rest = ((tenths - minutes * 600) / 10).toFixed(1).padStart(4, "0").replace(".", ",");
  return `${minutes}:${rest}`;
}

// Texto editavel dos campos de tempo: "1:23.5" ou "1:02:03.0".
export function formatTimeInput(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const rest = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// Aceita "83", "1:23", "1:23.5", "1:23,5" e "0:01:23". Retorna null se invalido.
export function parseTimeInput(text) {
  const value = String(text || "").trim().replace(",", ".");
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  if (parts.slice(0, -1).some((part) => part.includes("."))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0).replace(".", ",")} ${units[index]}`;
}

export function formatMb(value) {
  return `${value.toFixed(value < 10 ? 1 : 0).replace(".", ",")} MB`;
}

export function qualityLabel(height) {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height >= 1080) return "Full HD";
  if (height >= 720) return "HD";
  return "Compacto";
}

// Espelha o calculo do servidor: minimo de 100 kbps de video + 64 kbps de audio.
export function minimumTargetMb(duration, hasAudio) {
  const totalKbps = hasAudio ? 164 : 100;
  return (totalKbps * 1000 * duration) / 8 / 1024 / 1024 / 0.96 * 1.02;
}

// Limite superior dos niveis de compressao (mesmo teto usado pelo servidor).
const LEVEL_ESTIMATES = {
  light: { share: 0.85, audioKbps: 128 },
  medium: { share: 0.65, audioKbps: 112 },
  strong: { share: 0.45, audioKbps: 80 }
};

export function levelCeilingMb(level, { fileSize, duration, hasAudio }) {
  const settings = LEVEL_ESTIMATES[level];
  if (!settings || !fileSize || !duration) return 0;
  const sourceKbps = (fileSize * 8) / 1000 / duration;
  const sourceVideoKbps = Math.max(150, sourceKbps - (hasAudio ? 128 : 0));
  const totalKbps = sourceVideoKbps * settings.share + (hasAudio ? settings.audioKbps : 0);
  return (totalKbps * 1000 * duration) / 8 / 1024 / 1024;
}
