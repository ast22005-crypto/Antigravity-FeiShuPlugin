param(
    [string]$ExecPath,
    [string]$WorkspacePath
)

# Wait for 2 seconds to allow Feishu messages to be sent and extension to initiate shutdown
Start-Sleep -Seconds 2

# Extract process name from the executable path
$processName = (Get-Item $ExecPath).BaseName

# Forcefully terminate all processes matching the executable name
Write-Host "Force killing all processes named: $processName"
Stop-Process -Name $processName -Force -ErrorAction SilentlyContinue

# Additional brief sleep to ensure OS fully releases resources
Start-Sleep -Seconds 1

# Restart the application with the workspace path
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
    Start-Process -FilePath $ExecPath
} else {
    Start-Process -FilePath $ExecPath -ArgumentList "`"$WorkspacePath`""
}
