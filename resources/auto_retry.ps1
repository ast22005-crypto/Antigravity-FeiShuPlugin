# auto_retry.ps1 — Detect and auto-click "Retry" on Antigravity error dialogs
# Uses Windows UI Automation to find the error notification and click the Retry button.
#
# Stdout results:
#   RETRY_CLICKED   — Successfully clicked Retry
#   NO_ERROR        — No error dialog detected
#   RETRY_NOT_FOUND — Error text found but Retry button not located
#   INVOKE_FAILED   — Found Retry button but click failed

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root  = [System.Windows.Automation.AutomationElement]::RootElement
$scope = [System.Windows.Automation.TreeScope]::Descendants

# ── 1. Search for the error text directly from root ───────────────────────
# This is simpler and more reliable than trying to find the window first.

$errorCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "Agent terminated due to error"
)

try {
    $errorElement = $root.FindFirst($scope, $errorCondition)
} catch {
    Write-Output "NO_ERROR"
    exit 0
}

if (-not $errorElement) {
    Write-Output "NO_ERROR"
    exit 0
}

# ── 2. Find the Retry button ─────────────────────────────────────────────
# Walk up the tree from the error text and search for a "Retry" button
# in each ancestor container.

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$buttonCondition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, "Retry")),
    (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button))
)

$retryButton = $null
$current     = $walker.GetParent($errorElement)

for ($i = 0; $i -lt 10; $i++) {
    if (-not $current) { break }
    try {
        $retryButton = $current.FindFirst($scope, $buttonCondition)
    } catch {
        # ignore traversal errors
    }
    if ($retryButton) { break }
    $current = $walker.GetParent($current)
}

# ── 3. Click the Retry button ────────────────────────────────────────────
if ($retryButton) {
    try {
        $invokePattern = $retryButton.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern)
        $invokePattern.Invoke()
        Write-Output "RETRY_CLICKED"
    } catch {
        Write-Output "INVOKE_FAILED"
    }
} else {
    Write-Output "RETRY_NOT_FOUND"
}
