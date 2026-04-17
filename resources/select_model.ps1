param(
    [string]$TargetModel
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$root = [System.Windows.Automation.AutomationElement]::RootElement
$scope = [System.Windows.Automation.TreeScope]::Descendants

# Allow time for QuickPick to open
Start-Sleep -Milliseconds 1000

# Try exact match first
$nameCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $TargetModel)

$elements = $root.FindAll($scope, $nameCondition)
$success = $false

foreach ($elem in $elements) {
    if ($elem.Current.Name -eq $TargetModel) {
        try {
            $invokePattern = $elem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $invokePattern.Invoke()
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            $success = $true
            break
        } catch {
            try {
                $selPattern = $elem.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $selPattern.Select()
                [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
                $success = $true
                break
            } catch { }
        }
    }
}

if ($success) {
    Write-Output "SUCCESS"
    exit 0
}

# If exact match fails (e.g. due to icons or partial text in UIAutomation),
# just type the string and hit enter. Since toggleModelSelector opened the list,
# typing the text and hitting enter will select the filtered item.
# We use SendKeys directly as pasting via clipboard in powershell can be flaky
# in a non-STA context.

foreach ($char in $TargetModel.ToCharArray()) {
    # Escape special SendKeys characters if needed: +, ^, %, ~, (, ), [, ], {, }
    if ("+^%~()[]{}".Contains($char)) {
        [System.Windows.Forms.SendKeys]::SendWait("{$char}")
    } else {
        [System.Windows.Forms.SendKeys]::SendWait($char.ToString())
    }
}

Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Write-Output "SUCCESS"
