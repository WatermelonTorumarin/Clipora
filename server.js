const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

// O yt-dlp nao habilita o Node automaticamente. O YouTube agora exige um
// runtime JavaScript para resolver os desafios que liberam os formatos.
const ytDlpBaseOptions = {
  jsRuntimes: `node:${process.execPath}`,
  ffmpegLocation: ffmpegPath
};

const app = express();
const PORT = process.env.PORT || 3000;
// Aumente quando o formato das respostas mudar; a pagina compara com o valor dela
// para detectar um servidor antigo que continua aberto depois de uma atualizacao.
const API_VERSION = 10;
const publicDir = path.join(__dirname, "public");
const videoInfoCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const EDITOR_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_DOWNLOADS = 1;
const MAX_STORED_JOBS = 10;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024 * 1024;
const ABANDONED_JOB_MS = 3 * 60 * 1000;
const downloadJobs = new Map();
const editorJobs = new Map();
const downloadQueue = [];
let activeDownloads = 0;

// 4 MB: o botão "Enviar ao Clipora" pode mandar milhares de endereços de imagem.
app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));

// Qualquer pagina http(s) e aceita: o yt-dlp decide se consegue extrair o video
// (YouTube, X/Twitter, Reddit, Instagram, TikTok e centenas de outros sites).
function isSupportedUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Altura 0 significa "melhor disponivel", usada quando o site nao informa resolucoes.
function isValidHeight(height) {
  return Number.isInteger(height) && (height === 0 || (height >= 144 && height <= 4320));
}

function cleanFileName(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
}

function videoHeight(format) {
  return Number(format.height || 0);
}

// Nessas redes o "titulo" e o texto inteiro do post, longo demais para nome de
// arquivo. Usamos perfil + id do post (ex.: FallenTearGame-2099407223135084723).
const POST_TEXT_TITLE_SITES = new Set(["Twitter", "Instagram", "TikTok"]);

function fileTitleFor(info) {
  const author = (info.extractor_key === "Instagram" && info.channel) || info.uploader_id || info.channel_id;
  const postId = info.display_id || info.id;
  if (POST_TEXT_TITLE_SITES.has(info.extractor_key) && author && postId) {
    return `${author}-${postId}`;
  }
  return info.title || "video";
}

function cacheVideoInfo(url, info) {
  if (videoInfoCache.size >= 100) {
    const oldestKey = videoInfoCache.keys().next().value;
    videoInfoCache.delete(oldestKey);
  }
  videoInfoCache.set(url, {
    title: info.title,
    fileTitle: fileTitleFor(info),
    duration: Number(info.duration || 0),
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function getCachedInfo(url) {
  const cached = videoInfoCache.get(url);
  if (!cached || cached.expiresAt < Date.now()) {
    videoInfoCache.delete(url);
    return { title: "video", fileTitle: "video", duration: 0 };
  }
  return cached;
}

// Sites como o Reddit nao fornecem miniatura: capturamos um quadro do proprio
// video (na menor resolucao a partir de 240p) e devolvemos como imagem embutida.
function captureThumbnail(info) {
  const candidates = (info.formats?.length ? info.formats : [info])
    .filter((format) => format.url && format.vcodec !== "none" && Number(format.height || 0) > 0 &&
      !/mhtml/.test(format.protocol || ""))
    .sort((a, b) => Number(a.height) - Number(b.height));
  const format = candidates.find((candidate) => Number(candidate.height) >= 240) || candidates.at(-1);
  if (!format) return Promise.resolve(null);

  const headers = Object.entries(format.http_headers || {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const seekSeconds = Math.min(1, Math.max(0, Number(info.duration || 0) / 2));

  return new Promise((resolve) => {
    const process = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      ...(headers ? ["-headers", headers] : []),
      "-ss", String(seekSeconds),
      "-i", format.url,
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-f", "image2",
      "-c:v", "mjpeg",
      "-q:v", "5",
      "pipe:1"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    const timer = setTimeout(() => process.kill("SIGKILL"), 15000);

    process.stdout.on("data", (chunk) => chunks.push(chunk));
    process.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      const image = Buffer.concat(chunks);
      resolve(code === 0 && image.length ? `data:image/jpeg;base64,${image.toString("base64")}` : null);
    });
  });
}

function updateJob(job, values) {
  Object.assign(job, values, { updatedAt: Date.now() });
}

function parseTimestamp(value) {
  const match = String(value || "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, ["-hide_banner", "-i", filePath], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let output = "";

    process.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-30000);
    });
    process.on("error", reject);
    process.on("close", () => {
      const durationMatch = output.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      const videoLine = output.match(/Stream #[^\n]*?Video:[^\n]*/)?.[0] || "";
      const audioLine = output.match(/Stream #[^\n]*?Audio:[^\n]*/)?.[0] || "";
      const sizeMatch = videoLine.match(/,\s*(\d{2,5})x(\d{2,5})/);
      const duration = parseTimestamp(durationMatch?.[1]);
      if (!duration || !sizeMatch) {
        return reject(new Error("O arquivo não contém um vídeo compatível."));
      }
      // Videos de celular guardam a rotacao separada; o navegador e o FFmpeg
      // exibem o quadro ja girado, entao largura e altura precisam ser trocadas.
      const rotationMatch = output.match(/rotation of (-?\d+(?:\.\d+)?) degrees/) ||
        output.match(/rotate\s*:\s*(-?\d+)/);
      const sideways = Math.abs(Math.round(Number(rotationMatch?.[1] || 0))) % 180 === 90;
      const width = Number(sizeMatch[1]);
      const height = Number(sizeMatch[2]);
      resolve({
        duration,
        width: sideways ? height : width,
        height: sideways ? width : height,
        hasAudio: Boolean(audioLine),
        videoCodec: videoLine.match(/Video:\s*(\w+)/)?.[1] || "",
        audioCodec: audioLine.match(/Audio:\s*(\w+)/)?.[1] || ""
      });
    });
  });
}

function runFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let errorOutput = "";
    let progressBuffer = "";

    options.onProcess?.(process);
    process.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)$/);
        if (!match || !options.duration) continue;
        const seconds = Number(match[1]) / 1_000_000;
        options.onProgress?.(Math.min(100, (seconds / options.duration) * 100));
      }
    });
    process.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-12000);
    });
    process.on("error", reject);
    process.on("close", (code) => {
      options.onProcess?.(null);
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg encerrou com codigo ${code}: ${errorOutput}`));
    });
  });
}

function convertToCompatibleMp4(inputPath, outputPath, duration, onProgress, onProcess) {
  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-tag:v", "avc1",
    "-c:a", "aac",
    "-b:a", "192k",
    "-progress", "pipe:1",
    "-nostats",
    outputPath
  ];

  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let errorOutput = "";
    let progressBuffer = "";

    onProcess(process);
    process.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";

      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)$/);
        if (!match || !duration) continue;
        const seconds = Number(match[1]) / 1_000_000;
        onProgress(Math.min(100, (seconds / duration) * 100));
      }
    });

    process.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-8000);
    });
    process.on("error", reject);
    process.on("close", (code) => {
      onProcess(null);
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg encerrou com codigo ${code}: ${errorOutput}`));
    });
  });
}

function runYtDlpWithProgress(url, flags, onProgress, onProcess) {
  const subprocess = youtubedl.exec(url, {
    ...ytDlpBaseOptions,
    ...flags,
    newline: true,
    progress: true,
    progressDelta: 0.4,
    progressTemplate: "download:CLIPORA:%(progress._percent_str)s"
  });

  let component = 0;
  let previousRaw = 0;
  let outputBuffer = "";

  const parseOutput = (chunk) => {
    outputBuffer += chunk.toString().replace(/\u001b\[[0-9;]*m/g, "");
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() || "";

    for (const line of lines) {
      const match = line.match(/CLIPORA:\s*([\d.,]+)%/);
      if (!match) continue;

      const raw = Number(match[1].replace(",", "."));
      if (!Number.isFinite(raw)) continue;
      if (previousRaw > 85 && raw < 20) component += 1;
      previousRaw = raw;

      const progress = component === 0
        ? raw * 0.48
        : 48 + raw * 0.32;
      onProgress(Math.min(80, progress));
    }
  };

  onProcess(subprocess);
  subprocess.stdout?.on("data", parseOutput);
  subprocess.stderr?.on("data", parseOutput);

  return Promise.resolve(subprocess).finally(() => onProcess(null));
}

async function removeJobFiles(job) {
  if (!job.tempDir) return;
  try {
    await fs.promises.rm(job.tempDir, { recursive: true, force: true });
    job.tempDir = null;
  } catch {
    // A rotina principal tentara novamente depois que o processo encerrar.
  }
}

async function prepareEditorAssets(job, filePath) {
  const media = await probeMedia(filePath);
  const thumbnailCount = Math.min(96, Math.max(24, Math.ceil(media.duration / 8)));
  const thumbnailInterval = Math.max(0.25, media.duration / thumbnailCount);
  const thumbnailTemplate = path.join(job.tempDir, "thumb-%03d.jpg");

  updateJob(job, { phase: "Criando miniaturas da timeline", progress: Math.max(job.progress, 98) });
  await runFfmpeg([
    "-y",
    "-i", filePath,
    "-vf", `fps=1/${thumbnailInterval},scale=180:-2:force_original_aspect_ratio=decrease`,
    "-frames:v", String(thumbnailCount),
    "-q:v", "5",
    thumbnailTemplate
  ], { onProcess: (process) => { job.process = process; } });

  const thumbnailFiles = (await fs.promises.readdir(job.tempDir))
    .filter((file) => /^thumb-\d+\.jpg$/.test(file))
    .sort();

  let waveformFile = null;
  if (media.hasAudio) {
    updateJob(job, { phase: "Analisando forma de onda", progress: Math.max(job.progress, 99) });
    waveformFile = "waveform.png";
    try {
      await runFfmpeg([
        "-y",
        "-i", filePath,
        "-filter_complex", "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=3200x120:colors=8b5cf6[wave]",
        "-map", "[wave]",
        "-frames:v", "1",
        path.join(job.tempDir, waveformFile)
      ], { onProcess: (process) => { job.process = process; } });
    } catch (error) {
      console.warn("Nao foi possivel gerar a forma de onda.", error.message);
      waveformFile = null;
    }
  }

  job.process = null;
  Object.assign(job, {
    media,
    thumbnailFiles,
    thumbnailInterval,
    waveformFile
  });
}

function editorJobResponse(job) {
  const response = {
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    error: job.error || null
  };

  if (["editor_ready", "export_ready"].includes(job.status) && job.media) {
    Object.assign(response, {
      purpose: job.purpose,
      duration: job.media.duration,
      width: job.media.width,
      height: job.media.height,
      hasAudio: job.media.hasAudio,
      fileSize: job.fileSize,
      title: job.title,
      thumbnails: (job.thumbnailFiles || []).map((file, index) => ({
        url: `/api/editor-sessions/${job.id}/assets/${file}`,
        time: Math.min(job.media.duration, index * job.thumbnailInterval)
      })),
      waveform: job.waveformFile
        ? `/api/editor-sessions/${job.id}/assets/${job.waveformFile}`
        : null
    });
  }

  return response;
}

function normalizeSegments(value, duration) {
  if (!Array.isArray(value) || !value.length || value.length > 200) return null;
  const segments = value.map((segment) => ({
    start: Number(segment?.start),
    end: Number(segment?.end)
  })).sort((a, b) => a.start - b.start);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end > duration + 0.05 ||
      segment.end - segment.start < 0.04 ||
      (index > 0 && segment.start < segments[index - 1].end - 0.01)
    ) return null;
    segment.start = Math.max(0, segment.start);
    segment.end = Math.min(duration, segment.end);
  }
  return segments;
}

// sourceShare: teto de bitrate como fracao do bitrate de video da fonte.
const COMPRESSION_LEVELS = {
  original: { crf: 20, preset: "veryfast", audioKbps: 192, maxShortSide: 0, sourceShare: 0 },
  light: { crf: 26, preset: "faster", audioKbps: 128, maxShortSide: 0, sourceShare: 0.85 },
  medium: { crf: 29, preset: "faster", audioKbps: 112, maxShortSide: 1080, sourceShare: 0.65 },
  strong: { crf: 33, preset: "faster", audioKbps: 80, maxShortSide: 720, sourceShare: 0.45 }
};

// Bitrate aproximado do video da fonte (0 quando desconhecido).
function sourceVideoKbps(job) {
  if (!job.fileSize || !job.media?.duration) return 0;
  const sourceKbps = (job.fileSize * 8) / 1000 / job.media.duration;
  return Math.max(150, Math.round(sourceKbps - (job.media.hasAudio ? 128 : 0)));
}

// O CRF sozinho pode gerar um arquivo MAIOR que a fonte quando ela ja veio bem
// comprimida (ex.: X/Twitter). O teto relativo a fonte garante que comprimir reduz.
function levelBitrateCap(job, level) {
  const sourceKbps = sourceVideoKbps(job);
  if (!level.sourceShare || !sourceKbps) return [];
  const capKbps = Math.round(sourceKbps * level.sourceShare);
  return ["-maxrate", `${capKbps}k`, "-bufsize", `${capKbps * 2}k`];
}
const GIF_SIZES = [320, 480, 640];
const GIF_FPS = [10, 15, 24];
const GIF_MAX_SECONDS = 10;
const TARGET_MIN_VIDEO_KBPS = 100;

function evenNumber(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

const MIN_CROP_PIXELS = 16;

// O recorte chega em fracoes do quadro ({ x, y, w, h }), com proporcao livre.
// scaleMode "real" mantem os pixels da area; "fit" amplia ate caber no quadro
// original sem deformar. Retorna null sem recorte e false se invalido.
function normalizeCrop(value, media, scaleMode) {
  if (value == null) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w);
  const h = Number(value.h);
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    w <= 0 || h <= 0 || w > 1.001 || h > 1.001 ||
    x < -0.001 || y < -0.001 ||
    x + w > 1.001 || y + h > 1.001 ||
    !["real", "fit"].includes(scaleMode)
  ) return false;
  if (w >= 0.999 && h >= 0.999) return null;

  const width = Math.min(media.width - (media.width % 2), evenNumber(media.width * w));
  const height = Math.min(media.height - (media.height % 2), evenNumber(media.height * h));
  if (width < MIN_CROP_PIXELS || height < MIN_CROP_PIXELS) return false;

  let output = { width, height };
  if (scaleMode === "fit") {
    const scale = Math.min(media.width / width, media.height / height);
    output = { width: evenNumber(width * scale), height: evenNumber(height * scale) };
  }
  return {
    width,
    height,
    x: Math.max(0, Math.min(media.width - width, Math.round(media.width * x))),
    y: Math.max(0, Math.min(media.height - height, Math.round(media.height * y))),
    output
  };
}

function targetBitrates(targetMb, duration, hasAudio) {
  // 4% de folga para o cabecalho do MP4.
  const totalKbps = (targetMb * 1024 * 1024 * 8 * 0.96) / duration / 1000;
  const audioKbps = !hasAudio ? 0 : totalKbps >= 1000 ? 128 : totalKbps >= 400 ? 96 : 64;
  return { audioKbps, videoKbps: Math.floor(totalKbps - audioKbps) };
}

function shortSideForBitrate(videoKbps) {
  if (videoKbps >= 4000) return 0;
  if (videoKbps >= 2000) return 1080;
  if (videoKbps >= 1000) return 720;
  if (videoKbps >= 500) return 480;
  return 360;
}

