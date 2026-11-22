Option Explicit
Dim shell, fso, folder, nodePath, probe, tries, ready
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodePath) Then nodePath = "node.exe"
If Not fso.FolderExists(folder & "\node_modules\nodemailer") Then
  MsgBox "First double-click Install dependencies.cmd. Then open this launcher again.", 64, "Mail Studio setup"
  WScript.Quit
End If
On Error Resume Next
Set probe = CreateObject("MSXML2.ServerXMLHTTP.6.0")
probe.setTimeouts 1000, 1000, 1000, 1000
probe.open "GET", "http://localhost:3000/", False
probe.send
ready = False
If Err.Number = 0 Then ready = (probe.status = 200)
Err.Clear
If Not ready Then
  shell.Run Chr(34) & nodePath & Chr(34) & " --env-file-if-exists=.env " & Chr(34) & folder & "\server.js" & Chr(34), 0, False
  If Err.Number <> 0 Then
    MsgBox "Install Node.js 22 or newer from nodejs.org, then try again.", 48, "Node.js is required"
    WScript.Quit
  End If
  For tries = 1 To 20
    WScript.Sleep 500
    Err.Clear
    probe.open "GET", "http://localhost:3000/", False
    probe.send
    If Err.Number = 0 Then
      If probe.status = 200 Then
        ready = True
        Exit For
      End If
    End If
  Next
End If
If ready Then
  shell.Run "http://localhost:3000", 1, False
Else
  MsgBox "The server did not start. Check Node.js is version 22 or newer. For startup details, open this folder in a terminal and run npm start. This launcher expects the default port 3000.", 48, "Mail Studio"
End If
