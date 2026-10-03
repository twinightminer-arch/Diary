$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root 'assets'
$android = Join-Path $root 'android/res/drawable'
New-Item -ItemType Directory -Force -Path $assets,$android | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256,256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$graphics.Clear([System.Drawing.Color]::FromArgb(78,103,80))
$font = [System.Drawing.Font]::new('Georgia',175,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(250,249,246))
$graphics.DrawString('D',$font,$brush,21,14)
$accent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(220,228,170))
$graphics.FillEllipse($accent,195,199,22,22)
$bitmap.Save((Join-Path $assets 'icon.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Save((Join-Path $android 'icon.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$bytes = [IO.File]::ReadAllBytes((Join-Path $assets 'icon.png'))
$stream = [IO.File]::Create((Join-Path $assets 'icon.ico'))
$writer = [IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]22); $writer.Write($bytes)
$writer.Dispose(); $stream.Dispose(); $accent.Dispose(); $brush.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
