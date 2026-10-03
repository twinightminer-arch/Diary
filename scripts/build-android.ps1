param([Parameter(Mandatory=$true)][string]$Sdk, [Parameter(Mandatory=$true)][string]$Keystore, [Parameter(Mandatory=$true)][string]$PasswordFile, [string]$Java = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
$build = 'android-build'
$release = '../releases'
$platform = (Get-ChildItem (Join-Path $Sdk 'platforms') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'android.jar') } | Select-Object -First 1).FullName
$tools = (Get-ChildItem (Join-Path $Sdk 'build-tools') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'aapt2.exe') } | Select-Object -First 1).FullName
# Native tools (javac, d8) write warnings to stderr. With $ErrorActionPreference
# = 'Stop' PowerShell would treat those as terminating errors, so relax it
# around the call and rely on $LASTEXITCODE to detect real failures.
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Executable @Arguments 2>&1 | ForEach-Object { Write-Host "$_" } } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "Build command failed: $Executable ($LASTEXITCODE)" }
}
New-Item -ItemType Directory -Force -Path $build,(Join-Path $build 'java'),(Join-Path $build 'classes'),(Join-Path $build 'dex'),$release | Out-Null
Invoke-Checked (Join-Path $tools 'aapt2.exe') @('compile','--dir',(Join-Path $root 'android/res'),'-o',(Join-Path $build 'resources.zip'))
Invoke-Checked (Join-Path $tools 'aapt2.exe') @('link','-o',(Join-Path $build 'base.apk'),'-I',(Join-Path $platform 'android.jar'),'--manifest',(Join-Path $root 'android/AndroidManifest.xml'),'-A',(Join-Path $root 'dist/web'),'--java',(Join-Path $build 'java'),(Join-Path $build 'resources.zip'))
$sources = @(Get-ChildItem (Join-Path $root 'android/src'),(Join-Path $build 'java') -Filter '*.java' -Recurse | ForEach-Object FullName)
Invoke-Checked (Join-Path $Java 'bin/javac.exe') (@('--release','17','-encoding','UTF-8','-classpath',(Join-Path $platform 'android.jar'),'-d',(Join-Path $build 'classes')) + $sources)
$classes = @(Get-ChildItem (Join-Path $build 'classes') -Filter '*.class' -Recurse | ForEach-Object FullName)
Invoke-Checked (Join-Path $Java 'bin/java.exe') (@('-cp',(Join-Path $tools 'lib/d8.jar'),'com.android.tools.r8.D8','--lib',(Join-Path $platform 'android.jar'),'--min-api','26','--output',(Join-Path $build 'dex')) + $classes)
Invoke-Checked (Join-Path $Java 'bin/jar.exe') @('--update','--file',(Join-Path $build 'base.apk'),'-C',(Join-Path $build 'dex'),'classes.dex')
Invoke-Checked (Join-Path $tools 'zipalign.exe') @('-f','-p','4',(Join-Path $build 'base.apk'),(Join-Path $build 'aligned.apk'))
$apk = Join-Path $release 'Diary-0.2.0-Android.apk'
Invoke-Checked (Join-Path $Java 'bin/java.exe') @('-jar',(Join-Path $tools 'lib/apksigner.jar'),'sign','--ks',$Keystore,'--ks-key-alias','diary','--ks-pass',"file:$PasswordFile",'--out',$apk,(Join-Path $build 'aligned.apk'))
Invoke-Checked (Join-Path $Java 'bin/java.exe') @('-jar',(Join-Path $tools 'lib/apksigner.jar'),'verify','--verbose','--print-certs',$apk)
Invoke-Checked (Join-Path $tools 'aapt2.exe') @('dump','badging',$apk)
Pop-Location
