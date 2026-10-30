' Entry point for the vela-bridge:// URL protocol.
' Starts node index.js in a hidden window; output appends to bridge-protocol.log.
' If the port is already in use, node exits by itself (idempotent, safe to retrigger).
' ASCII only: wscript parses .vbs as ANSI, non-ASCII comments break the syntax.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
bridgeDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = bridgeDir
sh.Run "cmd /c ""node index.js >> bridge-protocol.log 2>&1""", 0, False