function limitShortSide({ width, height }, maxShortSide) {
  const shortSide = Math.min(width, height);
  if (!maxShortSide || shortSide <= maxShortSide) return { width, height };
  const scale = maxShortSide / shortSide;
  return { width: evenNumber(width * scale), height: evenNumber(height * scale) };
}

function limitLongSide({ width, height }, maxLongSide) {
  const longSide = Math.max(width, height);
  if (longSide <= maxLongSide) return { width, height };
  const scale = maxLongSide / longSide;
  return { width: evenNumber(width * scale), height: evenNumber(height * scale) };
}

function normalizeOutput(value, duration, hasAudio) {
  if (value?.format === "gif") {
    if (duration > GIF_MAX_SECONDS + 0.05) {
      return { error: "GIF disponível apenas para clipes de até 10 segundos." };
    }
    const gifSize = Number(value.gifSize);
    const gifFps = Number(value.gifFps);
    if (!GIF_SIZES.includes(gifSize) || !GIF_FPS.includes(gifFps)) {
      return { error: "Opções de GIF inválidas." };
    }
    return { format: "gif", gifSize, gifFps };
  }

  const compression = String(value?.compression || "original");
  if (compression === "target") {
    const targetMb = Number(value.targetMb);
    if (!Number.isFinite(targetMb) || targetMb <= 0 || targetMb > 100000) {
      return { error: "Informe um tamanho alvo válido." };
    }
    const bitrates = targetBitrates(targetMb, duration, hasAudio);
    if (bitrates.videoKbps < TARGET_MIN_VIDEO_KBPS) {
      return { error: "O tamanho alvo é pequeno demais para a duração desse clipe." };
    }
    return { format: "mp4", compression, targetMb, ...bitrates };
  }
  if (!COMPRESSION_LEVELS[compression]) return { error: "Nível de compressão inválido." };
  return { format: "mp4", compression };
}

function buildExportPlan(job) {
  const { media, exportCrop: crop, exportOutput: output } = job;
  const baseSize = crop ? crop.output : { width: media.width, height: media.height };
  let size = { ...baseSize };
  if (output.format === "gif") {
    size = limitLongSide(size, output.gifSize);
  } else if (output.compression === "target") {
    // Com o teto da fonte o bitrate ja e o dela: nao ha motivo para reduzir a resolucao.
    if (!output.cappedToSource) size = limitShortSide(size, shortSideForBitrate(output.videoKbps));
  } else {
    size = limitShortSide(size, COMPRESSION_LEVELS[output.compression].maxShortSide);
  }

  const videoFilters = [];
  if (crop) videoFilters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  // Sem recorte, compara com a fonte; com recorte, com a area cortada.
  const current = crop ? { width: crop.width, height: crop.height } : { width: media.width, height: media.height };
  if (size.width !== current.width || size.height !== current.height) {
    videoFilters.push(`scale=${evenNumber(size.width)}:${evenNumber(size.height)}:flags=lanczos`);
  }
  if (crop || videoFilters.length) videoFilters.push("setsar=1");
  return { videoFilters };
}

function buildFilterGraph(job, plan, includeAudio) {
  const { exportSegments: segments, exportOutput: output, media } = job;
  const hasAudio = includeAudio && media.hasAudio && output.format !== "gif";
  const filters = [];
  let videoLabel = "0:v:0";
  let audioLabel = hasAudio ? "0:a:0" : null;

  if (segments.length > 1) {
    const concatInputs = [];
    segments.forEach((segment, index) => {
      const range = `start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)}`;
      filters.push(`[0:v:0]trim=${range},setpts=PTS-STARTPTS[v${index}]`);
      concatInputs.push(`[v${index}]`);
      if (hasAudio) {
        filters.push(`[0:a:0]atrim=${range},asetpts=PTS-STARTPTS[a${index}]`);
        concatInputs.push(`[a${index}]`);
      }
    });
    filters.push(
      `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[catv]${hasAudio ? "[cata]" : ""}`
    );
    videoLabel = "[catv]";
    audioLabel = hasAudio ? "[cata]" : null;
  }

  const chainInput = videoLabel.startsWith("[") ? videoLabel : `[${videoLabel}]`;
  if (output.format === "gif") {
    // Paleta propria do clipe: cores bem melhores que a paleta padrao do GIF.
    const chain = [`fps=${output.gifFps}`, ...plan.videoFilters].join(",");
    filters.push(
      `${chainInput}${chain},split[gifa][gifb]`,
      "[gifa]palettegen=stats_mode=diff[gifp]",
      "[gifb][gifp]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[outv]"
    );
    videoLabel = "[outv]";
  } else if (plan.videoFilters.length) {
    filters.push(`${chainInput}${plan.videoFilters.join(",")}[outv]`);
    videoLabel = "[outv]";
  }

  return {
    hasAudio,
    args: [
      ...(filters.length ? ["-filter_complex", filters.join(";")] : []),
      "-map", videoLabel,
      ...(audioLabel ? ["-map", audioLabel] : [])
    ]
  };
}

function exportPhase(job) {
  if (job.exportOutput.format === "gif") return "Gerando GIF";
  if (job.exportOutput.compression !== "original") return "Comprimindo vídeo";
  return job.exportCrop ? "Recortando imagem" : "Exportando cortes";
}

async function processEditorExportJob(job) {
  const output = job.exportOutput;
  const extension = output.format === "gif" ? "gif" : "mp4";
  const outputPath = path.join(job.tempDir, `clipora-export.${extension}`);
  const segments = job.exportSegments;
  const outputDuration = segments.reduce((total, segment) => total + segment.end - segment.start, 0);
  await Promise.all(["mp4", "gif"].map((ext) =>
    fs.promises.rm(path.join(job.tempDir, `clipora-export.${ext}`), { force: true }).catch(() => {})
  ));
  updateJob(job, { status: "exporting", phase: exportPhase(job), progress: 1 });

  try {
    const unchanged = !job.exportCrop &&
      output.format === "mp4" &&
      output.compression === "original" &&
      segments.length === 1 &&
      segments[0].start <= 0.04 &&
      Math.abs(segments[0].end - job.media.duration) <= 0.08;

    if (unchanged) {
      updateJob(job, {
        status: "export_ready",
        phase: "Arquivo original pronto",
        progress: 100,
        exportPath: job.filePath,
        exportIsSource: true,
        exportDuration: job.media.duration,
        expiresAt: Date.now() + EDITOR_TTL_MS
      });
      return;
    }

    const plan = buildExportPlan(job);
    // -ss e -t antes do -i limitam a propria leitura ao trecho. Com -t depois do
    // -i, filtros que esperam o fim da entrada (a paleta do GIF) decodificavam e
    // guardavam em memoria todo o restante do video.
    const inputArgs = segments.length === 1
      ? [
        "-ss", segments[0].start.toFixed(3),
        "-t", (segments[0].end - segments[0].start).toFixed(3),
        "-i", job.filePath
      ]
      : ["-i", job.filePath];
    const progressArgs = ["-progress", "pipe:1", "-nostats"];
    const ffmpegOptions = (from, to) => ({
      cwd: job.tempDir,
      duration: outputDuration,
      onProgress: (value) => updateJob(job, {
        progress: Math.max(job.progress, Math.min(99, Math.round(from + (value / 100) * (to - from))))
      }),
      onProcess: (process) => { job.process = process; }
    });
    const audioArgs = (graph, kbps) => (graph.hasAudio ? ["-c:a", "aac", "-b:a", `${kbps}k`] : []);

    if (output.format === "gif") {
      const graph = buildFilterGraph(job, plan, false);
      await runFfmpeg(
        ["-y", ...inputArgs, ...graph.args, "-loop", "0", ...progressArgs, outputPath],
        ffmpegOptions(1, 99)
      );
    } else if (output.compression === "target") {
      // Duas passagens: a primeira mede o video, a segunda distribui os bits
      // para chegar perto do tamanho pedido.
      const videoArgs = [
        "-c:v", "libx264",
        "-preset", "faster",
        "-b:v", `${output.videoKbps}k`,
        "-maxrate", `${Math.round(output.videoKbps * 1.5)}k`,
        "-bufsize", `${output.videoKbps * 2}k`,
        "-pix_fmt", "yuv420p",
        "-passlogfile", "clipora-pass"
      ];
      updateJob(job, { phase: "Comprimindo (etapa 1 de 2)" });
      const firstPass = buildFilterGraph(job, plan, false);
      await runFfmpeg(
        ["-y", ...inputArgs, ...firstPass.args, ...videoArgs, "-pass", "1", "-an", "-f", "null",
          ...progressArgs, path.join(job.tempDir, "pass1.null")],
        ffmpegOptions(1, 45)
      );
      if (job.status !== "exporting") throw new Error("Exportação interrompida.");

      updateJob(job, { phase: "Comprimindo (etapa 2 de 2)" });
      const secondPass = buildFilterGraph(job, plan, true);
      await runFfmpeg(
        ["-y", ...inputArgs, ...secondPass.args, ...videoArgs, "-pass", "2", "-tag:v", "avc1",
          ...audioArgs(secondPass, output.audioKbps), "-movflags", "+faststart", ...progressArgs, outputPath],
        ffmpegOptions(45, 99)
      );
    } else {
      const level = COMPRESSION_LEVELS[output.compression];
      const graph = buildFilterGraph(job, plan, true);
      await runFfmpeg(
        ["-y", ...inputArgs, ...graph.args,
          "-c:v", "libx264", "-preset", level.preset, "-crf", String(level.crf),
          ...levelBitrateCap(job, level),
          "-pix_fmt", "yuv420p", "-tag:v", "avc1",
          ...audioArgs(graph, level.audioKbps), "-movflags", "+faststart", ...progressArgs, outputPath],
        ffmpegOptions(1, 99)
      );
    }

    if (job.status === "cancelled") return;
    const stat = await fs.promises.stat(outputPath);
    updateJob(job, {
      status: "export_ready",
      phase: output.format === "gif" ? "GIF pronto" : "Clipe pronto",
      progress: 100,
      exportPath: outputPath,
      exportIsSource: false,
      exportDuration: outputDuration,
      exportSize: stat.size,
      expiresAt: Date.now() + EDITOR_TTL_MS
    });
  } catch (error) {
    console.error(error);
    if (job.status === "cancelling_export") {
      await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      updateJob(job, {
        status: "editor_ready",
        phase: "Exportação cancelada",
        progress: 100,
        error: null,
        expiresAt: Date.now() + EDITOR_TTL_MS
      });
    } else if (job.status !== "cancelled") {
      updateJob(job, {
        status: "export_error",
        phase: "Falha ao exportar",
        error: "Não foi possível exportar esses cortes.",
        expiresAt: Date.now() + 5 * 60 * 1000
      });
    }
  } finally {
    job.process = null;
  }
}

// Finalidade da sessao, da mais leve para a mais completa:
// "probe"  -> so as informacoes do video (ferramenta Comprimir, sem player);
// "player" -> video reproduzivel no navegador (ferramentas GIF e Recortar);
// "editor" -> player + miniaturas e forma de onda da timeline.
const SESSION_PURPOSES = ["probe", "player", "editor"];

// O navegador so exibe alguns codecs. HEVC/H.265, ProRes, MPEG-2 e afins abrem
// o player sem imagem (e sem erro), entao esses viram um MP4 H.264 para a previa.
const PLAYABLE_CONTAINERS = new Set([".mp4", ".m4v", ".webm"]);
const PLAYABLE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const PLAYABLE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis"]);

function isBrowserPlayable(filePath, media) {
  return PLAYABLE_CONTAINERS.has(path.extname(filePath).toLowerCase()) &&
    PLAYABLE_VIDEO_CODECS.has(media.videoCodec) &&
    (!media.hasAudio || PLAYABLE_AUDIO_CODECS.has(media.audioCodec));
}

async function prepareSessionMedia(job, purpose) {
  const needsPlayer = purpose !== "probe";
  let media = await probeMedia(job.filePath);

  if (needsPlayer && !isBrowserPlayable(job.filePath, media)) {
    const compatiblePath = path.join(job.tempDir, "editor-source.mp4");
    updateJob(job, {
      phase: `Convertendo ${media.videoCodec.toUpperCase()} para visualização`,
      progress: Math.max(job.progress, 90)
    });
    await convertToCompatibleMp4(
      job.filePath,
      compatiblePath,
      media.duration,
      (value) => updateJob(job, { progress: Math.max(job.progress, 90 + Math.round(value * 0.06)) }),
      (process) => { job.process = process; }
    );
    job.filePath = compatiblePath;
    media = null;
  }

  if (purpose === "editor") {
    await prepareEditorAssets(job, job.filePath);
  } else {
    job.media = media || await probeMedia(job.filePath);
  }
  const stat = await fs.promises.stat(job.filePath);
  job.purpose = purpose;
  updateJob(job, {
    status: "editor_ready",
    phase: purpose === "editor" ? "Editor pronto" : "Vídeo pronto",
    progress: 100,
    fileSize: stat.size,
    expiresAt: Date.now() + EDITOR_TTL_MS
  });
}

async function processLocalEditorJob(job) {
  try {
    updateJob(job, { status: "preparing", phase: "Analisando vídeo", progress: Math.max(job.progress, 90) });
    await prepareSessionMedia(job, job.requestedPurpose || "editor");
  } catch (error) {
    console.error(error);
    if (job.status !== "cancelled") {
      updateJob(job, {
        status: "error",
        phase: "Vídeo incompatível",
        error: "Não foi possível abrir esse arquivo de vídeo.",
        expiresAt: Date.now() + 5 * 60 * 1000
      });
    }
  } finally {
    job.process = null;
  }
}

