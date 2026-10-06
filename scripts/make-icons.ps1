param([string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/icon-master.png'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root 'assets'
$android = Join-Path $root 'android/res/drawable'
New-Item -ItemType Directory -Force -Path $assets,$android | Out-Null
if (-not (Test-Path -LiteralPath $Source)) { throw "Icon master not found: $Source" }
$sourceImage = [System.Drawing.Image]::FromFile($Source)
function Save-SquarePng([int]$Size,[string]$Path) {
  $bitmap = [System.Drawing.Bitmap]::new($Size,$Size,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($sourceImage,0,0,$Size,$Size)
  $bitmap.Save($Path,[System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}
Save-SquarePng 512 (Join-Path $assets 'icon.png')
Save-SquarePng 512 (Join-Path $android 'icon.png')
$icoPng = Join-Path $assets 'icon-256.png'; Save-SquarePng 256 $icoPng
$bytes = [IO.File]::ReadAllBytes($icoPng)
$stream = [IO.File]::Create((Join-Path $assets 'icon.ico'))
$writer = [IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]22); $writer.Write($bytes)
$writer.Dispose(); $stream.Dispose(); $sourceImage.Dispose()
