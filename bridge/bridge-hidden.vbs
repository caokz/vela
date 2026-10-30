' Vela agent bridge hidden launcher (called at logon).
' Output goes to bridge-autostart.log for troubleshooting.
' Paths derived from this script's location (no hardcoded drive letters).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c ""node index.js > bridge-autostart.log 2>&1""", 0, False