async function processDownloadJob(job) {
  const { url, height } = job;
  const cachedInfo = getCachedInfo(url);
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clipora-"));
  const compatibleTemplate = path.join(tempDir, "compatible.%(ext)s");
  const fallbackTemplate = path.join(tempDir, "fallback.%(ext)s");
  const outputPath = path.join(tempDir, "video.mp4");

  job.tempDir = tempDir;
  updateJob(job, { status: "downloading", phase: "Baixando vídeo e áudio", progress: 1 });

  const setProcess = (process) => {
    job.process = process;
  };

  // Com altura 0 nao ha limite; "<=?" tambem aceita formatos sem altura informada.
  const heightFilter = height ? `[height<=?${height}]` : "";

  try {
    let finalPath;

    try {
      await runYtDlpWithProgress(url, {
        noPlaylist: true,
        playlistItems: String(job.playlistItem || 1),
        concurrentFragments: 4,
        retries: 5,
        fragmentRetries: 5,
        format: `bestvideo${heightFilter}[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best${heightFilter}[vcodec^=avc1][acodec^=mp4a]`,
        mergeOutputFormat: "mp4",
        output: compatibleTemplate
      }, (value) => {
        updateJob(job, {
          phase: value >= 78 ? "Combinando vídeo e áudio" : "Baixando vídeo e áudio",
          progress: Math.max(job.progress, Math.round(value))
        });
      }, setProcess);

      const files = await fs.promises.readdir(tempDir);
      const compatibleName = files.find(
        (file) => file.startsWith("compatible.") && file.endsWith(".mp4")
      );
      if (!compatibleName) throw new Error("MP4 compativel nao foi gerado.");
      finalPath = path.join(tempDir, compatibleName);
      updateJob(job, { phase: "Finalizando MP4", progress: 94 });
    } catch (compatibleError) {
      if (job.status === "cancelled") throw compatibleError;
      console.warn("Formato H.264 direto indisponivel; usando conversao.", compatibleError.message);
      const partialFiles = await fs.promises.readdir(tempDir).catch(() => []);
      await Promise.all(
        partialFiles
          .filter((file) => file.startsWith("compatible."))
          .map((file) => fs.promises.rm(path.join(tempDir, file), { force: true }).catch(() => {}))
      );
      updateJob(job, {
        phase: "Baixando formato alternativo",
        progress: Math.max(job.progress, 5)
      });

      await runYtDlpWithProgress(url, {
        noPlaylist: true,
        playlistItems: String(job.playlistItem || 1),
        concurrentFragments: 4,
        retries: 5,
        fragmentRetries: 5,
        format: `bestvideo${heightFilter}+bestaudio/best${heightFilter}`,
        mergeOutputFormat: "mkv",
        output: fallbackTemplate
      }, (value) => {
        updateJob(job, {
          progress: Math.max(job.progress, Math.round(value * 0.78))
        });
      }, setProcess);

      const files = await fs.promises.readdir(tempDir);
      const fallbackName = files.find((file) => file.startsWith("fallback."));
      if (!fallbackName) throw new Error("Arquivo de origem nao foi gerado.");
      const fallbackPath = path.join(tempDir, fallbackName);

      // Sites como X/Twitter nao informam o codec: o arquivo muitas vezes ja e
      // H.264/AAC e basta troca-lo de embalagem, sem a conversao demorada.
      const sourceInfo = await probeMedia(fallbackPath).catch(() => null);
      const canRemux = sourceInfo?.videoCodec === "h264" &&
        (!sourceInfo.hasAudio || sourceInfo.audioCodec === "aac");

      if (canRemux) {
        updateJob(job, { phase: "Finalizando MP4", progress: Math.max(job.progress, 90) });
        await runFfmpeg([
          "-y",
          "-i", fallbackPath,
          "-map", "0:v:0",
          "-map", "0:a:0?",
          "-c", "copy",
          "-movflags", "+faststart",
          outputPath
        ], { onProcess: setProcess });
      } else {
        updateJob(job, { phase: "Convertendo para H.264", progress: 80 });
        await convertToCompatibleMp4(
          fallbackPath,
          outputPath,
          sourceInfo?.duration || cachedInfo.duration,
          (value) => updateJob(job, {
            progress: Math.max(job.progress, 80 + Math.round(value * 0.17))
          }),
          setProcess
        );
      }
      finalPath = outputPath;
    }

    if (job.status === "cancelled") {
      await removeJobFiles(job);
      return;
    }

    const stat = await fs.promises.stat(finalPath);
    const itemSuffix = job.playlistItem ? `-${job.playlistItem}` : "";
    const downloadName = height
      ? `${cleanFileName(cachedInfo.fileTitle)}${itemSuffix}-${height}p.mp4`
      : `${cleanFileName(cachedInfo.fileTitle)}${itemSuffix}.mp4`;

    if (job.mode === "editor") {
      job.filePath = finalPath;
      job.title = cachedInfo.title;
      job.fileTitle = cachedInfo.fileTitle;
      job.downloadName = downloadName;
      await prepareSessionMedia(job, job.requestedPurpose || "editor");
    } else {
      updateJob(job, {
        status: "ready",
        phase: "Arquivo pronto",
        progress: 100,
        filePath: finalPath,
        fileSize: stat.size,
        downloadName,
        expiresAt: Date.now() + DOWNLOAD_TTL_MS
      });
    }
  } catch (error) {
    console.error(error);
    if (job.status !== "cancelled") {
      updateJob(job, {
        status: "error",
        phase: "Falha ao preparar o download",
        error: "Não foi possível preparar esse vídeo.",
        expiresAt: Date.now() + 5 * 60 * 1000
      });
    }
    await removeJobFiles(job);
  } finally {
    job.process = null;
  }
}

// "Abrir no editor completo" a partir de uma ferramenta: completa a sessao com
// miniaturas e forma de onda sem baixar ou enviar o video de novo.
async function processAssetsJob(job) {
  try {
    updateJob(job, { status: "preparing", phase: "Preparando o editor", progress: 90 });
    await prepareSessionMedia(job, "editor");
  } catch (error) {
    console.error(error);
    if (job.status !== "cancelled") {
      updateJob(job, {
        status: "error",
        phase: "Falha ao preparar o editor",
        error: "Não foi possível abrir o editor completo.",
        expiresAt: Date.now() + 5 * 60 * 1000
      });
    }
  } finally {
    job.process = null;
  }
}

function sessionLost(res) {
  return res.status(404).json({ error: "A sessão expirou. Abra o vídeo novamente.", code: "session_lost" });
}

// Nome do arquivo exportado conforme o que foi feito com o video.
function exportSuffix(job) {
  const seconds = Math.max(1, Math.round(job.exportDuration || 0));
  if (job.exportOutput?.format === "gif") return `gif-${seconds}s`;
  const segments = job.exportSegments || [];
  const whole = segments.length === 1 &&
    segments[0].start <= 0.04 &&
    Math.abs(segments[0].end - job.media.duration) <= 0.08;
  if (whole && job.exportCrop) return "recorte";
  if (whole && job.exportOutput?.compression && job.exportOutput.compression !== "original") return "comprimido";
  return `clip-${seconds}s`;
}

function runDownloadQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) {
    const job = downloadQueue.shift();
    if (!job || job.status === "cancelled") continue;

    activeDownloads += 1;
    const processors = {
      export: processEditorExportJob,
      prepare_local: processLocalEditorJob,
      assets: processAssetsJob,
      gallery_folder: processGalleryFolderJob,
      download: processDownloadJob
    };
    const processor = processors[job.operation] || processDownloadJob;
    processor(job).finally(() => {
      activeDownloads -= 1;
      runDownloadQueue();
    });
  }
}

// ---------- Instagram: posts com fotos (e vídeos) ----------

const GALLERY_TTL_MS = 30 * 60 * 1000;
const MAX_GALLERY_POSTS = 50;
// Os endereços das mídias ficam só no servidor; a página pede por chave e
// posição. Assim o Clipora nunca baixa um endereço que não extraiu ele mesmo.
const galleryPosts = new Map();
const IMAGE_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/bmp": ".bmp"
};
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function isInstagramUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am";
  } catch {
    return false;
  }
}

// As pastas Downloads e Área de Trabalho do Windows podem ter sido movidas (ou ir
// para o OneDrive); o registro diz onde elas estão.
function resolveShellFolder(valueName, fallbackName) {
  if (process.platform === "win32") {
    const result = spawnSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
      "/v",
      valueName
    ], { encoding: "utf8", windowsHide: true });
    const match = String(result.stdout || "").match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    const expanded = match?.[1].trim().replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
    if (expanded) return expanded;
  }
  return path.join(os.homedir(), fallbackName);
}
// CLIPORA_DOWNLOADS_DIR / CLIPORA_DESKTOP_DIR permitem testar sem mexer nas pastas de
// verdade. Com só a primeira definida, a "Área de Trabalho" de teste fica dentro dela.
const DOWNLOADS_DIR = process.env.CLIPORA_DOWNLOADS_DIR ||
  resolveShellFolder("{374DE290-123F-4565-9164-39C4925E467B}", "Downloads");
const DESKTOP_DIR = process.env.CLIPORA_DESKTOP_DIR ||
  (process.env.CLIPORA_DOWNLOADS_DIR
    ? path.join(process.env.CLIPORA_DOWNLOADS_DIR, "_area-de-trabalho")
    : resolveShellFolder("Desktop", "Desktop"));

// Cada foto vem em várias resoluções; a que não tem tamanho no parâmetro "stp"
// (ex.: sem "_s640x640") é a original.
function instagramImageSize(thumbnail) {
  try {
    const stp = new URL(thumbnail.url).searchParams.get("stp") || "";
    const match = stp.match(/_[sp](\d+)x(\d+)/);
    return match ? Number(match[1]) : Infinity;
  } catch {
    return 0;
  }
}

function bestInstagramImage(entry) {
  const thumbnails = (entry.thumbnails || []).filter((thumbnail) => thumbnail.url);
  if (!thumbnails.length) return entry.thumbnail || null;
  return thumbnails.reduce((best, thumbnail) =>
    (instagramImageSize(thumbnail) >= instagramImageSize(best) ? thumbnail : best)).url;
}

function previewInstagramImage(entry) {
  const thumbnails = (entry.thumbnails || []).filter((thumbnail) => thumbnail.url);
  const medium = thumbnails.filter((thumbnail) => {
    const size = instagramImageSize(thumbnail);
    return size >= 480 && size <= 750;
  });
  return (medium.at(-1) || thumbnails.at(-1))?.url || entry.thumbnail || null;
}

function extensionForType(type) {
  return IMAGE_EXTENSIONS[String(type || "").split(";")[0].trim()] || ".jpg";
}

function cleanFolderName(value) {
  const name = String(value || "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  if (!name || WINDOWS_RESERVED_NAMES.test(name)) return null;
  return name;
}

// Tenta cada endereço na ordem (o primeiro é a melhor qualidade).
// untrusted: endereços que vieram de uma página qualquer (ou do botão de favoritos).
// Esses passam por fetchPublic (nada de rede local) e precisam responder uma imagem.
async function fetchGalleryMedia(urls, headers, { untrusted = false } = {}) {
  let lastStatus = 0;
  for (const url of [].concat(urls).filter(Boolean)) {
    let response;
    try {
      const requestHeaders = { "User-Agent": BROWSER_HEADERS["User-Agent"], ...headers };
      response = untrusted
        // Pede JPEG/PNG primeiro: sites que escolhem o formato pelo Accept (Unsplash,
        // Cloudflare...) mandariam AVIF/WebP, que muitos programas do Windows não abrem.
        ? await fetchPublic(url, { Accept: "image/jpeg,image/png,image/gif,image/*;q=0.8,*/*;q=0.5", ...requestHeaders })
        : await fetch(url, { headers: requestHeaders });
    } catch (error) {
      lastStatus = error.message;
      continue;
    }
    if (response.ok && response.body && (!untrusted || isImageResponse(response))) return response;
    lastStatus = response.status;
    await response.body?.cancel().catch(() => {});
  }
  throw Object.assign(new Error(`O site de origem respondeu ${lastStatus}.`), { status: lastStatus });
}

// SVG pode conter scripts; nas páginas genéricas só aceitamos imagens "de pixels".
function isImageResponse(response) {
  const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type === "image/svg+xml") return false;
  return type.startsWith("image/") || type === "application/octet-stream" || type === "binary/octet-stream" || !type;
}

