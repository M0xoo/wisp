# Win32 for qa/desktop-tauri-win.mjs and the install gate: what a person at a Windows desktop sees and
# does, a command per run, JSON out. Windows PowerShell 5.1, which every Windows has.
param([Parameter(Position = 0)][string]$Cmd, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int i);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuStringW(IntPtr m, uint id, StringBuilder s, int n, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettingsW(string d, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsW(ref DEVMODE dm, int flags);
  // Set-DisplayResolution is Windows Server's: a Windows 11 runner (windows-11-arm) has none.
  public static int Resolution(int w, int h) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettingsW(null, -1, ref dm)) return -100;
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettingsW(ref dm, 0);
  }
  public static List<IntPtr> Tops() { var l = new List<IntPtr>(); EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
  public static string Item(IntPtr m, int i) { var s = new StringBuilder(256); GetMenuStringW(m, (uint)i, s, 256, 0x400); return s.ToString(); }
}
'@
function Info([IntPtr]$h) {
  $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  $r = New-Object W+RECT; $c = New-Object W+RECT; $o = New-Object W+POINT
  [void][W]::GetWindowRect($h, [ref]$r); [void][W]::GetClientRect($h, [ref]$c); [void][W]::ClientToScreen($h, [ref]$o)
  @{ hwnd = $h.ToInt64(); pid = $p; title = [W]::Text($h); cls = [W]::Class($h); visible = [W]::IsWindowVisible($h); minimized = [W]::IsIconic($h); maximized = [W]::IsZoomed($h)
     foreground = ([W]::GetForegroundWindow() -eq $h); x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T; clientWidth = $c.R; clientHeight = $c.B; clientX = $o.X; clientY = $o.Y }
}
function Menus([IntPtr]$h) {
  $m = [W]::GetMenu($h); if ($m -eq [IntPtr]::Zero) { return , @() }
  $out = @()
  for ($i = 0; $i -lt [W]::GetMenuItemCount($m); $i++) {
    $s = [W]::GetSubMenu($m, $i); $items = @()
    if ($s -ne [IntPtr]::Zero) {
      for ($j = 0; $j -lt [W]::GetMenuItemCount($s); $j++) { $items += @{ text = [W]::Item($s, $j); grey = (([W]::GetMenuState($s, [uint32]$j, 0x400) -band 3) -ne 0) } }
    }
    $out += @{ title = [W]::Item($m, $i); items = $items }
  }
  , $out
}
function Press([uint32]$down, [uint32]$up) { [W]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 40; [W]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero) }
$r = switch ($Cmd) {
  'tops' { [W]::Tops() | Where-Object { [W]::IsWindowVisible($_) } | ForEach-Object { Info $_ } }
  # Every window of a process, with its menu bar.
  'windows' { $id = [int]$Rest[0]; [W]::Tops() | ForEach-Object { $x = Info $_; if ($x.pid -eq $id) { $x.menu = Menus $_; $x } } }
  'screen' { $s = [System.Windows.Forms.Screen]::PrimaryScreen; @{ width = $s.Bounds.Width; height = $s.Bounds.Height; workWidth = $s.WorkingArea.Width; workHeight = $s.WorkingArea.Height } }
  'resolution' {
    if (Get-Command Set-DisplayResolution -ErrorAction SilentlyContinue) { Set-DisplayResolution -Width ([int]$Rest[0]) -Height ([int]$Rest[1]) -Force | Out-Null; $code = 0 }
    else { $code = [W]::Resolution([int]$Rest[0], [int]$Rest[1]) }
    $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    @{ ok = ($code -eq 0); code = $code; width = $s.Width; height = $s.Height }
  }
  # A part of the screen: its hash, and a PNG if there's a path.
  'crop' {
    $b = New-Object System.Drawing.Bitmap ([int]$Rest[2]), ([int]$Rest[3]); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen([int]$Rest[0], [int]$Rest[1], 0, 0, $b.Size)
    $m = New-Object System.IO.MemoryStream; $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Bmp)
    if ($Rest[4]) { $b.Save($Rest[4], [System.Drawing.Imaging.ImageFormat]::Png) }
    @{ sha = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($m.ToArray())) }
  }
  'click' { [void][W]::SetCursorPos([int]$Rest[0], [int]$Rest[1]); Start-Sleep -Milliseconds 150; if ($Rest[2] -eq 'right') { Press 8 16 } else { Press 2 4 }; @{ ok = $true } }
  'dblclick' { [void][W]::SetCursorPos([int]$Rest[0], [int]$Rest[1]); Start-Sleep -Milliseconds 150; Press 2 4; Start-Sleep -Milliseconds 80; Press 2 4; @{ ok = $true } }
  'drag' {
    $x = [int]$Rest[0]; $y = [int]$Rest[1]; [void][W]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 150; [W]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 300
    for ($i = 1; $i -le 10; $i++) { [void][W]::SetCursorPos($x + [int]$Rest[2] * $i / 10, $y + [int]$Rest[3] * $i / 10); Start-Sleep -Milliseconds 40 }
    [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); @{ ok = $true }
  }
  'keys' { [System.Windows.Forms.SendKeys]::SendWait($Rest[0]); @{ ok = $true } }
  'close' { @{ ok = [W]::PostMessageW([IntPtr][long]$Rest[0], 0x10, [IntPtr]::Zero, [IntPtr]::Zero) } }
  'minimize' { @{ ok = [W]::ShowWindow([IntPtr][long]$Rest[0], 6) } }
  'move' { @{ ok = [W]::MoveWindow([IntPtr][long]$Rest[0], [int]$Rest[1], [int]$Rest[2], [int]$Rest[3], [int]$Rest[4], $true) } }
  # Windows only gives the foreground to whoever had the last input. F24: a key nothing listens to.
  # Not Alt, the usual trick: that opens the app's menu bar, and WebView2 stops answering CDP.
  'front' { $h = [IntPtr][long]$Rest[0]; [W]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [W]::keybd_event(0x87, 0, 2, [IntPtr]::Zero); @{ ok = [W]::SetForegroundWindow($h) } }
  # wisp's shortcuts, wherever a person would have one.
  'links' {
    $s = New-Object -ComObject WScript.Shell
    foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")) {
      Get-ChildItem -LiteralPath $d -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*wisp*' } | ForEach-Object { @{ path = $_.FullName; target = $s.CreateShortcut($_.FullName).TargetPath } }
    }
  }
  'pin' { $d = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"; New-Item -ItemType Directory -Force -Path $d | Out-Null; $l = (New-Object -ComObject WScript.Shell).CreateShortcut("$d\wisp.lnk"); $l.TargetPath = $Rest[0]; $l.Save(); @{ ok = $true } }
  'link-to' { $l = (New-Object -ComObject WScript.Shell).CreateShortcut($Rest[0]); $l.TargetPath = $Rest[1]; $l.Save(); @{ ok = $true } }
  'uninstall' {
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ("$($p.DisplayName)" -like '*wisp*') { @{ key = $_.PSChildName; name = $p.DisplayName; version = $p.DisplayVersion; uninstall = $p.UninstallString } }
    }
  }
  # A process and all under it.
  'tree' {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $ids = @([int]$Rest[0]); $found = @()
    for ($i = 0; $i -lt $ids.Count; $i++) { foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i] -and $ids -notcontains $p.ProcessId) { $ids += [int]$p.ProcessId; $found += @{ pid = [int]$p.ProcessId; parent = [int]$p.ParentProcessId; name = $p.Name; cmd = "$($p.CommandLine)" } } } }
    $found
  }
  'alive' { $all = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }); @($Rest | ForEach-Object { [int]$_ } | Where-Object { $all -contains $_ }) }
  'path-of' { @{ path = (Get-Process -Id ([int]$Rest[0])).Path } }
  # The toasts Windows holds for an app: Action Center's list, the same one a person opens.
  'toasts' {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $h = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($Rest[0])
    @{ texts = @(@($h) | ForEach-Object { @($_.Content.GetElementsByTagName('text') | ForEach-Object { $_.InnerText }) -join ' / ' }) }
  }
  # windows-11-arm signs in to Windows 11's first-run privacy page, full screen over every window:
  # clicks and keys go to it, and the taskbar is behind it. Seen there: explorer's Shell_OOBEProxy
  # 'Microsoft account' window with the page in WWAHost. Only Windows' own first-run hosts go, and
  # the policy keeps the page from coming back.
  'clear-desktop' {
    $k = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE'
    New-Item -Path $k -Force | Out-Null; Set-ItemProperty -Path $k -Name DisablePrivacyExperience -Value 1 -Type DWord
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $seen = @(); $closed = @()
    foreach ($h in [W]::Tops()) {
      $x = Info $h
      if (-not $x.visible -or $x.width -lt $screen.Width / 2 -or $x.height -lt $screen.Height / 2) { continue }
      $proc = Get-Process -Id $x.pid -ErrorAction SilentlyContinue
      $seen += "$($proc.Name) [$($x.cls)] '$($x.title)' $($x.width)x$($x.height)"
      # Explorer's frame for the page: hidden, not closed, it's explorer's.
      if ($x.cls -eq 'Shell_OOBEProxy') { [void][W]::ShowWindow($h, 0); $closed += "hid $($x.cls) '$($x.title)'" }
      if ($proc -and ($proc.Name -in 'WWAHost', 'CloudExperienceHostBroker', 'UserOOBEBroker' -or "$($proc.Path)" -like "$env:SystemRoot\SystemApps\*CloudExperienceHost*")) { $closed += "$($proc.Name) '$($x.title)'"; Stop-Process -Id $x.pid -Force }
    }
    foreach ($n in 'WWAHost', 'CloudExperienceHostBroker', 'UserOOBEBroker') { Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $closed += "$($_.Name) (no window)"; Stop-Process -Id $_.Id -Force } }
    @{ closed = $closed; seen = $seen; foreground = (Info ([W]::GetForegroundWindow())).title }
  }
  'theme' {
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value ([int]($Rest[0] -ne 'dark')) -Type DWord
    $out = [IntPtr]::Zero; [void][W]::SendMessageTimeoutW([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'ImmersiveColorSet', 2, 2000, [ref]$out); @{ ok = $true }
  }
  default { throw "no command $Cmd" }
}
ConvertTo-Json -InputObject @($r) -Depth 6 -Compress
