# Windows Firewall's "allow this app?" prompt on every new `go test` binary, off for a bench run and on after.
# Run elevated: sudo pwsh -NoProfile -File bench/firewall.ps1 off|on. sudo loses the output, so it goes to a file.
param([ValidateSet('on', 'off')][string]$State)
Set-NetFirewallProfile -All -NotifyOnListen ($State -eq 'on')
Get-NetFirewallProfile | Select-Object Name, NotifyOnListen | Format-Table -AutoSize | Out-String | Set-Content (Join-Path $env:TEMP 'yapbench-firewall.txt')