// Lê a resposta inteira, mas desiste se passar do limite.
async function readLimited(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("Arquivo grande demais.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Resposta padrão de /api/info (qualidades para Baixar/Editar).
async function buildVideoInfo(url, info, response) {
  const formats = info.formats?.length ? info.formats : [info];
  const sizes = new Map();
  for (const format of formats) {
    const height = videoHeight(format);
    if (height < 144 || format.vcodec === "none" || sizes.has(height)) continue;
    sizes.set(height, Number(format.width || 0));
  }
  const resolutions = [...sizes]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map(([height, width]) => ({ height, width }));

  cacheVideoInfo(url, info);

  const thumbnail = [info.thumbnail, response.thumbnail, info.thumbnails?.at(-1)?.url]
    .find((value) => /^https?:\/\//.test(String(value || ""))) ||
    await captureThumbnail(info).catch(() => null);

  return {
    apiVersion: API_VERSION,
    title: info.title || response.title || "video",
    // Começo do nome do MP4 (o download acrescenta "-720p.mp4"); a extensão usa para
    // sugerir o nome na janela "Salvar como".
    fileBase: cleanFileName(fileTitleFor(info)),
    channel: info.channel || info.uploader || response.uploader || info.extractor_key,
    duration: info.duration || 0,
    thumbnail,
    resolutions,
    // Vídeo achado numa página comum (extrator genérico do yt-dlp): a página pode ter
    // imagens também, e a tela oferece "Baixar as imagens desta página".
    pageImages: [info.extractor_key, response.extractor_key].some((key) => /^(generic|html5mediaembed)$/i.test(String(key || "")))
  };
}

async function sendInstagramInfo(url, res) {
  try {
    // Sem "ignoreNoFormatsError" o yt-dlp recusa fotos ("There is no video in this post").
    const response = await youtubedl(url, {
      ...ytDlpBaseOptions,
      dumpSingleJson: true,
      ignoreNoFormatsError: true
    });
    const entries = response?._type === "playlist" ? (response.entries || []).filter(Boolean) : [response];
    if (!entries.length) throw new Error("Post sem mídias.");

    const items = entries.map((entry, index) => ({
      index,
      kind: entry.formats?.length ? "video" : "image",
      imageUrl: bestInstagramImage(entry),
      previewUrl: previewInstagramImage(entry),
      headers: { Referer: "https://www.instagram.com/", ...(entry.http_headers || {}) },
      duration: Number(entry.duration || 0)
    }));

    // Post com um vídeo só: fluxo normal (qualidades, Baixar e Editar).
    if (items.length === 1 && items[0].kind === "video") {
      return res.json(await buildVideoInfo(url, entries[0], response));
    }

    const meta = {
      ...entries[0],
      ...response,
      extractor_key: "Instagram",
      channel: response.channel || entries[0].channel,
      display_id: response.display_id || response.id || entries[0].display_id
    };
    cacheVideoInfo(url, meta);

    const author = response.channel || entries[0].channel;
    const caption = String(response.description || entries[0].description || "").split("\n")[0].trim();
    registerGallery(res, {
      url,
      source: "Instagram",
      title: caption || "Post do Instagram",
      channel: author ? `@${author}` : "Instagram",
      fileTitle: fileTitleFor(meta),
      items
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: "Não foi possível ler esse post. Ele pode ser privado, exigir login ou ter sido apagado."
    });
  }
}

function findGalleryItem(req, res) {
  const post = galleryPosts.get(req.params.key);
  if (!post) {
    res.status(404).json({ error: "Esse post expirou. Busque o link de novo.", code: "post_expired" });
    return null;
  }
  const item = post.items[Number(req.params.index)];
  if (!item) {
    res.status(404).json({ error: "Mídia não encontrada nesse post." });
    return null;
  }
  post.expiresAt = Date.now() + GALLERY_TTL_MS;
  return { post, item };
}

const fileUrlsOf = (item) => [item.imageUrl, ...(item.fallbackUrls || [])];

// Galerias cujos endereços vencem (o MangaDex troca de servidor a cada ~15 min)
// têm post.refresh; renovamos antes de usar e de novo se o download falhar.
async function refreshGallery(post, { force = false } = {}) {
  if (!post.refresh) return;
  if (!force && Date.now() - post.refreshedAt < 10 * 60 * 1000) return;
  if (!post.refreshing) {
    post.refreshing = post.refresh()
      .then(() => { post.refreshedAt = Date.now(); })
      .finally(() => { post.refreshing = null; });
  }
  await post.refreshing;
}

async function proxyGalleryImage(res, urls, headers, attachmentName, options) {
  const upstream = await fetchGalleryMedia(urls, headers, options);
  const type = upstream.headers.get("content-type") || "image/jpeg";
  res.setHeader("Content-Type", type);
  // Imagem servida pelo endereço do Clipora: nada dela pode rodar como página.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  const length = upstream.headers.get("content-length");
  if (length && !upstream.headers.get("content-encoding")) res.setHeader("Content-Length", length);
  if (attachmentName) {
    const name = `${attachmentName}${extensionForType(type)}`;
    res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  } else {
    res.setHeader("Cache-Control", "private, max-age=1800");
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

app.get(["/api/gallery/:key/:index/preview", "/api/instagram/:key/:index/preview"], async (req, res) => {
  const found = findGalleryItem(req, res);
  if (!found) return;
  try {
    await refreshGallery(found.post).catch(() => {});
    await proxyGalleryImage(res, [found.item.previewUrl, ...fileUrlsOf(found.item)], found.item.headers, null,
      { untrusted: found.post.untrusted });
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) res.status(502).json({ error: "O site de origem não entregou essa imagem." });
  }
});

app.get(["/api/gallery/:key/:index/file", "/api/instagram/:key/:index/file"], async (req, res) => {
  const found = findGalleryItem(req, res);
  if (!found) return;
  if (found.item.kind !== "image") {
    return res.status(409).json({ error: "Esse item é um vídeo; use o download de vídeo." });
  }
  const name = `${cleanFileName(found.post.fileTitle)}-${found.item.index + 1}`;
  const send = () => proxyGalleryImage(res, fileUrlsOf(found.item), found.item.headers, name,
    { untrusted: found.post.untrusted });
  try {
    await refreshGallery(found.post).catch(() => {});
    try {
      await send();
    } catch (error) {
      if (!found.post.refresh || res.headersSent) throw error;
      await refreshGallery(found.post, { force: true });
      await send();
    }
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) res.status(502).json({ error: "O site de origem não entregou essa imagem." });
  }
});

// Para onde vai a pasta: Área de Trabalho, Downloads ou uma pasta escolhida.
// O Clipora também pode ser aberto de outro PC pela rede (ex.: Tailscale). Gravar
// pastas, abrir o Explorer ou a janela de pastas só vale quando o navegador está neste
// mesmo computador; senão tudo aconteceria no disco e na tela do servidor.
// Pelo HTTPS do Tailscale ("tailscale serve", inclusive o serviço svc:clipora) todo pedido
// chega de 127.0.0.1, com cabeçalhos de proxy. O Tailscale escreve em X-Forwarded-For o IP
// do aparelho que pediu (e descarta o que o navegador tenha mandado nesse cabeçalho): se for
// um IP deste PC, o navegador está aqui; senão é outro PC.
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "tailscale-user-login"];

const cleanAddress = (value) => String(value || "").trim().replace(/^::ffff:/, "");
const isLoopback = (address) => address === "::1" || address.startsWith("127.");
const isOwnAddress = (address) =>
  Object.values(os.networkInterfaces()).flat().some((info) => info?.address === address);

function isLocalRequest(req) {
  const socketAddress = cleanAddress(req?.socket?.remoteAddress);
  // Endereço .ts.net (MagicDNS do Tailscale) só chega pelo "tailscale serve", mesmo se o
  // proxy não mandar os cabeçalhos acima.
  const host = String(req?.headers?.host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const proxied = host.endsWith(".ts.net") || PROXY_HEADERS.some((name) => req?.headers?.[name]);
  if (!proxied) return isLoopback(socketAddress) || isOwnAddress(socketAddress);
  // Só confiamos no X-Forwarded-For quando a conexão vem do próprio PC (o proxy do
  // Tailscale); um aparelho da rede local que forje o cabeçalho continua sendo outro PC.
  if (!isLoopback(socketAddress)) return false;
  const client = cleanAddress(String(req.headers["x-forwarded-for"] || "").split(",").pop());
  return Boolean(client) && (isLoopback(client) || isOwnAddress(client));
}

const OTHER_PC_MESSAGE = "Isso só funciona no computador onde o Clipora está rodando.";

async function resolveDestination(value) {
  const kind = value?.kind || "desktop";
  if (kind === "desktop") return DESKTOP_DIR;
  if (kind === "downloads") return DOWNLOADS_DIR;
  if (kind === "custom") {
    const raw = String(value.path || "").trim();
    if (!raw || !path.isAbsolute(raw)) return null;
    const resolved = path.resolve(raw);
    const stat = await fs.promises.stat(resolved).catch(() => null);
    return stat?.isDirectory() ? resolved : null;
  }
  return null;
}

app.post(["/api/gallery/:key/folder", "/api/instagram/:key/folder"], async (req, res) => {
  const post = galleryPosts.get(req.params.key);
  if (!post) return res.status(404).json({ error: "Esse post expirou. Busque o link de novo.", code: "post_expired" });
  const folderName = cleanFolderName(req.body?.folder);
  if (!folderName) return res.status(400).json({ error: "Escolha um nome de pasta válido." });
  // Navegador em outro PC: a pasta é montada nos temporários e vai como .zip (o destino
  // escolhido é ignorado, porque seria uma pasta do servidor).
  const delivery = isLocalRequest(req) ? "folder" : "zip";
  const destination = delivery === "zip" ? os.tmpdir() : await resolveDestination(req.body?.destination);
  if (!destination) {
    return res.status(400).json({ error: "A pasta de destino não existe mais. Escolha outra em \"Salvar em\"." });
  }

  // indices: quais mídias salvar, na ordem (a página manda as "N primeiras" visíveis).
  let items = post.items;
  if (Array.isArray(req.body?.indices)) {
    const seen = new Set();
    items = [];
    for (const value of req.body.indices.slice(0, MAX_PAGE_IMAGES)) {
      const index = Number(value);
      if (!Number.isInteger(index) || !post.items[index] || seen.has(index)) continue;
      seen.add(index);
      items.push(post.items[index]);
    }
    if (!items.length) return res.status(400).json({ error: "Escolha ao menos uma imagem." });
  }
  if (downloadJobs.size >= MAX_STORED_JOBS) {
    return res.status(429).json({ error: "Há muitos downloads pendentes. Tente novamente em instantes." });
  }

  post.expiresAt = Date.now() + GALLERY_TTL_MS;
  const id = crypto.randomUUID();
  const job = {
    id,
    operation: "gallery_folder",
    post,
    folderName,
    items,
    destination,
    delivery,
    status: "queued",
    phase: "Aguardando início",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPolledAt: Date.now(),
    process: null,
    tempDir: null
  };
  downloadJobs.set(id, job);
  downloadQueue.push(job);
  runDownloadQueue();
  res.status(202).json({ id });
});

// Abre no Explorer a pasta que o próprio Clipora acabou de criar.
app.post("/api/downloads/:id/open-folder", (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job?.savedPath) return res.status(404).json({ error: "Pasta não encontrada." });
  if (!isLocalRequest(req)) return res.status(403).json({ error: OTHER_PC_MESSAGE });
  spawn("explorer.exe", [job.savedPath], { detached: true, stdio: "ignore" }).unref();
  res.status(204).end();
});

async function createUniqueFolder(base, name) {
  await fs.promises.mkdir(base, { recursive: true });
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = path.join(base, attempt === 1 ? name : `${name} (${attempt})`);
    try {
      await fs.promises.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Não foi possível criar a pasta.");
}

const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const SAVE_CONCURRENCY = 4;

// Baixa uma imagem para a memória e descobre o tipo pelos primeiros bytes.
async function downloadGalleryImage(post, item) {
  const attempt = async () => {
    const started = Date.now();
    const upstream = await fetchGalleryMedia(fileUrlsOf(item), item.headers, { untrusted: post.untrusted });
    const buffer = await readLimited(upstream, MAX_IMAGE_BYTES);
    const sniffed = sniffImageExtension(buffer);
    if (post.untrusted && !sniffed) throw new Error("O endereço não entregou uma imagem.");
    post.report?.(upstream, buffer.length, Date.now() - started);
    return { buffer, ext: sniffed || extensionForType(upstream.headers.get("content-type")) };
  };
  await refreshGallery(post).catch(() => {});
  let refreshed = false;
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      // "Calma aí" do site (429/503): espera um pouco e tenta de novo, no máximo 2 vezes.
      if ([429, 503].includes(error.status) && retry < 2) {
        await new Promise((resolve) => setTimeout(resolve, retry ? 8000 : 3000));
        continue;
      }
      if (post.refresh && !refreshed) {
        refreshed = true;
        await refreshGallery(post, { force: true });
        continue;
      }
      throw error;
    }
  }
}

async function saveInstagramVideo(job, url, number, basePath) {
  await runYtDlpWithProgress(url, {
    playlistItems: String(number),
    format: "bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/bestvideo+bestaudio/best",
    mergeOutputFormat: "mp4",
    // "%" tem significado no modelo de nome do yt-dlp.
    output: `${basePath.replace(/%/g, "%%")}.%(ext)s`
  }, () => {}, (process) => { job.process = process; });
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

// .zip sem compressão (fotos e vídeos já vêm comprimidos), com nomes em UTF-8.
// zlib.crc32 exige Node 22+.
async function writeZip(zipPath, entries) {
  const handle = await fs.promises.open(zipPath, "w");
  const central = [];
  let offset = 0;
  const write = async (buffer) => {
    await handle.write(buffer);
    offset += buffer.length;
  };
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const stat = await fs.promises.stat(entry.filePath);
      if (offset + 30 + name.length + stat.size > 0xffffffff) throw new Error("A pasta ficou grande demais para um .zip.");
      let crc = 0;
      for await (const chunk of fs.createReadStream(entry.filePath)) crc = zlib.crc32(chunk, crc);
      const { time, date } = dosDateTime(stat.mtime);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // nomes em UTF-8
      header.writeUInt16LE(0, 8); // sem compressão
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(stat.size, 18);
      header.writeUInt32LE(stat.size, 22);
      header.writeUInt16LE(name.length, 26);
      central.push({ name, crc, size: stat.size, time, date, offset });
      await write(header);
      await write(name);
      for await (const chunk of fs.createReadStream(entry.filePath)) await write(chunk);
    }
    const centralStart = offset;
    for (const file of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(file.time, 12);
      record.writeUInt16LE(file.date, 14);
      record.writeUInt32LE(file.crc, 16);
      record.writeUInt32LE(file.size, 20);
      record.writeUInt32LE(file.size, 24);
      record.writeUInt16LE(file.name.length, 28);
      record.writeUInt32LE(file.offset, 42);
      await write(record);
      await write(file.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await write(end);
  } finally {
    await handle.close();
  }
}

// Salva as mídias escolhidas em <destino>\<pasta>, como <pasta>1, <pasta>2...
// As imagens são baixadas 4 por vez, mas gravadas na ordem; uma que falhar é pulada
// (a numeração continua sem buracos) e entra na contagem de falhas.
// delivery "zip" (navegador em outro PC): a pasta é montada nos temporários e entregue
// como <pasta>.zip, que o próprio navegador baixa.
async function processGalleryFolderJob(job) {
  const { post, folderName, items, destination } = job;
  const asZip = job.delivery === "zip";
  let target = null;
  try {
    if (asZip) {
      job.tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clipora-zip-"));
      target = path.join(job.tempDir, folderName);
      await fs.promises.mkdir(target);
      updateJob(job, { status: "downloading", phase: "Preparando os arquivos", progress: 1, savedFolder: folderName });
    } else {
      target = await createUniqueFolder(destination, folderName);
      updateJob(job, { status: "downloading", phase: "Criando a pasta", progress: 1, savedPath: target, savedFolder: path.basename(target) });
    }
    const total = items.length;
    // Nome que já termina em número ganha um hífen: "cap 12" -> "cap 12-1", não "cap 121".
    const separator = /\d$/.test(folderName) ? "-" : "";
    let saved = 0;
    let failed = 0;
    let done = 0;
    const report = () => updateJob(job, {
      phase: `Salvando ${Math.min(done + 1, total)} de ${total}${failed ? ` (${failed} com falha)` : ""}`,
      progress: Math.max(1, Math.round((done / total) * 100))
    });

    for (let start = 0; start < total; start += SAVE_CONCURRENCY) {
      if (job.status === "cancelled") return;
      report();
      const chunk = items.slice(start, start + SAVE_CONCURRENCY);
      const images = await Promise.allSettled(chunk.map((item) =>
        item.kind === "image" ? downloadGalleryImage(post, item) : Promise.resolve(null)));
      for (const [position, item] of chunk.entries()) {
        if (job.status === "cancelled") return;
        const basePath = path.join(target, `${folderName}${separator}${saved + 1}`);
        try {
          if (item.kind === "image") {
            const result = images[position];
            if (result.status === "rejected") throw result.reason;
            await fs.promises.writeFile(`${basePath}${result.value.ext}`, result.value.buffer);
          } else {
            await saveInstagramVideo(job, post.url, item.index + 1, basePath);
          }
          saved += 1;
        } catch (error) {
          failed += 1;
          console.error(`Falha ao salvar a mídia ${item.index + 1}: ${error.message}`);
        }
        done += 1;
        report();
      }
    }

    if (!saved) {
      await fs.promises.rmdir(target).catch(() => {});
      throw new Error("Nenhuma mídia foi salva.");
    }
    if (asZip) {
      updateJob(job, { phase: "Compactando a pasta", progress: 99 });
      const zipPath = path.join(job.tempDir, `${folderName}.zip`);
      const files = (await fs.promises.readdir(target)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      await writeZip(zipPath, files.map((file) => ({ name: `${folderName}/${file}`, filePath: path.join(target, file) })));
      if (job.status === "cancelled") return;
      updateJob(job, {
        status: "ready",
        phase: `${saved} ${saved === 1 ? "arquivo pronto" : "arquivos prontos"} em ${folderName}.zip${failed ? ` (${failed} com falha)` : ""}`,
        progress: 100,
        savedCount: saved,
        failedCount: failed,
        filePath: zipPath,
        fileSize: (await fs.promises.stat(zipPath)).size,
        contentType: "application/zip",
        downloadName: `${folderName}.zip`,
        expiresAt: Date.now() + DOWNLOAD_TTL_MS
      });
      return;
    }
    const noun = saved === 1 ? "arquivo salvo" : "arquivos salvos";
    updateJob(job, {
      status: "saved",
      phase: `${saved} ${noun} em ${path.basename(target)}${failed ? ` (${failed} com falha)` : ""}`,
      progress: 100,
      savedCount: saved,
      failedCount: failed,
      expiresAt: Date.now() + EDITOR_TTL_MS
    });
  } catch (error) {
    console.error(error.message);
    if (asZip) await removeJobFiles(job);
    if (job.status !== "cancelled") {
      updateJob(job, {
        status: "error",
        phase: "Falha ao salvar a pasta",
        error: target
          ? "Nenhuma imagem pôde ser baixada. O site pode ter bloqueado o acesso ou os links expiraram; busque a página de novo."
          : "Não foi possível criar a pasta no destino escolhido.",
        expiresAt: Date.now() + 5 * 60 * 1000
      });
    }
  } finally {
    job.process = null;
  }
}

// ---------- Galerias de outras fontes: DeviantArt e ArtStation ----------

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
};

function hostOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isDeviantArtUrl(value) {
  const host = hostOf(value);
  return host === "deviantart.com" || host.endsWith(".deviantart.com") || host === "fav.me";
}

function isArtStationUrl(value) {
  const host = hostOf(value);
  return host === "artstation.com" || host.endsWith(".artstation.com");
}

// Guarda a galeria no servidor e responde no mesmo formato para qualquer fonte.
// page: galeria de uma página inteira (muitas imagens, seletor de quantidade).
// untrusted: endereços vindos de uma página qualquer (ver fetchGalleryMedia).
// refresh: renova endereços que vencem (MangaDex).
function registerGallery(res, {
  url, source, title, channel, fileTitle, notes = [], items,
  page = false, untrusted = false, suggestedFolder = "", refresh = null, report = null
}) {
  if (galleryPosts.size >= MAX_GALLERY_POSTS) galleryPosts.delete(galleryPosts.keys().next().value);
  const key = crypto.randomUUID();
  galleryPosts.set(key, {
    url, source, fileTitle, items, untrusted, refresh, report,
    refreshedAt: Date.now(),
    expiresAt: Date.now() + GALLERY_TTL_MS
  });
  const shortTitle = String(title || "").trim();
  res.json({
    apiVersion: API_VERSION,
    gallery: true,
    page,
    key,
    source,
    title: shortTitle.length > 140 ? `${shortTitle.slice(0, 137)}...` : shortTitle || `Post do ${source}`,
    channel,
    notes,
    suggestedFolder: cleanFolderName(suggestedFolder) || "",
    // "server": o servidor grava as pastas neste PC. "browser": o navegador está em outro
    // PC e salva ele mesmo (numa pasta escolhida, se o navegador deixar, ou num .zip).
    saveMode: isLocalRequest(res.req) ? "server" : "browser",
    items: items.map((item) => ({
      index: item.index,
      kind: item.kind,
      duration: item.duration || 0,
      caption: item.caption || "",
      small: Boolean(item.small),
      preview: `/api/gallery/${key}/${item.index}/preview`
    }))
  });
}

// ----- DeviantArt -----

function decodeDeviantArtToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    const limits = payload.obj?.[0]?.[0] || {};
    const number = (text) => Number(String(text || "").replace(/[^\d]/g, "")) || 0;
    return {
      audience: [].concat(payload.aud || []).join(","),
      maxWidth: number(limits.width),
      maxHeight: number(limits.height),
      watermark: Boolean(payload.wmk)
    };
  } catch {
    return { audience: "", maxWidth: 0, maxHeight: 0, watermark: false };
  }
}

