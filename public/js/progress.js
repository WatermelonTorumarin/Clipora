import { $ } from "./util.js";

const panel = $("#download-progress");
const title = $("#progress-title");
const fill = $("#progress-fill");
const percent = $("#progress-percent");
const phase = $("#progress-phase");
const button = $("#cancel-download");

let buttonHandler = null;
let hideTimer = null;

export function showProgress(titleText, value, phaseText, onCancel) {
  window.clearTimeout(hideTimer);
  title.textContent = titleText;
  panel.classList.remove("hidden");
  button.textContent = "Cancelar";
  buttonHandler = onCancel || null;
  updateProgress(value, phaseText);
}

export function updateProgress(value, phaseText) {
  const safeValue = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  fill.style.width = `${safeValue}%`;
  percent.textContent = `${safeValue}%`;
  if (phaseText != null) phase.textContent = phaseText;
}

export function progressError(messageText, onClose) {
  updateProgress(0, messageText);
  button.textContent = "Fechar";
  buttonHandler = onClose || null;
}

export function progressDone(phaseText) {
  updateProgress(100, phaseText);
  button.textContent = "Fechar";
  buttonHandler = null;
  hideTimer = window.setTimeout(hideProgress, 5000);
}

export function hideProgress() {
  window.clearTimeout(hideTimer);
  panel.classList.add("hidden");
  buttonHandler = null;
}

button.addEventListener("click", () => {
  const handler = buttonHandler;
  hideProgress();
  handler?.();
});
