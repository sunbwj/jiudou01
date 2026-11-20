' ============================================================================
'  tools\_run_hidden.vbs -- run a command in the background with NO console
'  ---------------------------------------------------------------------------
'  usage: wscript //nologo "tools\_run_hidden.vbs" "<full command line>"
'  . WindowStyle=0 hides the window, bWaitOnReturn=False returns at once;
'  . the spawned process owns its own hidden console, so it keeps running
'    after the launcher (and the visible window) exits.
' ============================================================================
Option Explicit

Dim args, cmd, sh

Set args = WScript.Arguments
If args.Count < 1 Then
    WScript.Quit 1
End If

cmd = args(0)

Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 0, False
