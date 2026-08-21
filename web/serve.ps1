# Minimal static file server for local preview.
#
# The screener is plain ES modules, which browsers refuse to load over file://,
# so it needs to be served over http. This uses only built-in .NET types — no
# Node or Python required.
#
#   powershell -ExecutionPolicy Bypass -File web\serve.ps1
#   then open http://localhost:8777
param(
    [string]$Root = $PSScriptRoot,
    [int]$Port = 8777
)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root on http://localhost:$Port/"

$types = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
        if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
        $path = Join-Path $Root $rel
        # A directory request serves its index.html, as GitHub Pages does.
        if (Test-Path $path -PathType Container) { $path = Join-Path $path "index.html" }

        if (Test-Path $path -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($path).ToLower()
            $ct = $types[$ext]
            if (-not $ct) { $ct = "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($path)
            $ctx.Response.ContentType = $ct
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "200 $rel"
        }
        else {
            $ctx.Response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("Not found: $rel")
            $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
            Write-Host "404 $rel"
        }
        $ctx.Response.OutputStream.Close()
    }
    catch {
        Write-Host "ERR $($_.Exception.Message)"
    }
}
