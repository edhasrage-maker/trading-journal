' Hidden launcher for the public bar feed — runs the same command as the
' "Refresh NQ ES Data" task but with NO visible console window (the 0 in Run()).
' Point the scheduled task's action at this file:
'   Program/script:  wscript.exe
'   Add arguments:   "<repo>\scripts\run-feed-hidden.vbs"
' Derives the repo root from this script's own location, so it works regardless
' of where the repo lives on each machine.
Dim fso, sh, repoDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
' scripts\ -> repo root
repoDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = repoDir
' 0 = hidden window, False = don't wait for it to finish.
sh.Run "cmd /c npx tsx scripts\public-bar-feed.ts", 0, False
