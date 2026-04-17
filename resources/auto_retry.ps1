# auto_retry.ps1 — Detect and handle Antigravity error/warning dialogs
# Uses Windows UI Automation to find error notifications and click action buttons.
#
# Stdout results:
#   RETRY_CLICKED          — Successfully clicked Retry on Agent error
#   QUOTA_REACHED|<detail> — Model quota reached dialog detected (with detail text)
#   QUOTA_DISMISSED        — Model quota dialog dismissed
#   NO_ERROR               — No error dialog detected
#   RETRY_NOT_FOUND        — Error text found but Retry button not located
#   INVOKE_FAILED          — Found button but click failed

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root  = [System.Windows.Automation.AutomationElement]::RootElement
$scope = [System.Windows.Automation.TreeScope]::Descendants
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# ── Helper: find a named button in ancestor containers ─────────────────────
function Find-ButtonInAncestors($startElement, $buttonName) {
    $btnCondition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $buttonName)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button))
    )

    $current = $walker.GetParent($startElement)
    for ($i = 0; $i -lt 10; $i++) {
        if (-not $current) { break }
        try {
            $btn = $current.FindFirst($scope, $btnCondition)
        } catch { }
        if ($btn) { return $btn }
        $current = $walker.GetParent($current)
    }
    return $null
}

# ── Helper: click a button via InvokePattern ───────────────────────────────
function Invoke-Button($button) {
    try {
        $invokePattern = $button.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern)
        $invokePattern.Invoke()
        return $true
    } catch {
        return $false
    }
}

# ── 1. Check for "Model quota reached" dialog ─────────────────────────────

$quotaCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "Model quota reached"
)

try {
    $quotaElement = $root.FindFirst($scope, $quotaCondition)
} catch {
    $quotaElement = $null
}

if ($quotaElement) {
    # Try to extract the detail text (refresh date) from a sibling/child
    $detailText = ""
    try {
        $parent = $walker.GetParent($quotaElement)
        if ($parent) {
            $textCondition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Text)
            $textElements = $parent.FindAll($scope, $textCondition)
            foreach ($te in $textElements) {
                $name = $te.Current.Name
                if ($name -and $name -ne "Model quota reached" -and $name.Length -gt 5) {
                    $detailText = $name
                    break
                }
            }
        }
    } catch { }

    # Try to click Dismiss button to clear the dialog
    $dismissBtn = Find-ButtonInAncestors $quotaElement "Dismiss"
    if ($dismissBtn) {
        $clicked = Invoke-Button $dismissBtn
        if ($clicked) {
            Write-Output "QUOTA_DISMISSED|$detailText"
            exit 0
        }
    }

    # Even if we can't dismiss, report the quota error
    Write-Output "QUOTA_REACHED|$detailText"
    exit 0
}

# ── 2. Check for "Agent terminated due to error" ──────────────────────────

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

# ── 3. Find and click the Retry button ────────────────────────────────────

$retryButton = Find-ButtonInAncestors $errorElement "Retry"

if ($retryButton) {
    $clicked = Invoke-Button $retryButton
    if ($clicked) {
        Write-Output "RETRY_CLICKED"
    } else {
        Write-Output "INVOKE_FAILED"
    }
} else {
    Write-Output "RETRY_NOT_FOUND"
}
