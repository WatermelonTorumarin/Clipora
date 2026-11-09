@echo off
setlocal
cd /d "%~dp0"

echo.
echo Instalando o Clipora...
echo.

set "YOUTUBE_DL_SKIP_PYTHON_CHECK=1"
call npm.cmd install

if errorlevel 1 (
  echo.
  echo A instalacao falhou. Feche programas que estejam usando esta pasta,
  echo reinicie o computador e execute este arquivo novamente.
  echo.
  pause
  exit /b 1
)

rem O npm 11 nao executa os scripts de instalacao dos pacotes. Sem eles o
rem FFmpeg e o yt-dlp nao sao baixados, entao rodamos cada um aqui.
if not exist "%~dp0node_modules\ffmpeg-static\ffmpeg.exe" (
  echo.
  echo Baixando o FFmpeg...
  node "%~dp0node_modules\ffmpeg-static\install.js"
)
if not exist "%~dp0node_modules\youtube-dl-exec\bin\yt-dlp.exe" (
  echo.
  echo Baixando o yt-dlp...
  node "%~dp0node_modules\youtube-dl-exec\scripts\postinstall.js"
)
if not exist "%~dp0node_modules\ffmpeg-static\ffmpeg.exe" (
  echo.
  echo Nao foi possivel baixar o FFmpeg. Verifique a internet e rode de novo.
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\youtube-dl-exec\bin\yt-dlp.exe" (
  echo.
  echo Nao foi possivel baixar o yt-dlp. Verifique a internet e rode de novo.
  pause
  exit /b 1
)

echo.
echo Atualizando o extrator de videos...
"%~dp0node_modules\youtube-dl-exec\bin\yt-dlp.exe" -U

if errorlevel 1 (
  echo.
  echo Aviso: nao foi possivel atualizar o extrator agora.
  echo O Clipora tentara usar a versao que ja esta instalada.
)

echo.
echo Instalacao concluida. Iniciando em http://localhost:3000
echo Mantenha esta janela aberta enquanto estiver usando o Clipora.
echo.
call npm.cmd start
