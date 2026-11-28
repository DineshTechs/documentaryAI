# Puts Documentary Studio (running on this PC) on the internet with a free Cloudflare Tunnel,
# so you can use it from your phone and anywhere. Started by start_tunnel.bat. Close the window to stop.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$urlFile = Join-Path $root 'tunnel_url.txt'

# ---- settings from .env
$port = 3000; $pw = ''
if (Test-Path .env) {
  foreach ($l in Get-Content .env) {
    if ($l -match '^\s*PORT\s*=\s*(\d+)') { $port = [int]$Matches[1] }
    if ($l -match '^\s*APP_PASSWORD\s*=\s*(.*)$') { $pw = $Matches[1].Trim() }
  }
}
if (-not $pw) { Write-Host '[!] No login password yet. Run run_app.bat once first (it asks for one), then run this again.' -ForegroundColor Yellow; exit 1 }
if ($pw.Length -lt 10) {
  Write-Host ''
  Write-Host '[!] Your app password is short. Once the app is on the internet, anyone who finds the address could try to guess it.' -ForegroundColor Yellow
  Write-Host '    Open .env in Notepad, change APP_PASSWORD to 12+ letters and numbers, save, and restart run_app.bat.' -ForegroundColor Yellow
  if ((Read-Host 'Continue anyway? (y/N)') -ne 'y') { exit 1 }
}

# ---- is the app running? start it if not
function AppUp { try { (Invoke-RestMethod -TimeoutSec 3 "http://127.0.0.1:$port/api/health").app -eq 'documentary-studio' } catch { $false } }
if (-not (AppUp)) {
  Write-Host 'Starting Documentary Studio...'
  Start-Process -FilePath (Join-Path $root 'run_app.bat') -WorkingDirectory $root
  for ($i = 0; $i -lt 90 -and -not (AppUp); $i++) { Start-Sleep 2 }
  if (-not (AppUp)) { Write-Host '[!] The app did not start. Look at the Documentary Studio window for the error.' -ForegroundColor Red; exit 1 }
}

# ---- cloudflared (free, from Cloudflare's official GitHub releases)
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$local = Join-Path $root 'tools\cloudflared.exe'
if (-not $cf -and (Test-Path $local)) { $cf = $local }
if (-not $cf) {
  Write-Host 'Downloading Cloudflare Tunnel (cloudflared, about 60 MB, one time)...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" -OutFile $local
  $cf = $local
}

# ---- run the tunnel; restart it if it drops (the address changes then, and Telegram gets the new one)
$log = Join-Path $root 'tunnel.log'
try {
  while ($true) {
    Remove-Item $urlFile, $log, "$log.out" -ErrorAction SilentlyContinue
    Write-Host 'Opening the tunnel...'
    $p = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$port") `
      -NoNewWindow -PassThru -RedirectStandardError $log -RedirectStandardOutput "$log.out"
    $url = $null
    for ($i = 0; $i -lt 60 -and -not $url -and -not $p.HasExited; $i++) {
      Start-Sleep 1
      $t = ''; try { $t = [string](Get-Content -Path $log -Raw -ErrorAction Stop) } catch { }
      if ($t -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0] }
    }
    if ($url) {
      Set-Content -Path $urlFile -Value $url -Encoding ascii -NoNewline
      try { Set-Clipboard $url } catch { }
      Write-Host ''
      Write-Host '  Documentary Studio is online at:' -ForegroundColor Green
      Write-Host "  $url" -ForegroundColor Cyan
      Write-Host '  (copied to the clipboard; your Telegram bot also gets it - send /link any time)'
      Write-Host '  Keep this window and the PC on. Close this window to go offline.'
      Write-Host ''
      while (-not $p.HasExited) {
        Start-Sleep 30
        (Get-Item $urlFile).LastWriteTime = Get-Date   # heartbeat: the app ignores the address if this stops
      }
      Write-Host '[!] The tunnel dropped. Reconnecting in 5 s...' -ForegroundColor Yellow
    } else {
      Write-Host '[!] The tunnel did not start. Last messages:' -ForegroundColor Yellow
      Get-Content $log -Tail 8 -ErrorAction SilentlyContinue
      if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
      Write-Host 'Retrying in 15 s... (check the internet connection)'
      Start-Sleep 10
    }
    Start-Sleep 5
  }
} finally {
  Remove-Item $urlFile -ErrorAction SilentlyContinue
  if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}