// O DeviantArt assina cada imagem com tokens que dizem até que tamanho ela pode ser
// servida. Usamos sempre o maior que o próprio token libera: o arquivo original quando
// o artista permite download; senão a maior versão pública (com marca d'água, se o
// artista escolheu assim). Conteúdo pago e originais restritos não são contornados.
function bestDeviantArtImage(deviation, originalFile) {
  const media = deviation.media || {};
  const base = media.baseUri;
  const tokens = media.token || [];
  const decoded = tokens.map(decodeDeviantArtToken);
  const withToken = (path, token) => `${base}${path}${token ? `?token=${token}` : ""}`;

  const downloadIndex = decoded.findIndex((info) => info.audience.includes("file.download"));
  if (downloadIndex >= 0) {
    return {
      url: withToken("", tokens[downloadIndex]),
      width: originalFile?.width,
      height: originalFile?.height,
      original: true
    };
  }

  const fullview = (media.types || []).find((type) => type.t === "fullview");
  const view = decoded[0] || {};
  if (!fullview?.c) {
    return { url: withToken("", tokens[0]), width: fullview?.w, height: fullview?.h, original: true, watermark: view.watermark };
  }
  const path = fullview.c.replace("<prettyName>", media.prettyName).replace(/q_\d+/, "q_100");
  return { url: withToken(path, tokens[0]), width: fullview.w, height: fullview.h, original: false, watermark: view.watermark };
}

function previewDeviantArtImage(deviation, fallback) {
  const media = deviation.media || {};
  const type = (media.types || []).find((item) => item.t === "414W" && item.c) ||
    (media.types || []).find((item) => item.t === "375W" && item.c);
  if (!type) return fallback;
  const token = (media.token || [])[0];
  return `${media.baseUri}${type.c.replace("<prettyName>", media.prettyName)}${token ? `?token=${token}` : ""}`;
}

async function fetchDeviantArtState(url) {
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!response.ok) throw new Error(`O DeviantArt respondeu ${response.status}.`);
  const html = await response.text();
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\)/);
  if (!match) throw new Error("A página não trouxe os dados da obra.");
  // O conteúdo é uma string JavaScript: \' vale nela, mas não em JSON.
  const state = JSON.parse(JSON.parse(`"${match[1].replace(/\\'/g, "'")}"`));
  return { state, finalUrl: response.url || url };
}

async function sendDeviantArtInfo(url, res) {
  try {
    const { state, finalUrl } = await fetchDeviantArtState(url);
    const entities = state["@@entities"] || {};
    const deviations = entities.deviation || {};
    const wantedId = String(new URL(finalUrl).pathname.match(/-(\d+)\/?$/)?.[1] || "");
    const id = deviations[wantedId] ? wantedId : Object.keys(deviations)[0];
    const deviation = deviations[id];
    if (!deviation) throw new Error("Obra não encontrada na página.");
    if (deviation.type !== "image" || !deviation.media?.baseUri) {
      return res.status(422).json({ error: "Essa obra do DeviantArt não é uma imagem (pode ser texto ou vídeo)." });
    }

    const extended = (entities.deviationExtended || {})[id] || {};
    const author = (entities.user || {})[deviation.author] || {};
    const best = bestDeviantArtImage(deviation, extended.originalFile);
    const original = extended.originalFile;
    const size = best.width && best.height ? `${best.width} × ${best.height}` : "";

    const notes = [];
    if (extended.pcp) {
      notes.push(`Conteúdo pago: o DeviantArt só libera a prévia pública${size ? ` (${size})` : ""}.`);
    } else if (!best.original && original?.width) {
      notes.push(`O artista limita a versão pública a ${size}${best.watermark ? " com marca d'água" : ""}; o original tem ${original.width} × ${original.height}.`);
    } else if (best.original) {
      notes.push("Arquivo original liberado pelo artista.");
    }

    const item = {
      index: 0,
      kind: "image",
      imageUrl: best.url,
      previewUrl: previewDeviantArtImage(deviation, best.url),
      headers: { Referer: "https://www.deviantart.com/" },
      caption: [size, best.original ? "original" : ""].filter(Boolean).join(" · ")
    };
    const username = author.username || "deviantart";
    registerGallery(res, {
      url,
      source: "DeviantArt",
      title: deviation.title,
      channel: `@${username}`,
      fileTitle: `${username}-${id}`,
      notes,
      items: [item]
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: "Não foi possível ler essa obra do DeviantArt. Ela pode ser privada, adulta (exige login) ou ter sido apagada."
    });
  }
}

// ----- ArtStation -----

const ARTSTATION_CDN = /^cdn[a-z]?\.artstation\.com$/;

function artStationHash(value) {
  try {
    return new URL(value).pathname.match(/\/(?:artwork|projects)\/([A-Za-z0-9]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function artStationVariant(url, size) {
  return url.replace(/\/(large|4k|medium|small|smaller_square|micro_square)\//, `/${size}/`);
}

// Só aceitamos imagens do servidor de imagens do ArtStation.
function isArtStationImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ARTSTATION_CDN.test(url.hostname) && url.pathname.startsWith("/p/assets/");
  } catch {
    return false;
  }
}

function buildArtStationGallery(res, { url, hash, title, username, assets }) {
  const images = (assets || []).filter((asset) => isArtStationImage(asset.url)).slice(0, 100);
  if (!images.length) {
    return res.status(422).json({ error: "Essa obra do ArtStation não tem imagens para baixar." });
  }
  const items = images.map((asset, index) => ({
    index,
    kind: "image",
    // 4K é a maior versão pública; quando ela não existe, cai para a "large".
    imageUrl: artStationVariant(asset.url, "4k"),
    fallbackUrls: [artStationVariant(asset.url, "large")],
    previewUrl: artStationVariant(asset.url, "small"),
    headers: { Referer: "https://www.artstation.com/" },
    caption: asset.width && asset.height ? `original ${asset.width} × ${asset.height}` : ""
  }));
  const handle = String(username || "artstation").replace(/[^\w.-]/g, "") || "artstation";
  registerGallery(res, {
    url,
    source: "ArtStation",
    title,
    channel: `@${handle}`,
    fileTitle: `${handle}-${hash}`,
    notes: ["Cada imagem é baixada na versão 4K do ArtStation (ou na maior disponível)."],
    items
  });
}

// O ArtStation protege a página e a API com a Cloudflare. Fazemos um pedido comum;
// se ele for barrado, a página oferece o botão "Enviar ao Clipora", que lê a obra
// pelo navegador do próprio usuário. Não tentamos contornar a proteção.
async function sendArtStationInfo(url, res) {
  const hash = artStationHash(url);
  if (!hash) {
    return res.status(400).json({ error: "Cole o link de uma obra do ArtStation (endereço com /artwork/...)." });
  }
  try {
    const response = await fetch(`https://www.artstation.com/projects/${hash}.json`, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" }
    });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.includes("application/json")) {
      return res.status(409).json({
        error: "O ArtStation não deixa o Clipora ler a obra direto. Abra a obra no navegador e clique no ícone da extensão do Clipora.",
        code: "artstation_blocked",
        hash
      });
    }
    const project = await response.json();
    buildArtStationGallery(res, {
      url,
      hash,
      title: project.title,
      username: project.user?.username,
      assets: (project.assets || [])
        .filter((asset) => asset.has_image && asset.asset_type === "image")
        .map((asset) => ({ url: asset.image_url, width: asset.width, height: asset.height }))
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "Não foi possível ler essa obra do ArtStation agora." });
  }
}

// ---------- Páginas inteiras: todas as imagens de uma página ----------
//
// Dois caminhos levam à mesma galeria (com seletor de quantidade):
//  1. Colar o link: o servidor lê a página sozinho (MangaDex pela API oficial;
//     páginas comuns lendo o HTML).
//  2. Botão de favoritos "Enviar ao Clipora" (public/js/coletor.js): roda na página,
//     no navegador do usuário (X, Instagram, Reddit, páginas com login ou que
//     carregam as imagens aos poucos) e manda a lista para POST /api/gallery/import.
// Nenhum dos dois contorna login, Cloudflare ou outra proteção.

const MAX_PAGE_IMAGES = 5000;
const MAX_PAGE_HTML_BYTES = 8 * 1024 * 1024;
// Ícones, avatares, emojis e logotipos: lado maior abaixo de 100 px ou um lado bem fino.
const isSmallSize = (width, height) => Math.max(width, height) < 100 || Math.min(width, height) < 48;
const MAX_SIZE_PROBES = 300;

// ----- Rede: endereços de páginas quaisquer nunca podem apontar para a rede local -----

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const value = String(address).toLowerCase();
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  return value === "::" || value === "::1" || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff");
}

// Só para testes com páginas servidas no próprio PC.
const ALLOW_PRIVATE_HOSTS = process.env.CLIPORA_ALLOW_PRIVATE_HOSTS === "1";
const hostChecks = new Map();

async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Endereço não suportado.");
  if (ALLOW_PRIVATE_HOSTS) return;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) {
    throw new Error("Endereço da rede local.");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Endereço da rede local.");
    return;
  }
  let check = hostChecks.get(host);
  if (!check || check.expiresAt < Date.now()) {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    check = {
      ok: addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address)),
      expiresAt: Date.now() + 10 * 60 * 1000
    };
    if (hostChecks.size > 500) hostChecks.clear();
    hostChecks.set(host, check);
  }
  if (!check.ok) throw new Error("Endereço da rede local.");
}

// fetch para endereços vindos de páginas: segue os redirecionamentos um a um,
// conferindo cada destino. response.finalUrl guarda o endereço final.
async function fetchPublic(value, headers, { timeoutMs = 60000 } = {}) {
  let current = value;
  for (let hop = 0; hop <= 5; hop += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      current = new URL(location, current).href;
      continue;
    }
    response.finalUrl = current;
    return response;
  }
  throw new Error("Redirecionamentos demais.");
}

// Lê só o começo (para descobrir o tamanho da imagem) e larga o resto.
async function readStart(response, bytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks);
}

// ----- Tipo e tamanho da imagem pelos primeiros bytes -----

function sniffImageExtension(buffer) {
  const b = buffer;
  if (!b || b.length < 12) return null;
  const ascii = (start, end) => b.toString("latin1", start, end);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return ".png";
  if (ascii(0, 4) === "GIF8") return ".gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(4, 8) === "ftyp") {
    const brands = ascii(8, Math.min(b.length, 48));
    if (brands.includes("avif") || brands.includes("avis")) return ".avif";
    if (/heic|heix|hevc|mif1|msf1/.test(brands)) return ".heic";
  }
  if (ascii(0, 2) === "BM") return ".bmp";
  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return ".tif";
  return null;
}

function imageDimensions(buffer) {
  const b = buffer;
  if (!b || b.length < 26) return null;
  const ascii = (start, end) => b.toString("latin1", start, end);
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (ascii(0, 4) === "GIF8") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" && b.length >= 30) {
    const chunk = ascii(12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) { offset += 1; continue; }
      const marker = b[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(offset + 7), height: b.readUInt16BE(offset + 5) };
      }
      offset += 2 + b.readUInt16BE(offset + 2);
    }
    return null;
  }
  if (ascii(4, 8) === "ftyp") {
    const ispe = b.indexOf("ispe");
    if (ispe > 0 && ispe + 16 <= b.length) return { width: b.readUInt32BE(ispe + 8), height: b.readUInt32BE(ispe + 12) };
  }
  if (ascii(0, 2) === "BM") return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  return null;
}

// ----- Endereços de imagem: limpeza, versão maior e regras por site -----

const PAGE_IMAGE_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp)$/i;
const SKIPPED_IMAGE_EXT = /\.(svg|svgz|ico|cur)$/i;
// Rastreadores, anúncios e avisos de cookies (logotipos que não são conteúdo da página).
const SKIPPED_IMAGE_HOSTS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|facebook\.com|scorecardresearch\.com|quantserve\.com|adsrvr\.org|amazon-adsystem\.com|pixel\.wp\.com|cookielaw\.org|onetrust\.com|cookiebot\.com|consensu\.org|trustarc\.com|usercentrics\.eu)$/;

function cleanImageUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.href.length > 4096) return null;
    url.hash = "";
    if (SKIPPED_IMAGE_EXT.test(url.pathname) || SKIPPED_IMAGE_HOSTS.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Para cada imagem: a lista de endereços a tentar (maior qualidade primeiro; o
// endereço encontrado na página é sempre a última reserva) e a miniatura.
function imageVariants(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const result = (better, preview = value) => ({ file: [...new Set([...better, value])], preview });

  // X: a mesma foto em vários tamanhos; "orig" é o arquivo que o autor enviou.
  if (host === "pbs.twimg.com") {
    const match = url.pathname.match(/^\/media\/([^./:]+)(?:\.(\w+))?/);
    if (match) {
      const format = url.searchParams.get("format") || match[2] || "jpg";
      const base = `https://pbs.twimg.com/media/${match[1]}?format=${format}&name=`;
      return result([`${base}orig`, `${base}4096x4096`, `${base}large`], `${base}small`);
    }
  }
  // Reddit: a prévia (preview.redd.it) corresponde ao arquivo original em i.redd.it.
  if (host === "preview.redd.it") {
    const name = url.pathname.split("/").pop() || "";
    const id = name.includes("-v0-") ? name.split("-v0-").pop() : name;
    if (/^\w+\.(jpe?g|png|gif|webp)$/i.test(id)) return result([`https://i.redd.it/${id}`]);
  }
  // Pinterest: /236x/, /474x/, /736x/ -> /originals/.
  if (host === "i.pinimg.com") {
    const match = url.pathname.match(/^\/(?:\d+x\d*(?:_RS)?|originals)(\/.+)$/);
    if (match) return result([`https://i.pinimg.com/originals${match[1]}`, `https://i.pinimg.com/736x${match[1]}`]);
  }
  // Wikimedia: .../thumb/a/ab/Foto.jpg/320px-Foto.jpg -> .../a/ab/Foto.jpg
  // (as miniaturas vêm de upload.wikimedia.org ou de thumb.wikimedia.org).
  if (host === "upload.wikimedia.org" || host === "thumb.wikimedia.org") {
    const match = url.pathname.match(/^(.*)\/thumb\/(.+?\/[^/]+)\/[^/]+$/);
    if (match) return result([`https://upload.wikimedia.org${match[1]}/${match[2]}`]);
  }
  // Blogger (comum em sites de leitura): /s1600/ ou =w640-h360 -> tamanho original (s0).
  if (host === "blogger.googleusercontent.com" || host.endsWith(".bp.blogspot.com")) {
    const resized = value
      .replace(/\/[swh]\d+(?:-[a-z0-9-]+)?\/(?=[^/]+$)/i, "/s0/")
      .replace(/=[swh]\d+[^/]*$/i, "=s0");
    if (resized !== value) return result([resized]);
  }
  // WordPress e parecidos: foto-300x200.jpg -> foto.jpg (se não existir, fica a da página).
  const sized = url.pathname.match(/^(.+)-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp|gif))$/i);
  if (sized) {
    const original = new URL(value);
    original.pathname = `${sized[1]}${sized[2]}`;
    original.search = "";
    return result([original.href]);
  }
  return result([]);
}

