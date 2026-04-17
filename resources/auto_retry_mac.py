#!/usr/bin/env python3
"""
auto_retry_mac.py — Detect and handle Antigravity error/warning dialogs on macOS
Uses native macOS Accessibility API via ctypes (no extra packages needed).

Prerequisites:
  - macOS Accessibility permission must be granted to the terminal/app
    via System Settings → Privacy & Security → Accessibility

Stdout results (same format as auto_retry.ps1):
  RETRY_CLICKED          — Successfully clicked Retry/Continue on Agent error
  QUOTA_REACHED|<detail> — Model quota reached dialog detected
  QUOTA_DISMISSED        — Model quota dialog dismissed
  NO_ERROR               — No error dialog detected
  RETRY_NOT_FOUND        — Error text found but Retry button not located
  INVOKE_FAILED          — Found button but click failed
"""

import ctypes
import ctypes.util
import subprocess

# ── Load frameworks ────────────────────────────────────────────────────────

cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
ax = ctypes.cdll.LoadLibrary(ctypes.util.find_library("ApplicationServices"))

# ── Types ──────────────────────────────────────────────────────────────────

CFTypeRef = ctypes.c_void_p
CFStringRef = ctypes.c_void_p
CFIndex = ctypes.c_long
pid_t = ctypes.c_int32
AXError = ctypes.c_int32

kCFStringEncodingUTF8 = 0x08000100

# ── Function signatures ───────────────────────────────────────────────────

cf.CFRelease.argtypes = [CFTypeRef]; cf.CFRelease.restype = None
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]; cf.CFArrayGetCount.restype = CFIndex
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, CFIndex]; cf.CFArrayGetValueAtIndex.restype = CFTypeRef
cf.CFStringCreateWithCString.argtypes = [CFTypeRef, ctypes.c_char_p, ctypes.c_uint32]; cf.CFStringCreateWithCString.restype = CFStringRef
cf.CFStringGetCStringPtr.argtypes = [CFStringRef, ctypes.c_uint32]; cf.CFStringGetCStringPtr.restype = ctypes.c_char_p
cf.CFStringGetCString.argtypes = [CFStringRef, ctypes.c_char_p, CFIndex, ctypes.c_uint32]; cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFGetTypeID.argtypes = [CFTypeRef]; cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFStringGetTypeID.argtypes = []; cf.CFStringGetTypeID.restype = ctypes.c_ulong

ax.AXUIElementCreateApplication.argtypes = [pid_t]; ax.AXUIElementCreateApplication.restype = CFTypeRef
ax.AXUIElementCopyAttributeValue.argtypes = [CFTypeRef, CFStringRef, ctypes.POINTER(CFTypeRef)]; ax.AXUIElementCopyAttributeValue.restype = AXError
ax.AXUIElementSetAttributeValue.argtypes = [CFTypeRef, CFStringRef, CFTypeRef]; ax.AXUIElementSetAttributeValue.restype = AXError
ax.AXUIElementPerformAction.argtypes = [CFTypeRef, CFStringRef]; ax.AXUIElementPerformAction.restype = AXError

kCFBooleanTrue = CFTypeRef.in_dll(cf, "kCFBooleanTrue")


# ── Helpers ────────────────────────────────────────────────────────────────

def cfstr(s):
    return cf.CFStringCreateWithCString(None, s.encode("utf-8"), kCFStringEncodingUTF8)

def pystr(cfs):
    if not cfs:
        return ""
    p = cf.CFStringGetCStringPtr(cfs, kCFStringEncodingUTF8)
    if p:
        return p.decode("utf-8")
    b = ctypes.create_string_buffer(4096)
    if cf.CFStringGetCString(cfs, b, 4096, kCFStringEncodingUTF8):
        return b.value.decode("utf-8")
    return ""

def get_str(elem, attr_name):
    a = cfstr(attr_name)
    v = CFTypeRef()
    err = ax.AXUIElementCopyAttributeValue(elem, a, ctypes.byref(v))
    cf.CFRelease(a)
    if err != 0 or not v.value:
        return ""
    try:
        if cf.CFGetTypeID(v) == cf.CFStringGetTypeID():
            r = pystr(v)
            cf.CFRelease(v)
            return r
    except Exception:
        pass
    try:
        cf.CFRelease(v)
    except Exception:
        pass
    return ""

