Option Explicit

If WScript.Arguments.Count < 1 Then WScript.Quit 64

Dim shell, command, index
Set shell = CreateObject("WScript.Shell")
command = QuoteArg(WScript.Arguments(0))
For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & QuoteArg(WScript.Arguments(index))
Next

shell.Run command, 0, False
WScript.Quit 0

Function QuoteArg(value)
  QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