function siteOfPage(pageUrl) {
  const host = hostOf(pageUrl);
  const is = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (is("x.com") || is("twitter.com")) return "X";
  if (is("instagram.com")) return "Instagram";
  if (is("reddit.com")) return "Reddit";
  return host || "página";
}

// O que conta como "imagem da página" em cada site (sem avatares, ícones, emojis).
function pageImageFilter(site) {
  if (site === "X") return (url) => /^https:\/\/pbs\.twimg\.com\/media\//.test(url);
  if (site === "Instagram") {
    return (url) => /(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(hostOf(url)) && !/\/t51\.\d+-19\//.test(url);
  }
  if (site === "Reddit") {
    return (url) => !/(^|\.)redditstatic\.com$/.test(hostOf(url)) && hostOf(url) !== "styles.redditmedia.com" &&
      !/\/(snoovatar|avatars?|emotes?|communityIcon)/i.test(url);
  }
  return () => true;
}

// Caminho com ":" (File:, Arquivo:, Ficheiro:...) é página do MediaWiki, não imagem.
function looksLikePageLink(value) {
  try {
    return decodeURIComponent(new URL(value).pathname).includes(":");
  } catch {
    return false;
  }
}

// rawItems: [{ url, width, height, preview }] na ordem da página.
function buildPageItems(rawItems, pageUrl) {
  const site = siteOfPage(pageUrl);
  const keep = pageImageFilter(site);
  // No X só sobram fotos de posts: nenhuma é ícone, não precisa medir.
  const allContent = site === "X";
  let referer;
  try { referer = `${new URL(pageUrl).origin}/`; } catch { referer = undefined; }
  const seen = new Set();
  const items = [];
  for (const raw of rawItems) {
    if (items.length >= MAX_PAGE_IMAGES) break;
    // url: a melhor versão achada (às vezes o link em volta da miniatura);
    // preview: a imagem que a página mostrava. Links como /wiki/File:Foto.jpg (MediaWiki)
    // terminam em .jpg mas são páginas: nesse caso a imagem mostrada vira a principal.
    const candidates = [cleanImageUrl(raw?.url), cleanImageUrl(raw?.preview)].filter(Boolean);
    const primary = candidates.find((candidate) => !looksLikePageLink(candidate));
    if (!primary || !keep(primary)) continue;
    const variants = imageVariants(primary);
    const others = candidates.filter((candidate) => candidate !== primary).flatMap((candidate) => imageVariants(candidate).file);
    const [imageUrl, ...fallbackUrls] = [...new Set([...variants.file, ...others])];
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    const width = Math.max(0, Math.round(Number(raw.width) || 0));
    const height = Math.max(0, Math.round(Number(raw.height) || 0));
    const known = width > 0 && height > 0;
    items.push({
      index: items.length,
      kind: "image",
      imageUrl,
      fallbackUrls,
      previewUrl: (!allContent && cleanImageUrl(raw.preview)) || variants.preview,
      headers: referer ? { Referer: referer } : {},
      small: !allContent && known && isSmallSize(width, height),
      sized: allContent || known
    });
  }
  return items;
}

// Mede as imagens sem tamanho conhecido (lendo só o começo de cada uma) para
// separar ícones e avatares. Limite de quantidade e de tempo.
async function probePageSizes(items) {
  const pending = items.filter((item) => !item.sized).slice(0, MAX_SIZE_PROBES);
  const deadline = Date.now() + 15000;
  let next = 0;
  const worker = async () => {
    while (next < pending.length && Date.now() < deadline) {
      const item = pending[next++];
      try {
        const response = await fetchGalleryMedia([item.previewUrl, ...fileUrlsOf(item)],
          { ...item.headers, Range: "bytes=0-131071" }, { untrusted: true });
        const size = imageDimensions(await readStart(response, 131072));
        if (size) {
          item.small = isSmallSize(size.width, size.height);
          item.sized = true;
        }
      } catch {
        // Sem medida: a imagem continua na galeria; se não carregar, a página a esconde.
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

function suggestFolderName(pageUrl, title, site) {
  try {
    const parts = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if ((site === "X" || site === "Instagram") && parts[0] && !["i", "explore", "search", "home", "hashtag"].includes(parts[0])) {
      return parts[0];
    }
    if (site === "Reddit") {
      if (parts[0] === "r" && parts[1]) return `r-${parts[1]}`;
      if ((parts[0] === "user" || parts[0] === "u") && parts[1]) return `u-${parts[1]}`;
    }
  } catch {
    // usa o título
  }
  // "Capítulo 5 - Nome do Site" -> "Capítulo 5"; caracteres proibidos em pastas viram espaço.
  const parts = String(title || "").split(/\s+[-|–—·]\s+/);
  const main = parts.length > 1 && parts.at(-1).length <= 40 ? parts.slice(0, -1).join(" - ") : String(title || "");
  return (main.replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim() || site || "imagens").slice(0, 60);
}

function registerPageGallery(res, { url, title, items, notes = [] }) {
  const site = siteOfPage(url);
  const folder = suggestFolderName(url, title, site);
  registerGallery(res, {
    url,
    source: site,
    title: title || url,
    channel: hostOf(url),
    fileTitle: cleanFileName(folder).slice(0, 60) || "imagens",
    notes,
    items,
    page: true,
    untrusted: true,
    suggestedFolder: folder
  });
}

// ----- Ler o HTML de uma página comum -----

function decodeEntities(text) {
  const named = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " };
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, code) => {
    const lower = code.toLowerCase();
    if (lower[0] !== "#") return named[lower];
    const number = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}

function parseAttributes(text) {
  const attributes = {};
  for (const match of String(text || "").matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!(name in attributes)) attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

// "a.jpg 1x, b.jpg 2x" / "a.jpg 400w, b.jpg 1200w" -> o maior candidato.
function largestFromSrcset(value) {
  if (!value) return null;
  let best = null;
  let bestScore = -1;
  for (const part of String(value).split(/,\s+(?=\S)|,(?=https?:\/\/|\/)/)) {
    const [url, descriptor = "1x"] = part.trim().split(/\s+/);
    const amount = parseFloat(descriptor) || 1;
    const score = /w$/i.test(descriptor) ? amount : amount * 1000;
    if (url && score > bestScore) {
      best = url;
      bestScore = score;
    }
  }
  return best;
}

const LAZY_IMAGE_ATTRIBUTES = [
  "data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-hi-res-src", "data-full",
  "data-full-url", "data-zoom-image", "data-large_image", "data-orig-file", "data-large-file", "data-cfsrc",
  "data-pagespeed-lazy-src"
];

// Imagens na ordem do HTML: <img> (srcset, atributos de carregamento tardio, link
// em volta para a versão grande), <picture><source>, links diretos para imagens e
// fundos em style="...url()". As do og:image só valem se não houver outras.
function extractPageImages(html, pageUrl) {
  const text = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  let base = pageUrl;
  const baseTag = text.match(/<base\b([^>]*)>/i);
  if (baseTag) {
    try {
      const href = parseAttributes(baseTag[1]).href;
      if (href) base = new URL(href, pageUrl).href;
    } catch {
      // mantém o endereço da página
    }
  }
  const resolve = (value) => {
    const raw = String(value || "").trim();
    if (!raw || /^(data|blob|javascript|about):/i.test(raw)) return null;
    try {
      const url = new URL(raw, base);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const isImageLink = (href) => {
    try { return PAGE_IMAGE_EXT.test(new URL(href).pathname); } catch { return false; }
  };

  const found = [];
  const meta = [];
  let anchor = null;
  const closeAnchor = () => {
    if (anchor && !anchor.used) found.push({ url: anchor.href });
    anchor = null;
  };

  for (const match of text.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (tag === "a") {
      closeAnchor();
      if (!closing) {
        const href = resolve(parseAttributes(match[3]).href);
        anchor = href && isImageLink(href) ? { href, used: false } : null;
      }
      continue;
    }
    if (closing) continue;
    if (!["img", "source", "meta", "link"].includes(tag) && !/url\(/i.test(match[3])) continue;
    const attributes = parseAttributes(match[3]);

    if (tag === "img") {
      const width = Number(attributes.width);
      const height = Number(attributes.height);
      // Tamanho declarado no HTML: pixel de rastreio/ícone some; o resto serve de medida
      // (evita baixar o começo de cada imagem só para medir).
      if (width && height && Math.max(width, height) < 48) continue;
      const size = width > 0 && height > 0 ? { width, height } : {};
      const lazy = LAZY_IMAGE_ATTRIBUTES.map((name) => attributes[name]).find((value) => value && !/^data:/i.test(value));
      const best = [
        largestFromSrcset(attributes["data-srcset"] || attributes["data-lazy-srcset"]),
        largestFromSrcset(attributes.srcset),
        lazy,
        attributes.src
      ].map(resolve).find(Boolean);
      if (!best) continue;
      const shown = resolve(attributes.src) || best;
      if (anchor && !anchor.used) {
        found.push({ url: anchor.href, preview: shown, ...size });
        anchor.used = true;
      } else {
        found.push({ url: best, preview: shown !== best ? shown : undefined, ...size });
      }
    } else if (tag === "source") {
      const best = resolve(largestFromSrcset(attributes.srcset || attributes["data-srcset"]));
      if (best) found.push({ url: best });
    } else if (tag === "meta") {
      const key = String(attributes.property || attributes.name || "").toLowerCase();
      if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) {
        const url = resolve(attributes.content);
        if (url) meta.push({ url });
      }
    } else if (tag === "link" && /\bimage_src\b/i.test(attributes.rel || "")) {
      const url = resolve(attributes.href);
      if (url) meta.push({ url });
    }

    if (attributes.style && /url\(/i.test(attributes.style)) {
      for (const css of attributes.style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        const url = resolve(css[2]);
        if (url) found.push({ url });
      }
    }
  }
  closeAnchor();
  return found.length ? found : meta;
}

function pageTitle(html) {
  const metas = [...String(html).matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)].map((match) => parseAttributes(match[1]));
  const og = metas.find((attributes) => String(attributes.property || attributes.name || "").toLowerCase() === "og:title");
  const raw = og?.content || String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  return decodeEntities(raw).replace(/\s+/g, " ").trim().slice(0, 200);
}

async function fetchPageHtml(url) {
  const response = await fetchPublic(url, BROWSER_HEADERS, { timeoutMs: 30000 });
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if ([401, 403, 429, 503].includes(response.status) || response.headers.get("cf-mitigated")) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`Página bloqueada (${response.status}).`), { blocked: true });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`O site respondeu ${response.status}.`);
  }
  // Link direto para uma imagem: vira uma galeria com ela.
  if (type.startsWith("image/") && type !== "image/svg+xml") {
    await response.body?.cancel().catch(() => {});
    return { imageUrl: response.finalUrl || url };
  }
  if (!/html|xml/.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("O link não é uma página.");
  }
  const html = (await readLimited(response, MAX_PAGE_HTML_BYTES)).toString("utf8");
  return { html, finalUrl: response.finalUrl || url };
}

const BROWSER_HELP = {
  X: "O X só mostra as imagens de um perfil para quem está logado, então o Clipora não consegue ler essa página sozinho. Abra a página no seu navegador (por exemplo, a aba Mídia do perfil) e clique no ícone da extensão do Clipora.",
  XPost: "O Clipora não achou vídeo nesse post do X (ou ele exige login). Para baixar as imagens, abra o post no navegador e clique no ícone da extensão do Clipora.",
  Instagram: "O Instagram só mostra os perfis para quem está logado. Abra o perfil no navegador e clique no ícone da extensão do Clipora. Para um post específico, cole o link do post.",
  Reddit: "O Reddit bloqueia leituras automáticas. Abra a página no navegador (subreddit, perfil ou post) e clique no ícone da extensão do Clipora.",
  RedditPost: "O Clipora não achou vídeo nesse post do Reddit. Para baixar as imagens, abra o post no navegador e clique no ícone da extensão do Clipora.",
  default: "Esse site não deixou o Clipora ler a página (ela pode exigir login ou carregar as imagens aos poucos). Abra a página no navegador e clique no ícone da extensão do Clipora."
};

function needsBrowser(res, site, message) {
  res.status(409).json({
    error: message || BROWSER_HELP[site] || BROWSER_HELP.default,
    code: "needs_browser",
    site: { XPost: "X", RedditPost: "Reddit" }[site] || site
  });
}

async function sendGenericPageInfo(url, res) {
  let page;
  try {
    page = await fetchPageHtml(url);
  } catch (error) {
    console.error(error.message);
    if (error.blocked) return needsBrowser(res, "default");
    return res.status(502).json({
      error: "Não foi possível ler esse link. Ele pode ser privado, exigir login ou o site pode não ser suportado."
    });
  }
  if (page.imageUrl) {
    const items = buildPageItems([{ url: page.imageUrl }], page.imageUrl);
    if (items.length) return registerPageGallery(res, { url: page.imageUrl, title: path.basename(new URL(page.imageUrl).pathname), items });
  }
  const items = page.html ? buildPageItems(extractPageImages(page.html, page.finalUrl), page.finalUrl) : [];
  if (!items.length) {
    return needsBrowser(res, "default",
      "Não encontrei vídeo nem imagens nessa página. Se ela carrega as imagens depois de abrir ou exige login, abra a página no navegador e clique no ícone da extensão do Clipora.");
  }
  await probePageSizes(items);
  registerPageGallery(res, { url: page.finalUrl, title: pageTitle(page.html) || hostOf(page.finalUrl), items });
}

// ----- Classificação dos links -----

function isTwitterUrl(value) {
  return ["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"].includes(hostOf(value));
}
const isTwitterPostUrl = (value) => /\/status(?:es)?\/\d+/.test(new URL(value).pathname);

function isRedditUrl(value) {
  const host = hostOf(value);
  return host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it";
}
function isRedditPostUrl(value) {
  const { pathname } = new URL(value);
  return hostOf(value) === "redd.it" || /\/comments\/\w+/.test(pathname) || /^\/r\/[^/]+\/s\/\w+/.test(pathname);
}

const isInstagramPostUrl = (value) => /\/(p|reel|reels|tv|stories)\/[\w.-]+/.test(new URL(value).pathname);

function isMangaDexUrl(value) {
  const host = hostOf(value);
  return host === "mangadex.org" || host.endsWith(".mangadex.org");
}

// ----- MangaDex (API oficial e pública) -----

const MANGADEX_API = "https://api.mangadex.org";
// O MangaDex pede que clientes da API se identifiquem (sem fingir ser um navegador).
const MANGADEX_HEADERS = { "User-Agent": "Clipora/1.0 (app pessoal de downloads)" };

function mangaDexChapterId(value) {
  return new URL(value).pathname.match(/\/chapter\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || null;
}

async function mangaDexJson(apiPath) {
  const response = await fetch(`${MANGADEX_API}${apiPath}`, { headers: MANGADEX_HEADERS, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.result !== "ok") {
    throw Object.assign(new Error(`O MangaDex respondeu ${response.status}.`), { status: response.status });
  }
  return data;
}

// O endereço das páginas vale por uns 15 minutos (o MangaDex@Home troca de servidor).
async function mangaDexPages(chapterId) {
  const { baseUrl, chapter } = await mangaDexJson(`/at-home/server/${chapterId}`);
  return (chapter?.data || []).map((file, index) => ({
    imageUrl: `${baseUrl}/data/${chapter.hash}/${file}`,
    previewUrl: chapter.dataSaver?.[index] ? `${baseUrl}/data-saver/${chapter.hash}/${chapter.dataSaver[index]}` : null
  }));
}

// O MangaDex@Home pede que os clientes avisem quando uma imagem chegou (saúde da rede deles).
function reportMangaDexImage(response, bytes, duration) {
  const url = response.url;
  if (!url || /(^|\.)mangadex\.org$/.test(hostOf(url))) return;
  fetch("https://api.mangadex.network/report", {
    method: "POST",
    headers: { ...MANGADEX_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      success: true,
      bytes,
      duration,
      cached: String(response.headers.get("x-cache") || "").toUpperCase().startsWith("HIT")
    }),
    signal: AbortSignal.timeout(10000)
  }).catch(() => {});
}

function mangaTitleOf(manga) {
  const attributes = manga?.attributes || {};
  const titles = attributes.title || {};
  return titles.en || titles["pt-br"] || titles["ja-ro"] || Object.values(titles)[0] ||
    (attributes.altTitles || []).map((entry) => entry.en || entry["pt-br"]).find(Boolean) || "MangaDex";
}

async function sendMangaDexInfo(url, res) {
  const chapterId = mangaDexChapterId(url);
  if (!chapterId) {
    return res.status(422).json({
      error: "Abra um capítulo no MangaDex (endereço com /chapter/) e cole esse link. O Clipora baixa as páginas de um capítulo por vez."
    });
  }
  try {
    const { data } = await mangaDexJson(`/chapter/${chapterId}?includes[]=manga&includes[]=scanlation_group`);
    const attributes = data.attributes || {};
    if (attributes.externalUrl && !attributes.pages) {
      return res.status(422).json({
        error: `Esse capítulo é publicado fora do MangaDex (${hostOf(attributes.externalUrl) || "site oficial"}); as páginas não ficam lá.`
      });
    }
    const relationships = data.relationships || [];
    const mangaTitle = mangaTitleOf(relationships.find((entry) => entry.type === "manga"));
    const groups = relationships.filter((entry) => entry.type === "scanlation_group")
      .map((entry) => entry.attributes?.name).filter(Boolean);
    const pages = await mangaDexPages(chapterId);
    if (!pages.length) return res.status(422).json({ error: "Esse capítulo do MangaDex não tem páginas." });

    const items = pages.map((page, index) => ({
      index,
      kind: "image",
      imageUrl: page.imageUrl,
      previewUrl: page.previewUrl || page.imageUrl,
      headers: { ...MANGADEX_HEADERS, Referer: "https://mangadex.org/" }
    }));
    const number = attributes.chapter || "";
    const folder = `${mangaTitle} cap ${number || "unico"}`;
    registerGallery(res, {
      url,
      source: "MangaDex",
      title: `${mangaTitle} · ${number ? `Cap. ${number}` : "Capítulo único"}${attributes.title ? `: ${attributes.title}` : ""}`,
      channel: groups.length ? `Tradução: ${groups.join(", ")}` : "MangaDex",
      fileTitle: cleanFileName(folder).slice(0, 60),
      notes: ["Páginas na qualidade original do MangaDex."],
      items,
      page: true,
      suggestedFolder: folder,
      refresh: async () => {
        const fresh = await mangaDexPages(chapterId);
        fresh.forEach((page, index) => {
          if (!items[index]) return;
          items[index].imageUrl = page.imageUrl;
          items[index].previewUrl = page.previewUrl || page.imageUrl;
        });
      },
      report: reportMangaDexImage
    });
  } catch (error) {
    console.error(error.message);
    const missing = error.status === 404;
    res.status(missing ? 404 : 502).json({
      error: missing ? "Capítulo não encontrado no MangaDex." : "Não foi possível ler esse capítulo do MangaDex agora."
    });
  }
}

// Dados enviados pelo botão "Enviar ao Clipora" numa página qualquer.
// Fotos de um post do X pela API pública de incorporação (a mesma dos tweets incorporados
// em outros sites; não precisa de login). Post protegido, apagado ou recusado: null.
async function fetchTwitterPhotos(id) {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`, {
    headers: { "User-Agent": "Clipora" },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 429) throw Object.assign(new Error("limite"), { rateLimited: true });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const media = data?.mediaDetails || [];
  const photos = media.filter((part) => part?.type === "photo" && /^https:\/\/pbs\.twimg\.com\/media\//.test(part.media_url_https || ""));
  return photos.map((part) => ({
    url: part.media_url_https,
    width: part.original_info?.width || 0,
    height: part.original_info?.height || 0
  }));
}

// A extensão marca com "x:<id>" a foto de um post do X de que só viu uma imagem (a grade
// da aba Mídia mostra só a primeira). Aqui cada uma vira todas as fotos do post.
async function expandTwitterPosts(raw) {
  const marked = raw.map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => /^x:\d{1,25}$/.test(String(entry.post || "")))
    .slice(0, 2000);
  if (!marked.length) return raw;
  const results = new Map();
  const deadline = Date.now() + 90000;
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < marked.length && Date.now() < deadline) {
      const { entry, position } = marked[next++];
      try {
        const photos = await fetchTwitterPhotos(entry.post.slice(2));
        if (photos?.length > 1) results.set(position, photos);
      } catch (error) {
        if (error.rateLimited) stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return raw.flatMap((entry, position) => results.get(position) || [entry]);
}

async function importPageGallery(body, res) {
  const url = String(body.url || "").trim();
  if (!isSupportedUrl(url) || !Array.isArray(body.items)) {
    return res.status(400).json({ error: "Os dados enviados pela extensão estão incompletos. Clique no ícone do Clipora de novo na página." });
  }
  let raw = body.items.slice(0, MAX_PAGE_IMAGES * 2).map((entry) => (Array.isArray(entry)
    ? { url: entry[0], width: entry[1], height: entry[2], preview: entry[3], post: entry[4] }
    : { url: entry?.url, width: entry?.width, height: entry?.height, preview: entry?.preview, post: entry?.post }));
  if (siteOfPage(url) === "X") raw = await expandTwitterPosts(raw);
  const items = buildPageItems(raw, url);
  if (!items.length) {
    return res.status(422).json({
      error: "A extensão não encontrou imagens nessa página. Role até as imagens aparecerem e clique no ícone do Clipora de novo."
    });
  }
  await probePageSizes(items);
  const notes = body.truncated ? ["A página tinha imagens demais para um envio só; vieram as primeiras."] : [];
  registerPageGallery(res, { url, title: String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 200), items, notes });
}

// Força a leitura das imagens de uma página (quando o link também tem um vídeo).
app.post("/api/page-images", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!isSupportedUrl(url)) return res.status(400).json({ error: "Cole um link válido (começando com http:// ou https://)." });
  if (isMangaDexUrl(url)) return sendMangaDexInfo(url, res);
  if (isTwitterUrl(url)) return needsBrowser(res, "X");
  if (isInstagramUrl(url)) return needsBrowser(res, "Instagram");
  if (isRedditUrl(url)) return needsBrowser(res, "Reddit");
  if (isArtStationUrl(url)) return sendArtStationInfo(url, res);
  return sendGenericPageInfo(url, res);
});

// ---------- Escolher a pasta de destino (janela do Windows) ----------

let folderPickerOpen = false;

// Abre a janela "Procurar pasta" do Windows na frente das outras. O Clipora roda no
// próprio PC do usuário, então a janela aparece na tela dele.
function pickFolderWithDialog(initial) {
  if (process.env.CLIPORA_FAKE_PICKER) {
    return Promise.resolve(process.env.CLIPORA_FAKE_PICKER === "cancel" ? null : process.env.CLIPORA_FAKE_PICKER);
  }
  const initialBase64 = Buffer.from(String(initial || ""), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    `$initial = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${initialBase64}'))`,
    // Janela invisível "sempre na frente": a caixa de pastas abre por cima do navegador.
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = 'None'",
    "$owner.Opacity = 0",
    "$owner.StartPosition = 'CenterScreen'",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.Show()",
    "$owner.Activate()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Escolha a pasta onde o Clipora vai salvar'",
    "$dialog.ShowNewFolderButton = $true",
    "if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { 'OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)) } else { 'CANCEL' }"
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
    ], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const chosen = output.match(/OK:([A-Za-z0-9+/=]+)/);
      if (chosen) resolve(Buffer.from(chosen[1], "base64").toString("utf8"));
      else if (output.includes("CANCEL")) resolve(null);
      else reject(new Error(`A janela de pastas não abriu: ${output.trim().slice(0, 300)}`));
    });
  });
}