def get_children(elem):
    a = cfstr("AXChildren")
    v = CFTypeRef()
    err = ax.AXUIElementCopyAttributeValue(elem, a, ctypes.byref(v))
    cf.CFRelease(a)
    if err != 0 or not v.value:
        return []
    count = cf.CFArrayGetCount(v)
    return [cf.CFArrayGetValueAtIndex(v, i) for i in range(count)]

def has_press_action(elem):
    """Check if an element supports the AXPress action."""
    a = cfstr("AXActionNames")
    v = CFTypeRef()
    err = ax.AXUIElementCopyAttributeValue(elem, a, ctypes.byref(v))
    cf.CFRelease(a)
    if err != 0 or not v.value:
        return False
    count = cf.CFArrayGetCount(v)
    for i in range(count):
        action = cf.CFArrayGetValueAtIndex(v, i)
        if action and cf.CFGetTypeID(action) == cf.CFStringGetTypeID():
            if pystr(action) == "AXPress":
                return True
    return False

def press(elem):
    a = cfstr("AXPress")
    err = ax.AXUIElementPerformAction(elem, a)
    cf.CFRelease(a)
    return err == 0

def enable_accessibility(app_ref):
    """Enable Electron's web accessibility tree via AXManualAccessibility."""
    a = cfstr("AXManualAccessibility")
    ax.AXUIElementSetAttributeValue(app_ref, a, kCFBooleanTrue)
    cf.CFRelease(a)

def get_all_text_in_subtree(elem, depth=0, max_depth=3):
    """Get concatenated text content of an element's descendants."""
    texts = []
    val = get_str(elem, "AXValue")
    title = get_str(elem, "AXTitle")
    if val:
        texts.append(val)
    if title:
        texts.append(title)
    if depth < max_depth:
        for child in get_children(elem):
            if child:
                texts.extend(get_all_text_in_subtree(child, depth + 1, max_depth))
    return texts


# ── Tree search ────────────────────────────────────────────────────────────

def search_tree(elem, depth=0, max_depth=20):
    """
    Recursively search the accessibility tree.
    
    Strategy:
    1. Find notification-style errors ("Agent terminated due to error" + "Retry" button)
    2. Find quota dialogs ("Model quota reached" + "Dismiss" button)
    3. Find inline chat errors: a container that has BOTH "Error" text AND
       a clickable "Continue"/"Retry" child — to avoid false positives from
       conversation text, we look for containers where these appear together
       and the action element is actually clickable.
    
    Returns a list of (type, element, text) tuples.
    """
    results = []
    if depth > max_depth:
        return results

    role = get_str(elem, "AXRole")
    title = get_str(elem, "AXTitle")
    desc = get_str(elem, "AXDescription")
    value = get_str(elem, "AXValue")

    combined = f"{title}|{desc}|{value}".lower()

    # ── 1. Notification-style errors ───────────────────────────────────
    if "agent terminated due to error" in combined:
        results.append(("ERROR_NOTIFICATION", elem, f"{title}{desc}{value}"))

    # ── 2. Quota errors ───────────────────────────────────────────────
    if "model quota reached" in combined or "baseline model quota reached" in combined:
        results.append(("QUOTA", elem, f"{title}{desc}{value}"))

    # ── 3. Clickable buttons (AXButton with known names) ──────────────
    if role == "AXButton":
        btn_text = (title or desc or value or "").strip()
        btn_lower = btn_text.lower()
        if btn_lower in ("retry", "continue", "dismiss", "ok", "close"):
            results.append(("BUTTON", elem, btn_text))

    # ── 4. Clickable non-button elements ──────────────────────────────
    # In Electron, interactive text/links/groups may support AXPress
    if role in ("AXLink", "AXStaticText", "AXGroup", "AXMenuItem"):
        elem_text = (title or desc or value or "").strip()
        if elem_text.lower() in ("retry", "continue", "dismiss", "ok", "close"):
            if has_press_action(elem):
                results.append(("BUTTON", elem, elem_text))

    # ── 5. Check if this is an error container with clickable child ───
    # Look for groups that contain both "Error" text and a pressable element
    if role in ("AXGroup", "AXGenericContainer"):
        subtree_texts = get_all_text_in_subtree(elem, max_depth=2)
        text_lower = " ".join(subtree_texts).lower()
        # Must contain specific error indicators (not just the word "error")
        is_error_container = (
            ("error" in text_lower and "try again" in text_lower) or
            ("error" in text_lower and "continue" in text_lower and "high traffic" in text_lower) or
            ("error" in text_lower and "failed" in text_lower)
        )
        if is_error_container:
            # Find clickable children in this container
            for child in get_children(elem):
                if child:
                    child_text = (get_str(child, "AXTitle") or get_str(child, "AXValue") or "").strip()
                    if child_text.lower() in ("continue", "retry"):
                        if has_press_action(child):
                            results.append(("RETRY_CANDIDATE", child, child_text))

    # Recurse into children
    for child in get_children(elem):
        if child:
            results.extend(search_tree(child, depth + 1, max_depth))

    return results


