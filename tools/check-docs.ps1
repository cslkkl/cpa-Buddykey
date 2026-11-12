$root = 'C:\Users\11965\Desktop\BuddyKey'
Set-Location $root

Write-Output '=== 相对链接目标检查 ==='
$files = Get-ChildItem -Recurse -File -Filter *.md | Where-Object { $_.FullName -notmatch '\\\.git\\|\\data\\|\\bin\\' }
$missing = 0
foreach ($f in $files) {
  $txt = Get-Content $f.FullName -Raw
  foreach ($m in [regex]::Matches($txt, '\]\(([^)]+)\)')) {
    $t = $m.Groups[1].Value.Trim()
    if ($t -match '^(https?:|mailto:|#)') { continue }
    $rel = $t.Split('#')[0]
    if ($rel -eq '') { continue }
    $dir = $f.DirectoryName
    $target = [System.IO.Path]::GetFullPath((Join-Path $dir $rel))
    if (-not (Test-Path -LiteralPath $target)) {
      $relPath = $f.FullName.Replace($root + '\', '')
      Write-Output ("MISSING  {0}  ->  {1}" -f $relPath, $t)
      $missing++
    }
  }
}
if ($missing -eq 0) { Write-Output '全部命中（0 个失效链接）' } else { Write-Output "共 $missing 个失效链接" }

Write-Output ''
Write-Output '=== 换行检查（源码/文档应 LF，.cmd/.bat 应 CRLF）==='
$bad = 0
foreach ($f in (Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\|\\data\\|\\bin\\' })) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  if ($bytes.Length -eq 0) { continue }
  $crlf = 0; $lf = 0
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 10) {
      if ($i -gt 0 -and $bytes[$i - 1] -eq 13) { $crlf++ } else { $lf++ }
    }
  }
  $ext = $f.Extension.ToLower()
  $wantCrlf = ($ext -eq '.cmd' -or $ext -eq '.bat')
  $relPath = $f.FullName.Replace($root + '\', '')
  if ($wantCrlf) {
    if ($lf -gt 0) { Write-Output ("BAD-CRLF  {0}  LF={1}" -f $relPath, $lf); $bad++ }
  } else {
    if ($crlf -gt 0) { Write-Output ("BAD-LF    {0}  CRLF={1} LF={2}" -f $relPath, $crlf, $lf); $bad++ }
  }
}
if ($bad -eq 0) { Write-Output '换行全部符合约定' } else { Write-Output "共 $bad 个文件换行不符" }