app.get("/api/folders", (req, res) => {
  // Os caminhos do servidor não interessam (nem devem aparecer) para outro PC.
  if (!isLocalRequest(req)) return res.json({ remote: true });
  res.json({ desktop: DESKTOP_DIR, downloads: DOWNLOADS_DIR });
});

app.post("/api/folders/pick", async (req, res) => {
  // Exigir JSON impede que outro site abra a janela (pedido JSON de outro site é barrado pelo navegador).
  if (!req.is("application/json")) return res.status(415).json({ error: "Pedido inválido." });
  // A janela abriria na tela do servidor, não na de quem pediu.
  if (!isLocalRequest(req)) return res.status(403).json({ error: OTHER_PC_MESSAGE });
  if (process.platform !== "win32" && !process.env.CLIPORA_FAKE_PICKER) {
    return res.status(501).json({ error: "Escolher pasta só funciona no Windows." });
  }
  if (folderPickerOpen) {
    return res.status(409).json({ error: "A janela de escolher pasta já está aberta (procure na barra de tarefas)." });
  }
  folderPickerOpen = true;
  try {
    const initial = String(req.body?.initial || "");
    const chosen = await pickFolderWithDialog(path.isAbsolute(initial) ? initial : DESKTOP_DIR);
    res.json(chosen ? { path: chosen } : { cancelled: true });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Não foi possível abrir a janela de escolher pasta." });
  } finally {
    folderPickerOpen = false;
  }
});

// Dados enviados pelo botão "Enviar ao Clipora" (lidos pelo navegador do usuário):
// uma obra do ArtStation ou a lista de imagens de uma página qualquer.
app.post("/api/gallery/import", (req, res) => {
  const body = req.body || {};
  if (body.source === "page") return importPageGallery(body, res);
  if (body.source !== "artstation") return res.status(400).json({ error: "Fonte não suportada." });
  const hash = String(body.hash || "").replace(/[^A-Za-z0-9]/g, "");
  if (!hash || !Array.isArray(body.assets)) return res.status(400).json({ error: "Dados da obra incompletos." });
  buildArtStationGallery(res, {
    url: `https://www.artstation.com/artwork/${hash}`,
    hash,
    title: String(body.title || "").slice(0, 300),
    username: String(body.author || "").slice(0, 60),
    assets: body.assets.map((asset) => ({
      url: String(asset?.url || ""),
      width: Number(asset?.width) || 0,
      height: Number(asset?.height) || 0
    }))
  });
});

app.post("/api/info", async (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!isSupportedUrl(url)) {
    return res.status(400).json({ error: "Cole um link válido (começando com http:// ou https://)." });
  }
  if (isInstagramUrl(url)) {
    // Perfis só abrem com login: o botão de favoritos lê pelo navegador do usuário.
    if (!isInstagramPostUrl(url)) return needsBrowser(res, "Instagram");
    return sendInstagramInfo(url, res);
  }
  if (isDeviantArtUrl(url)) return sendDeviantArtInfo(url, res);
  if (isArtStationUrl(url)) return sendArtStationInfo(url, res);
  if (isMangaDexUrl(url)) return sendMangaDexInfo(url, res);
  if (isTwitterUrl(url) && !isTwitterPostUrl(url)) return needsBrowser(res, "X");
  if (isRedditUrl(url) && !isRedditPostUrl(url)) return needsBrowser(res, "Reddit");

  try {
    const response = await youtubedl(url, {
      ...ytDlpBaseOptions,
      dumpSingleJson: true,
      noPlaylist: true,
      playlistItems: "1"
    });
    // Posts com varios videos (ex.: X/Twitter) chegam como lista; usamos o primeiro.
    const info = response?._type === "playlist"
      ? response.entries?.find(Boolean) || response
      : response;

    res.json(await buildVideoInfo(url, info, response));
  } catch (error) {
    const detail = String(error.stderr || error.message || "");
    console.error(detail.split("\n").find((line) => line.includes("ERROR")) || detail.slice(0, 300));
    // Posts sem vídeo (só fotos) do X e do Reddit: o servidor não lê esses sites, o botão sim.
    if (isTwitterUrl(url)) return needsBrowser(res, "XPost");
    if (isRedditUrl(url)) return needsBrowser(res, "RedditPost");
    // Página sem vídeo num site qualquer: tenta as imagens da página.
    const noVideo = /Unsupported URL|No video formats found|No video could be found|There'?s no video|no video in this/i.test(detail);
    const isYouTube = /(^|\.)(youtube\.com|youtu\.be)$/.test(hostOf(url));
    if (noVideo && !isYouTube) return sendGenericPageInfo(url, res);
    res.status(502).json({
      error: "Não foi possível ler esse vídeo. Ele pode ser privado, exigir login ou o site pode não ser suportado."
    });
  }
});

app.post("/api/downloads", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const height = Number(req.body?.height);
  // item: posição da mídia dentro de um post com várias (1 = primeira).
  const item = req.body?.item == null ? null : Number(req.body.item);

  if (!isSupportedUrl(url) || !isValidHeight(height) ||
    (item !== null && (!Number.isInteger(item) || item < 1 || item > 100))) {
    return res.status(400).json({ error: "Parâmetros de download inválidos." });
  }
  if (downloadJobs.size >= MAX_STORED_JOBS) {
    return res.status(429).json({ error: "Há muitos downloads pendentes. Tente novamente em instantes." });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    url,
    height,
    playlistItem: item,
    status: "queued",
    phase: "Aguardando início",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPolledAt: Date.now(),
    process: null,
    tempDir: null
  };

  downloadJobs.set(id, job);
  downloadQueue.push(job);
  runDownloadQueue();
  res.status(202).json({ id });
});

app.get("/api/downloads/:id", (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Download não encontrado." });
  job.lastPolledAt = Date.now();

  res.json({
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    error: job.error || null,
    savedPath: job.savedPath || null,
    savedFolder: job.savedFolder || null,
    savedCount: job.savedCount || 0,
    failedCount: job.failedCount || 0
  });
});

