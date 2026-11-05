# Einfacher lokaler Webserver fuer RideLab (kein Node/Python noetig)
# Start:  Rechtsklick > "Mit PowerShell ausfuehren"  oder  powershell -File serve.ps1
# Danach im Browser: http://localhost:8123/
$root = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'web'
$port = 8123
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "RideLab laeuft auf http://localhost:$port/  (Beenden mit Strg+C)"
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json'
  '.gpx'  = 'application/gpx+xml'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = $ctx.Request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrEmpty($path)) { $path = 'index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {} finally {
    $ctx.Response.Close()
  }
}