# ── Main ───────────────────────────────────────────────────────────────────

def find_antigravity_pid():
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,args"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.strip().split("\n"):
            if "Antigravity.app/Contents/MacOS/Electron" in line \
               and "Helper" not in line \
               and "grep" not in line:
                return int(line.strip().split()[0])
    except Exception:
        pass
    return None


def main():
    pid = find_antigravity_pid()
    if not pid:
        print("NO_ERROR")
        return

    app_ref = ax.AXUIElementCreateApplication(pid)
    if not app_ref:
        print("NO_ERROR")
        return

    # Enable Electron's web accessibility tree
    enable_accessibility(app_ref)

    # Get windows
    wa = cfstr("AXWindows")
    wv = CFTypeRef()
    err = ax.AXUIElementCopyAttributeValue(app_ref, wa, ctypes.byref(wv))
    cf.CFRelease(wa)

    if err != 0 or not wv.value:
        print("NO_ERROR")
        return

    window_count = cf.CFArrayGetCount(wv)
    all_results = []

    for i in range(window_count):
        win = cf.CFArrayGetValueAtIndex(wv, i)
        if win:
            all_results.extend(search_tree(win))

    # Classify findings
    has_notification_error = any(r[0] == "ERROR_NOTIFICATION" for r in all_results)
    has_quota = any(r[0] == "QUOTA" for r in all_results)
    retry_candidates = [(r[1], r[2]) for r in all_results if r[0] == "RETRY_CANDIDATE"]
    buttons = {r[2]: r[1] for r in all_results if r[0] == "BUTTON"}

    # ── 1. Handle quota ────────────────────────────────────────────────
    quota_not_found = False
    if has_quota:
        detail = next((r[2] for r in all_results if r[0] == "QUOTA"), "")
        for name in ("Dismiss", "dismiss", "OK", "Close"):
            if name in buttons:
                if press(buttons[name]):
                    print(f"QUOTA_DISMISSED|{detail}")
                    return
        quota_not_found = f"QUOTA_NOT_FOUND|{detail}"

    # ── 2. Handle notification error ───────────────────────────────────
    if has_notification_error:
        for name in ("Retry", "retry"):
            if name in buttons:
                if press(buttons[name]):
                    print("RETRY_CLICKED")
                else:
                    print("INVOKE_FAILED")
                return
        print("RETRY_NOT_FOUND")
        return

    # ── 3. Handle inline error with clickable Continue/Retry ──────────
    if retry_candidates:
        elem, text = retry_candidates[-1]  # Use the LAST one (most recent)
        if press(elem):
            print("RETRY_CLICKED")
        else:
            print("INVOKE_FAILED")
        return

    # ── 4. Handle standalone Retry/Continue buttons ────────────────────
    # Only if there's a Retry button visible (from notification we might have missed)
    for name in ("Retry", "retry"):
        if name in buttons:
            if press(buttons[name]):
                print("RETRY_CLICKED")
            else:
                print("INVOKE_FAILED")
            return

    if quota_not_found:
        print(quota_not_found)
        return

    print("NO_ERROR")


if __name__ == "__main__":
    main()
