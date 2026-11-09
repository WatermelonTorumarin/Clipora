// Precisa ser igual ao API_VERSION do server.js.
export const API_VERSION = 10;
export const OUTDATED_SERVER_MESSAGE =
  "O servidor do Clipora está desatualizado. Feche a janela do Clipora (Ctrl+C) e abra novamente com npm.cmd start.";

export class SessionLostError extends Error {
  constructor(message = "A sessão expirou. Abra o vídeo novamente.") {
    super(message);
    this.name = "SessionLostError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelado");
    this.name = "CancelledError";
  }
}

export async function requestJson(url, options = {}) {
  const headers = { ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}), ...options.headers };
  const response = await fetch(url, { cache: "no-store", ...options, headers });
  if (response.status === 204) return {};
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error(OUTDATED_SERVER_MESSAGE);
  const data = await response.json();
  if (response.status === 404 && data.code === "session_lost") throw new SessionLostError(data.error);
  if (!response.ok) {
    const error = new Error(data.error || "Algo deu errado. Tente novamente.");
    error.code = data.code || null;
    error.site = data.site || null;
    throw error;
  }
  return data;
}

export const postJson = (url, body) => requestJson(url, { method: "POST", body: JSON.stringify(body ?? {}) });

export async function fetchVideoInfo(url) {
  const data = await postJson("/api/info", { url });
  if (data.apiVersion !== API_VERSION) throw new Error(OUTDATED_SERVER_MESSAGE);
  return data;
}

export const createUrlSession = (url, height, purpose) =>
  postJson("/api/editor-sessions", { url, height, purpose });

export function uploadSession(file, purpose, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/editor-sessions/upload");
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.setRequestHeader("X-Clipora-Purpose", purpose);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || "Não foi possível carregar o vídeo."));
    });
    request.addEventListener("error", () => reject(new Error("Falha ao carregar o vídeo local.")));
    request.send(file);
  });
}

export const getSession = (id) => requestJson(`/api/editor-sessions/${id}`);
export const deleteSession = (id) => fetch(`/api/editor-sessions/${id}`, { method: "DELETE" }).catch(() => {});
export const startExport = (id, payload) => postJson(`/api/editor-sessions/${id}/exports`, payload);
export const cancelExport = (id) => fetch(`/api/editor-sessions/${id}/cancel-export`, { method: "POST" }).catch(() => {});
export const requestEditorAssets = (id) => postJson(`/api/editor-sessions/${id}/assets`);

// Baixa por um iframe oculto: se o servidor responder com erro (JSON), a página
// continua intacta em vez de ser trocada pela resposta.
export function triggerDownload(url) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = url;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 5 * 60 * 1000);
}

export function downloadExport(id, { keep = false } = {}) {
  triggerDownload(`/api/editor-sessions/${id}/file${keep ? "?keep=1" : ""}`);
}

// Consulta a sessao ate atingir um dos estados de `until`.
// `isCancelled` permite abandonar a espera quando a tela muda.
export async function waitForSession(id, { until, onProgress, isCancelled = () => false, interval = 700 }) {
  for (;;) {
    if (isCancelled()) throw new CancelledError();
    const data = await getSession(id);
    if (isCancelled()) throw new CancelledError();
    onProgress?.(data);
    if (until.includes(data.status)) return data;
    if (["error", "export_error"].includes(data.status)) throw new Error(data.error || "A tarefa falhou.");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Mantem a sessao viva enquanto a tela estiver aberta; avisa se ela sumir.
export function startHeartbeat(id, onLost, interval = 60 * 1000) {
  const timer = setInterval(async () => {
    try {
      await getSession(id);
    } catch (error) {
      if (error instanceof SessionLostError) {
        clearInterval(timer);
        onLost(error);
      }
    }
  }, interval);
  return () => clearInterval(timer);
}