app.get("/api/downloads/:id/file", async (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job || job.status !== "ready" || !job.filePath) {
    return res.status(409).json({ error: "O arquivo ainda não está pronto." });
  }

  updateJob(job, { status: "sending", phase: "Enviando arquivo", expiresAt: null });
  res.setHeader("Content-Type", job.contentType || "video/mp4");
  res.setHeader("Content-Length", job.fileSize);
  // O nome da pasta pode ter acentos: "filename" leva a versão ASCII e "filename*" a original.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${cleanFileName(job.downloadName)}"; filename*=UTF-8''${encodeURIComponent(job.downloadName)}`
  );

  try {
    await pipeline(fs.createReadStream(job.filePath), res);
  } catch (error) {
    console.error(error);
  } finally {
    downloadJobs.delete(job.id);
    await removeJobFiles(job);
  }
});

app.delete("/api/downloads/:id", async (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job) return res.status(204).end();

  updateJob(job, { status: "cancelled", phase: "Download cancelado" });
  job.process?.kill("SIGKILL");
  const queueIndex = downloadQueue.indexOf(job);
  if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
  await removeJobFiles(job);
  downloadJobs.delete(job.id);
  res.status(204).end();
});

app.post("/api/editor-sessions", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const height = Number(req.body?.height);

  const purpose = SESSION_PURPOSES.includes(req.body?.purpose) ? req.body.purpose : "editor";

  if (!isSupportedUrl(url) || !isValidHeight(height)) {
    return res.status(400).json({ error: "Parâmetros de edição inválidos." });
  }
  if (editorJobs.size >= MAX_STORED_JOBS) {
    return res.status(429).json({ error: "Há muitas sessões abertas. Feche uma e tente novamente." });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    mode: "editor",
    operation: "download",
    requestedPurpose: purpose,
    url,
    height,
    status: "queued",
    phase: "Aguardando preparação",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPolledAt: Date.now(),
    process: null,
    tempDir: null
  };

  editorJobs.set(id, job);
  downloadQueue.push(job);
  runDownloadQueue();
  res.status(202).json({ id });
});

app.post("/api/editor-sessions/upload", async (req, res) => {
  const contentLength = Number(req.headers["content-length"] || 0);
  const originalName = decodeURIComponent(String(req.headers["x-file-name"] || "video.mp4"));
  const extension = path.extname(originalName).toLowerCase();
  const acceptedExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
  const purposeHeader = String(req.headers["x-clipora-purpose"] || "editor");
  const purpose = SESSION_PURPOSES.includes(purposeHeader) ? purposeHeader : "editor";

  if (!contentLength || contentLength > MAX_UPLOAD_BYTES || !acceptedExtensions.has(extension)) {
    return res.status(400).json({ error: "Escolha um arquivo de vídeo compatível de até 12 GB." });
  }
  if (editorJobs.size >= MAX_STORED_JOBS) {
    return res.status(429).json({ error: "Há muitas sessões abertas. Feche uma e tente novamente." });
  }

  const id = crypto.randomUUID();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clipora-edit-"));
  const inputPath = path.join(tempDir, `source${extension}`);
  const job = {
    id,
    mode: "editor",
    operation: "prepare_local",
    requestedPurpose: purpose,
    status: "uploading",
    phase: "Carregando vídeo local",
    progress: 5,
    title: path.basename(originalName, extension),
    downloadName: `${cleanFileName(path.basename(originalName, extension))}-clip.mp4`,
    filePath: inputPath,
    fileSize: contentLength,
    tempDir,
    process: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPolledAt: Date.now()
  };
  editorJobs.set(id, job);

  try {
    await pipeline(req, fs.createWriteStream(inputPath));
    updateJob(job, { status: "queued", phase: "Aguardando análise", progress: 90 });
    downloadQueue.push(job);
    runDownloadQueue();
    res.status(202).json({ id });
  } catch (error) {
    console.error(error);
    editorJobs.delete(id);
    await removeJobFiles(job);
    if (!res.headersSent) res.status(500).json({ error: "Não foi possível carregar o vídeo." });
  }
});

app.get("/api/editor-sessions/:id", (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return sessionLost(res);
  job.lastPolledAt = Date.now();
  if (job.expiresAt) job.expiresAt = Date.now() + EDITOR_TTL_MS;
  res.json(editorJobResponse(job));
});

app.post("/api/editor-sessions/:id/assets", (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return sessionLost(res);
  if (job.purpose === "editor" && job.status === "editor_ready") {
    return res.json({ id: job.id, status: job.status });
  }
  if (job.status !== "editor_ready") {
    return res.status(409).json({ error: "Aguarde a tarefa atual terminar." });
  }
  job.operation = "assets";
  job.lastPolledAt = Date.now();
  updateJob(job, { status: "queued", phase: "Aguardando preparação do editor", progress: 90, expiresAt: null });
  downloadQueue.push(job);
  runDownloadQueue();
  res.status(202).json({ id: job.id, status: job.status });
});

function sendMediaFile(req, res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);

  // O navegador cancela muitos pedidos ao pular pelo video. Sem fechar o arquivo
  // a cada cancelamento, as leituras se acumulam e o Windows trava o temporario.
  const send = (options) => {
    const stream = fs.createReadStream(filePath, options);
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  if (!range) {
    res.setHeader("Content-Length", stat.size);
    return send({});
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (!match || start > end || start >= stat.size) {
    res.status(416).setHeader("Content-Range", `bytes */${stat.size}`);
    return res.end();
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  return send({ start, end });
}

app.get("/api/editor-sessions/:id/media", (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return sessionLost(res);
  if (!job.filePath || !["editor_ready", "queued_export", "exporting", "export_ready", "export_error"].includes(job.status)) {
    return res.status(409).json({ error: "O vídeo ainda não está pronto." });
  }
  job.lastPolledAt = Date.now();
  job.expiresAt = Date.now() + EDITOR_TTL_MS;
  const extension = path.extname(job.filePath).toLowerCase();
  const contentType = extension === ".webm" ? "video/webm" : extension === ".mov" ? "video/quicktime" : "video/mp4";
  sendMediaFile(req, res, job.filePath, contentType);
});

app.get("/api/editor-sessions/:id/assets/:file", (req, res) => {
  const job = editorJobs.get(req.params.id);
  const file = path.basename(req.params.file);
  const allowed = job && (job.thumbnailFiles?.includes(file) || job.waveformFile === file);
  if (!allowed) return res.status(404).end();
  job.lastPolledAt = Date.now();
  job.expiresAt = Date.now() + EDITOR_TTL_MS;
  res.sendFile(path.join(job.tempDir, file));
});

app.post("/api/editor-sessions/:id/exports", (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return sessionLost(res);
  if (!["editor_ready", "export_error"].includes(job.status)) {
    return res.status(409).json({ error: "O vídeo ainda não está pronto para exportar." });
  }
  const segments = normalizeSegments(req.body?.segments, job.media.duration);
  if (!segments) return res.status(400).json({ error: "Os trechos selecionados são inválidos." });
  const crop = normalizeCrop(req.body?.crop, job.media, req.body?.scaleMode || "real");
  if (crop === false) return res.status(400).json({ error: "O recorte da imagem é inválido." });
  const outputDuration = segments.reduce((total, segment) => total + segment.end - segment.start, 0);
  const output = normalizeOutput(req.body?.output, outputDuration, job.media.hasAudio);
  if (output.error) return res.status(400).json({ error: output.error });
  // Tamanho alvo e um limite maximo: se couber folgado, nao inflamos o arquivo
  // alem da qualidade que a fonte ja tem (e mantemos a resolucao original).
  const sourceKbps = sourceVideoKbps(job);
  if (output.compression === "target" && sourceKbps && output.videoKbps > sourceKbps) {
    Object.assign(output, { videoKbps: sourceKbps, cappedToSource: true });
  }

  job.exportSegments = segments;
  job.exportCrop = crop;
  job.exportOutput = output;
  job.operation = "export";
  updateJob(job, {
    status: "queued_export",
    phase: "Aguardando exportação",
    progress: 0,
    expiresAt: null
  });
  downloadQueue.push(job);
  runDownloadQueue();
  res.status(202).json({ id: job.id });
});

app.post("/api/editor-sessions/:id/cancel-export", (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return res.status(204).end();
  if (job.status === "queued_export") {
    const queueIndex = downloadQueue.indexOf(job);
    if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
    updateJob(job, {
      status: "editor_ready",
      phase: "Exportação cancelada",
      progress: 100,
      error: null,
      expiresAt: Date.now() + EDITOR_TTL_MS
    });
  } else if (job.status === "exporting") {
    updateJob(job, { status: "cancelling_export", phase: "Cancelando exportação" });
    job.process?.kill("SIGKILL");
  } else if (job.status === "export_ready") {
    if (!job.exportIsSource && job.exportPath) {
      fs.promises.rm(job.exportPath, { force: true }).catch(() => {});
    }
    updateJob(job, {
      status: "editor_ready",
      phase: "Exportação cancelada",
      progress: 100,
      exportPath: null,
      exportIsSource: false,
      error: null,
      expiresAt: Date.now() + EDITOR_TTL_MS
    });
  }
  res.status(202).json({ status: job.status });
});

app.get("/api/editor-sessions/:id/file", async (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return sessionLost(res);
  if (job.status !== "export_ready" || !job.exportPath) {
    return res.status(409).json({ error: "O arquivo ainda não está pronto." });
  }
  // keep=1: as ferramentas mantem a sessao para "Fazer outro com o mesmo video".
  const keep = req.query.keep === "1";

  const stat = await fs.promises.stat(job.exportPath);
  const nameRoot = cleanFileName(job.fileTitle || job.title || "clipora");
  const extension = path.extname(job.exportPath).toLowerCase() || ".mp4";
  const contentTypes = { ".gif": "image/gif", ".webm": "video/webm", ".mp4": "video/mp4", ".m4v": "video/mp4" };
  const downloadName = `${nameRoot}-${exportSuffix(job)}${extension}`;
  res.setHeader("Content-Type", contentTypes[extension] || "application/octet-stream");
  res.setHeader("Content-Length", stat.size);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  );

  try {
    await pipeline(fs.createReadStream(job.exportPath), res);
  } catch (error) {
    console.error(error);
  } finally {
    if (keep) {
      if (!job.exportIsSource && job.exportPath) {
        await fs.promises.rm(job.exportPath, { force: true }).catch(() => {});
      }
      updateJob(job, {
        status: "editor_ready",
        phase: "Arquivo enviado",
        progress: 100,
        exportPath: null,
        exportIsSource: false,
        expiresAt: Date.now() + EDITOR_TTL_MS
      });
    } else {
      editorJobs.delete(job.id);
      await removeJobFiles(job);
    }
  }
});

app.delete("/api/editor-sessions/:id", async (req, res) => {
  const job = editorJobs.get(req.params.id);
  if (!job) return res.status(204).end();
  updateJob(job, { status: "cancelled", phase: "Edição cancelada" });
  job.process?.kill("SIGKILL");
  const queueIndex = downloadQueue.indexOf(job);
  if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
  editorJobs.delete(job.id);
  await removeJobFiles(job);
  res.status(204).end();
});

setInterval(() => {
  const now = Date.now();
  for (const [key, post] of galleryPosts) {
    if (post.expiresAt < now) galleryPosts.delete(key);
  }
  for (const [id, job] of downloadJobs) {
    const isRunning = ["queued", "downloading"].includes(job.status);
    if (isRunning && now - job.lastPolledAt > ABANDONED_JOB_MS) {
      updateJob(job, { status: "cancelled", phase: "Tarefa abandonada" });
      job.process?.kill("SIGKILL");
      const queueIndex = downloadQueue.indexOf(job);
      if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
      removeJobFiles(job);
      downloadJobs.delete(id);
      continue;
    }

    if (!job.expiresAt || job.expiresAt > now) continue;
    job.process?.kill("SIGKILL");
    removeJobFiles(job);
    downloadJobs.delete(id);
  }

  for (const [id, job] of editorJobs) {
    const isRunning = ["queued", "downloading", "preparing", "queued_export", "exporting"].includes(job.status);
    if (isRunning && now - job.lastPolledAt > ABANDONED_JOB_MS) {
      updateJob(job, { status: "cancelled", phase: "Sessão abandonada" });
      job.process?.kill("SIGKILL");
      const queueIndex = downloadQueue.indexOf(job);
      if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
      removeJobFiles(job);
      editorJobs.delete(id);
      continue;
    }
    if (!job.expiresAt || job.expiresAt > now) continue;
    job.process?.kill("SIGKILL");
    removeJobFiles(job);
    editorJobs.delete(id);
  }
}, 60 * 1000).unref();

// ----- Extensão do navegador (Chrome/Edge) -----
// O pacote é montado na hora: os arquivos de extensao/, o coletor da página (o mesmo do
// botão de favoritos) e um config.js com o endereço do Clipora de onde o .zip foi baixado.
// Assim a extensão já vem apontando para o endereço certo (ex.: o HTTPS do Tailscale).
const EXTENSION_DIR = path.join(__dirname, "extensao");

function publicOrigin(req) {
  const first = (value) => String(value || "").split(",")[0].trim();
  const host = (first(req.headers["x-forwarded-host"]) || first(req.headers.host)).toLowerCase();
  const proto = first(req.headers["x-forwarded-proto"]) === "https" || req.socket?.encrypted ? "https" : "http";
  if (!/^([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?$/.test(host)) return `http://localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(dir, entry.name), relative));
    else files.push({ name: relative, filePath: path.join(dir, entry.name) });
  }
  return files;
}

app.get("/clipora-extensao-icone.png", (_req, res) => {
  res.sendFile(path.join(EXTENSION_DIR, "icones", "icone-128.png"));
});

app.get("/clipora-extensao.zip", async (req, res) => {
  let tempDir = null;
  try {
    const origin = publicOrigin(req);
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clipora-ext-"));
    const manifest = JSON.parse(await fs.promises.readFile(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
    // Padrão de permissão sem porta (o Chrome não aceita porta nesses padrões).
    const hostPattern = `${origin.replace(/:\d+$/, "")}/*`;
    if (!manifest.host_permissions.includes(hostPattern)) manifest.host_permissions.push(hostPattern);
    const generated = {
      "manifest.json": JSON.stringify(manifest, null, 2),
      "config.js": `// Gerado pelo Clipora ao baixar a extensão.\nexport const CLIPORA_PADRAO = ${JSON.stringify(origin)};\nexport const API_ESPERADA = ${API_VERSION};\n`
    };
    const files = (await listFiles(EXTENSION_DIR)).filter((file) => !generated[file.name]);
    for (const [name, content] of Object.entries(generated)) {
      const filePath = path.join(tempDir, name);
      await fs.promises.writeFile(filePath, content, "utf8");
      files.push({ name, filePath });
    }
    files.push({ name: "coletor.js", filePath: path.join(publicDir, "js", "coletor.js") });
    const zipPath = path.join(tempDir, "clipora-extensao.zip");
    await writeZip(zipPath, files.map((file) => ({ name: `clipora-extensao/${file.name}`, filePath: file.filePath })));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="clipora-extensao.zip"');
    res.setHeader("Cache-Control", "no-store");
    const stream = fs.createReadStream(zipPath);
    const cleanup = () => fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    // No Windows o arquivo aberto não pode ser apagado: limpa depois que o stream fecha.
    stream.on("close", cleanup);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    console.error(error);
    if (tempDir) fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: "Não foi possível montar o pacote da extensão." });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Aplicacao pronta em http://localhost:${PORT}`);
});
